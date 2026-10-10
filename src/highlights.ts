import * as vscode from 'vscode';
import { Reviews } from './reviews';
import { TextAnchor, Thread } from './core/model';
import { containsPosition, groupHighlights, selectActiveHighlight, HighlightInput } from './core/highlights';

const SOURCE_SCHEMES = new Set(['file', 'vscode-remote']);
const HOVER_BODY_LIMIT = 300;

interface Entry {
  input: HighlightInput;
  /** Character range outlined in the editor. */
  range: vscode.Range;
  /** Full lines covered by the thread, clamped to the document. */
  lines: vscode.Range;
  hover: vscode.MarkdownString;
}

interface EditorState {
  items: HighlightInput[];
  entries: Map<string, Entry>;
  /** The text changed after these ranges were computed; the editor tracks them until Reviews refreshes. */
  dirty: boolean;
  signature?: string;
  groupSignatures?: Partial<Record<Kind, string>>;
}

type Kind = 'open' | 'resolved' | 'stale' | 'activeLine' | 'active';

function color(id: string): vscode.ThemeColor { return new vscode.ThemeColor(`reviewComments.${id}`); }

function isSource(editor: vscode.TextEditor): boolean { return SOURCE_SCHEMES.has(editor.document.uri.scheme); }

function position(value: vscode.Position): { line: number; character: number } {
  return { line: value.line, character: value.character };
}

function truncate(text: string, limit: number): string {
  const characters = Array.from(text.trim());
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : characters.join('');
}

function hover(data: Thread, stale: boolean): vscode.MarkdownString {
  // Plain text only: an untrusted string cannot run commands or render links as actions.
  const message = new vscode.MarkdownString();
  const first = data.comments[0];
  const count = data.comments.length;
  message.appendText(`Review comment · ${data.status}\n`);
  if (first) { message.appendText(`${first.author}: ${truncate(first.body, HOVER_BODY_LIMIT)}\n`); }
  message.appendText(`(${count} comment${count === 1 ? '' : 's'})`);
  if (stale) { message.appendText('\nLocation unverified — check the current source. The saved excerpt is kept in the thread.'); }
  return message;
}

function entry(document: vscode.TextDocument, key: string, data: Thread, anchor: TextAnchor): Entry {
  const { start, end } = anchor.range;
  const stored = document.validateRange(new vscode.Range(start.line, start.character, end.line, end.character));
  const firstLine = stored.start.line;
  // A selection of whole lines ends at column 0 of the next line; that line is not part of it.
  const lastLine = stored.end.line > firstLine && stored.end.character === 0 ? stored.end.line - 1 : stored.end.line;
  const lines = new vscode.Range(firstLine, 0, lastLine, document.lineAt(lastLine).text.length);
  // Stale text may no longer match the stored excerpt, so mark whole lines instead of characters.
  const range = anchor.stale ? lines : stored.isEmpty ? document.lineAt(firstLine).range : stored;
  const matchRange = anchor.stale ? lines : stored;
  return {
    input: {
      key,
      status: data.status,
      stale: anchor.stale,
      range: { start: position(matchRange.start), end: position(matchRange.end) }
    },
    range,
    lines,
    hover: hover(data, anchor.stale)
  };
}

/** Outlines commented text in visible editors and marks the overview ruler. */
export class ReviewHighlights implements vscode.Disposable {
  private readonly types: Record<Kind, vscode.TextEditorDecorationType>;
  private readonly states = new Map<vscode.TextEditor, EditorState>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private enabled = true;
  private showResolved = true;
  /** Selected from the sidebar or navigation; wins until the user moves the cursor away from it. */
  private explicit: string | undefined;
  /** The most recently focused, still visible source editor; only its cursor selects a thread. */
  private cursorEditor: vscode.TextEditor | undefined;
  /** A user cursor move arrived while ranges were outdated; check it after the next refresh. */
  private pendingCheck = false;
  private disposed = false;

  constructor(private readonly reviews: Reviews) {
    const right = vscode.OverviewRulerLane.Right;
    const closed = vscode.DecorationRangeBehavior.ClosedClosed;
    // The active thread is never also drawn by the open, resolved, or stale types.
    this.types = {
      open: vscode.window.createTextEditorDecorationType({
        backgroundColor: color('openBackground'), border: '1px solid', borderColor: color('openBorder'), borderRadius: '2px',
        overviewRulerColor: color('overviewRuler.open'), overviewRulerLane: right, rangeBehavior: closed
      }),
      resolved: vscode.window.createTextEditorDecorationType({
        border: '1px dashed', borderColor: color('resolvedBorder'), borderRadius: '2px',
        overviewRulerColor: color('overviewRuler.resolved'), overviewRulerLane: right, rangeBehavior: closed
      }),
      stale: vscode.window.createTextEditorDecorationType({
        isWholeLine: true, border: '1px dotted', borderColor: color('staleBorder'),
        overviewRulerColor: color('overviewRuler.stale'), overviewRulerLane: right
      }),
      activeLine: vscode.window.createTextEditorDecorationType({
        isWholeLine: true, backgroundColor: color('activeLineBackground')
      }),
      active: vscode.window.createTextEditorDecorationType({
        backgroundColor: color('activeBackground'), border: '2px solid', borderColor: color('activeBorder'), borderRadius: '2px',
        overviewRulerColor: color('overviewRuler.active'), overviewRulerLane: vscode.OverviewRulerLane.Full, rangeBehavior: closed
      })
    };
    this.readSettings();
    const active = vscode.window.activeTextEditor;
    this.cursorEditor = active && isSource(active) ? active : undefined;
    this.subscriptions.push(
      reviews.onDidChange(() => this.guard(() => this.refresh())),
      vscode.window.onDidChangeVisibleTextEditors(() => this.guard(() => this.visibleChanged())),
      vscode.window.onDidChangeActiveTextEditor(editor => this.guard(() => this.activeChanged(editor))),
      vscode.window.onDidChangeTextEditorSelection(event => this.guard(() => this.selectionChanged(event))),
      vscode.workspace.onDidChangeTextDocument(event => this.guard(() => this.documentChanged(event))),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('reviewComments')) { this.guard(() => this.configurationChanged()); }
      })
    );
    this.guard(() => this.refresh());
  }

  /** Mark a thread as the current one, or return to cursor-based selection with undefined. */
  setActive(key: string | undefined): void {
    if (this.disposed) { return; }
    let scoped = key;
    if (key !== undefined) {
      try {
        const ref = this.reviews.find(key);
        if (ref) { scoped = this.reviews.key(ref); }
      } catch { /* Keep the given key; an unknown key simply selects nothing. */ }
    }
    this.pendingCheck = false;
    if (scoped === this.explicit) { return; }
    this.explicit = scoped;
    this.guard(() => this.renderAll());
  }

  private guard(action: () => void): void {
    if (this.disposed) { return; }
    try { action(); } catch (error) {
      try { this.reviews.output.appendLine(`Review highlights: ${error instanceof Error ? error.message : String(error)}`); }
      catch { /* The output channel may already be closed during shutdown. */ }
    }
  }

  private readSettings(): void {
    const configuration = vscode.workspace.getConfiguration('reviewComments');
    this.enabled = configuration.get<boolean>('highlights', true) !== false;
    this.showResolved = configuration.get<boolean>('highlightResolved', true) !== false;
  }

  private exists(key: string): boolean {
    try { return this.reviews.find(key) !== undefined; } catch { return false; }
  }

  private refresh(): void {
    this.states.clear();
    if (!this.enabled) { this.clear(); return; }
    if (this.explicit !== undefined && !this.exists(this.explicit)) { this.explicit = undefined; }
    this.pruneCursorEditor();
    this.renderAll(true);
    if (this.pendingCheck) {
      this.pendingCheck = false;
      const editor = this.cursorEditor;
      if (editor && this.explicit !== undefined && !this.holds(editor, this.explicit)) {
        this.explicit = undefined;
        this.renderAll();
      }
    }
  }

  private visibleChanged(): void {
    const visible = new Set(vscode.window.visibleTextEditors);
    for (const editor of [...this.states.keys()]) {
      if (!visible.has(editor)) { this.states.delete(editor); }
    }
    this.pruneCursorEditor();
    this.renderAll();
  }

  private activeChanged(editor: vscode.TextEditor | undefined): void {
    // Focusing a comment input, the review panel, or another view keeps the source cursor that opened it.
    if (editor && isSource(editor)) { this.cursorEditor = editor; }
    this.pruneCursorEditor();
    this.renderAll();
  }

  private selectionChanged(event: vscode.TextEditorSelectionChangeEvent): void {
    const editor = event.textEditor;
    if (!isSource(editor)) { return; }
    if (editor === vscode.window.activeTextEditor) { this.cursorEditor = editor; }
    // Other editors show no cursor-selected thread, so their selection is irrelevant.
    if (!this.enabled || editor !== this.cursorEditor) { return; }
    const kind = event.kind;
    const byUser = kind === vscode.TextEditorSelectionChangeKind.Keyboard || kind === vscode.TextEditorSelectionChangeKind.Mouse;
    if (this.states.get(editor)?.dirty) {
      // Typing: the editor already shifts existing decorations; wait for relocated ranges.
      if (byUser && this.explicit !== undefined) { this.pendingCheck = true; }
      return;
    }
    if (byUser && this.explicit !== undefined && !this.holds(editor, this.explicit)) {
      this.explicit = undefined;
      this.pendingCheck = false;
    }
    this.renderAll();
  }

  private documentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (!event.contentChanges.length) { return; }
    const target = event.document.uri.toString();
    for (const [editor, state] of this.states) {
      if (state.items.length && editor.document.uri.toString() === target) { state.dirty = true; }
    }
  }

  private configurationChanged(): void {
    this.readSettings();
    this.refresh();
  }

  private pruneCursorEditor(): void {
    if (this.cursorEditor && vscode.window.visibleTextEditors.includes(this.cursorEditor)) { return; }
    const active = vscode.window.activeTextEditor;
    this.cursorEditor = active && isSource(active) ? active : undefined;
  }

  /** Whether the editor's primary cursor lies within the given thread in that editor. */
  private holds(editor: vscode.TextEditor, key: string): boolean {
    const found = this.ensure(editor).entries.get(key);
    return found !== undefined && containsPosition(found.input.range, position(editor.selection.active));
  }

  private ensure(editor: vscode.TextEditor): EditorState {
    const existing = this.states.get(editor);
    if (existing && !existing.dirty) { return existing; }
    const state = this.compute(editor.document);
    this.states.set(editor, state);
    return state;
  }

  private compute(document: vscode.TextDocument): EditorState {
    const target = document.uri.toString();
    const entries = new Map<string, Entry>();
    for (const ref of this.reviews.all()) {
      try {
        if (ref.data.anchor.kind !== 'text' || this.reviews.uri(ref).toString() !== target) { continue; }
        const data = this.reviews.view(ref);
        if (data.anchor.kind !== 'text') { continue; }
        const key = this.reviews.key(ref);
        entries.set(key, entry(document, key, data, data.anchor));
      } catch { /* A thread removed or rewritten meanwhile is skipped until the next change. */ }
    }
    return { items: [...entries.values()].map(item => item.input), entries, dirty: false };
  }

  private renderAll(force = false): void {
    if (!this.enabled) { return; }
    const editors = vscode.window.visibleTextEditors.filter(isSource);
    const states = editors.map(editor => [editor, this.ensure(editor)] as const);
    const explicit = this.explicit;
    // While the selected thread is on screen it is the only active one.
    const explicitShown = explicit !== undefined && states.some(([, state]) => state.entries.has(explicit));
    for (const [editor, state] of states) { this.render(editor, state, explicitShown, force); }
  }

  private render(editor: vscode.TextEditor, state: EditorState, explicitShown: boolean, force: boolean): void {
    const cursor = !explicitShown && editor === this.cursorEditor ? position(editor.selection.active) : undefined;
    const options = { activeKey: explicitShown ? this.explicit : undefined, cursor, showResolved: this.showResolved };
    const selected = selectActiveHighlight(state.items, options);
    // Within one cached source generation, only the active key can change on cursor movement.
    const signature = JSON.stringify([selected?.key ?? null, this.showResolved]);
    if (!force && state.signature === signature) { return; }
    state.signature = signature;
    const groups = groupHighlights(state.items, options);
    const option = (item: HighlightInput, whole: boolean): vscode.DecorationOptions => {
      const found = state.entries.get(item.key)!;
      return { range: whole ? found.lines : found.range, hoverMessage: found.hover };
    };
    const active = groups.active && state.entries.get(groups.active.key);
    state.groupSignatures ??= {};
    const apply = (kind: Kind, items: readonly HighlightInput[], whole = false): void => {
      const keys = JSON.stringify(items.map(item => item.key));
      if (!force && state.groupSignatures![kind] === keys) { return; }
      state.groupSignatures![kind] = keys;
      editor.setDecorations(this.types[kind], items.map(item => option(item, whole)));
    };
    apply('open', groups.open);
    apply('resolved', groups.resolved);
    apply('stale', groups.stale, true);
    editor.setDecorations(this.types.activeLine, active ? [{ range: active.lines }] : []);
    editor.setDecorations(this.types.active, active ? [{ range: active.range, hoverMessage: active.hover }] : []);
  }

  private clear(): void {
    const editors = new Set([...vscode.window.visibleTextEditors, ...this.states.keys()]);
    for (const editor of editors) {
      for (const type of Object.values(this.types)) { editor.setDecorations(type, []); }
    }
    this.states.clear();
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    // Disposing a decoration type removes it from every editor.
    for (const type of Object.values(this.types)) { type.dispose(); }
    this.states.clear();
  }
}
