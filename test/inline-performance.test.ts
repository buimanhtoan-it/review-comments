import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type * as vscode from 'vscode';
import type { InlineReviews } from '../src/inline';
import type { Reviews } from '../src/reviews';
import type { Thread } from '../src/core/model';

// Run the actual inline implementation with observable native setters. Counts, not
// wall-clock thresholds, make these tests repeatable without an extension host.
const source = readFileSync(path.resolve(__dirname, __filename.endsWith('.ts') ? '../src/inline.ts' : '../../src/inline.ts'), 'utf8');
const inlineScript = transpileModule(source, {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
}).outputText;
const Preview = 0, Editing = 1, Collapsed = 0, Expanded = 1;
type NativeComment = Parameters<InlineReviews['edit']>[0] & vscode.Comment;
type Operation = { kind: 'create' | 'dispose' | 'set' | 'compose'; thread: NativeThread; property?: string };
class Emitter<T> {
  readonly listeners = new Set<(event: T) => void>();
  readonly event = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(event: T): void { for (const listener of [...this.listeners]) { listener(event); } }
}
class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
  isEqual(other: Range): boolean {
    return this.start.line === other.start.line && this.start.character === other.start.character
      && this.end.line === other.end.line && this.end.character === other.end.character;
  }
}
class Selection extends Range {
  constructor(start: Range['start'], end: Range['end']) { super(start.line, start.character, end.line, end.character); }
}
const uri = (resource: string) => {
  const scheme = resource.slice(0, resource.indexOf(':'));
  const pathname = resource.slice(resource.indexOf('://') + 3).replace(/^[^/]*(?=\/)/, '');
  return { scheme, path: pathname, fsPath: pathname, toString: () => resource } as vscode.Uri;
};
const document = (resource: string, isUntitled = false) => ({
  uri: uri(resource), isUntitled, lineCount: 10000,
  validateRange: (range: Range) => range,
  lineAt: () => ({ text: 'Source text' })
}) as unknown as vscode.TextDocument;
const editor = (doc: vscode.TextDocument, line = 0) => ({
  document: doc, selection: new Selection({ line, character: 0 }, { line, character: 5 }),
  revealRange() {}
}) as unknown as vscode.TextEditor;
interface Ref { root: string; data: Thread }
function ref(resource: string, index: number, root = 'file:///workspace'): Ref {
  const timestamp = '2026-10-06T08:00:00.000Z';
  return { root, data: {
    schemaVersion: 1, kind: 'review-thread', id: `thread-${index}`, revision: 0,
    resource: { path: resource }, status: 'open',
    anchor: { kind: 'text', range: { start: { line: index, character: 0 }, end: { line: index, character: 5 } },
      snapshot: 'Source text', before: '', after: '', stale: false },
    comments: [{ id: `comment-${index}`, body: `Comment ${index}`, author: 'Reviewer', createdAt: timestamp, updatedAt: timestamp }],
    createdAt: timestamp, updatedAt: timestamp, tags: [], metadata: {}
  } };
}
class NativeThread {
  declare range: vscode.Range;
  declare comments: readonly NativeComment[];
  declare contextValue: string | undefined;
  declare label: string | undefined;
  declare state: number | undefined;
  declare canReply: boolean;
  declare collapsibleState: number;
  // Deliberately not exposed through vscode: stand in for an opaque native reply.
  replyDraft = '';
  disposed = false;
  constructor(readonly uri: vscode.Uri, range: vscode.Range, comments: readonly NativeComment[], private readonly operations: Operation[]) {
    const values: Record<string, unknown> = { range, comments, canReply: true, collapsibleState: Collapsed };
    for (const property of ['range', 'comments', 'contextValue', 'label', 'state', 'canReply', 'collapsibleState']) {
      Object.defineProperty(this, property, {
        get: () => values[property],
        set: value => { values[property] = value; operations.push({ kind: 'set', thread: this, property }); }
      });
    }
  }
  dispose(): void {
    this.disposed = true;
    this.replyDraft = '';
    this.operations.push({ kind: 'dispose', thread: this });
  }
}
function harness(refs: Ref[] = [ref('paper.tex', 0)], initialDocuments = [document('file:///workspace/paper.tex')]) {
  const operations: Operation[] = [];
  const native: NativeThread[] = [];
  const changed = new Emitter<void>();
  const opened = new Emitter<vscode.TextDocument>();
  const visible = new Emitter<readonly vscode.TextEditor[]>();
  const selection = new Emitter<vscode.TextEditorSelectionChangeEvent>();
  const commands: string[] = [];
  const views: Ref[] = [];
  const editRequests: { key: string; commentId: string; body: string; baseline: { body: string; updatedAt: string } }[] = [];
  let freshArrays = false;
  let replyGate: Promise<void> | undefined;
  const key = (item: Ref) => JSON.stringify([item.root, item.data.id]);
  const resource = (item: Ref) => uri(`${item.root}/${item.data.resource.path}`);
  const find = (id: string) => {
    const scoped = refs.find(item => key(item) === id);
    if (scoped) { return scoped; }
    const matching = refs.filter(item => item.data.id === id);
    if (matching.length > 1) { throw new Error('Ambiguous review thread UUID'); }
    return matching[0];
  };
  const requireRef = (id: string) => {
    const item = find(id);
    if (!item) { throw new Error('This thread no longer exists.'); }
    return item;
  };
  const reviews = {
    onDidChange: changed.event,
    all: () => refs,
    view: (item: Ref) => {
      views.push(item);
      return freshArrays ? { ...item.data, comments: item.data.comments.map(comment => ({ ...comment })) } : item.data;
    },
    folderFor: (source: vscode.Uri) => ['file', 'vscode-remote'].includes(source.scheme) ? {} : undefined,
    key, uri: resource, find, require: requireRef,
    keyFor: (source: vscode.Uri, id: string) => key(refs.find(item => item.data.id === id && resource(item).toString() === source.toString())!),
    edit: async (id: string, commentId: string, body: string, baseline: { body: string; updatedAt: string }) => {
      editRequests.push({ key: id, commentId, body, baseline });
      const item = requireRef(id);
      const saved = item.data.comments.find(comment => comment.id === commentId);
      if (!saved) { throw new Error('This comment no longer exists.'); }
      if (saved.body !== baseline.body || saved.updatedAt !== baseline.updatedAt) { throw new Error('Review comment edit conflict'); }
      item.data = { ...item.data, comments: item.data.comments.map(comment => comment === saved
        ? { ...comment, body, updatedAt: '2026-10-06T09:00:00.000Z' } : comment) };
      changed.fire();
    },
    reply: async (id: string, body: string) => {
      await replyGate;
      const item = requireRef(id);
      item.data = { ...item.data, comments: [...item.data.comments, { ...item.data.comments[0], id: 'reply', body }] };
      changed.fire();
    },
    add: async (source: vscode.Uri, body: string, range: Range) => {
      const item = ref(source.path.split('/').pop()!, refs.length + 1000);
      item.data.anchor = { ...item.data.anchor, kind: 'text', range, snapshot: 'Source text', before: '', after: '', stale: false };
      item.data.comments[0].body = body;
      refs.push(item);
      // Deliberately no event: submit must materialize its newly saved record itself.
      return item.data;
    }
  };
  const workspace = {
    textDocuments: [...initialDocuments],
    onDidOpenTextDocument: opened.event,
    openTextDocument: async (source: vscode.Uri) => {
      let doc = workspace.textDocuments.find(item => item.uri.toString() === source.toString());
      if (!doc) { doc = document(source.toString()); workspace.textDocuments.push(doc); opened.fire(doc); }
      return doc;
    }
  };
  const window = {
    visibleTextEditors: initialDocuments.map(doc => editor(doc)),
    activeTextEditor: initialDocuments[0] ? editor(initialDocuments[0]) : undefined as vscode.TextEditor | undefined,
    onDidChangeVisibleTextEditors: visible.event,
    onDidChangeTextEditorSelection: selection.event,
    showTextDocument: async (doc: vscode.TextDocument) => {
      const target = editor(doc);
      window.activeTextEditor = target;
      window.visibleTextEditors = [target];
      visible.fire([target]);
      return target;
    }
  };
  const controller = {
    options: {},
    commentingRangeProvider: undefined as vscode.CommentingRangeProvider | undefined,
    createCommentThread: (source: vscode.Uri, range: vscode.Range, comments: readonly NativeComment[]) => {
      const thread = new NativeThread(source, range, comments, operations);
      native.push(thread);
      operations.push({ kind: 'create', thread });
      return thread;
    },
    dispose: () => { for (const thread of native) { if (!thread.disposed) { thread.dispose(); } } }
  };
  const exported: { InlineReviews?: typeof InlineReviews } = {};
  runInNewContext(inlineScript, {
    exports: exported, process: { platform: 'win32' }, setTimeout, clearTimeout,
    require: (id: string) => {
      if (id === './reviews') { return { selectionRange: (target: vscode.TextEditor) => target.selection }; }
      assert.equal(id, 'vscode');
      return {
        Range, Selection, workspace, window,
        comments: { createCommentController: () => controller },
        CommentMode: { Preview, Editing },
        CommentThreadCollapsibleState: { Collapsed, Expanded },
        CommentThreadState: { Unresolved: 0, Resolved: 1 },
        TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
        commands: { executeCommand: async (command: string) => { commands.push(command); } }
      };
    }
  });
  assert.ok(exported.InlineReviews);
  // Count composition itself, even when it happens not to produce a native setter.
  const prototype = exported.InlineReviews.prototype as unknown as { compose: (...args: any[]) => void };
  const compose = prototype.compose;
  prototype.compose = function (...args: any[]) {
    operations.push({ kind: 'compose', thread: args[0] });
    compose.apply(this, args);
  };
  const inline = new exported.InlineReviews(reviews as unknown as Reviews, 'test-publisher.review-comments');
  return {
    inline, refs, native, operations, views, key, resource, changed, opened, visible, selection, commands,
    editRequests, workspace, window, controller,
    reset: () => { operations.length = 0; views.length = 0; },
    freshArrays: (value: boolean) => { freshArrays = value; },
    gateReplies: (value: Promise<void>) => { replyGate = value; },
    nativeFor: (item: Ref) => {
      const thread = native.find(thread => !thread.disposed && inline.id(thread) === key(item));
      assert.ok(thread, `native thread for ${key(item)}`);
      return thread;
    },
    open: (doc: vscode.TextDocument) => { workspace.textDocuments.push(doc); opened.fire(doc); },
    hide: () => { window.visibleTextEditors = []; visible.fire([]); }
  };
}
function counts(operations: Operation[]) {
  return Object.fromEntries(['create', 'dispose', 'set', 'compose'].map(kind => [kind, operations.filter(operation => operation.kind === kind).length]));
}
const asThread = (thread: NativeThread) => thread as unknown as vscode.CommentThread;
function changeComment(item: Ref, body: string): void {
  item.data = { ...item.data, comments: item.data.comments.map((comment, index) => index ? comment
    : { ...comment, body, updatedAt: '2026-10-06T10:00:00.000Z' }) };
}

test('600 open-source threads are created once; unchanged and fresh-array syncs have zero native work', t => {
  const refs = [...Array.from({ length: 600 }, (_, index) => ref('paper.tex', index)),
    ...Array.from({ length: 80 }, (_, index) => ref('unopened.tex', 600 + index))];
  const h = harness(refs);
  assert.deepEqual(counts(h.operations), { create: 600, dispose: 0, set: 1800, compose: 0 });
  assert.equal(h.views.length, 600, 'unopened sources do not even calculate live anchors');
  t.diagnostic(`Initial 680-record workload: ${JSON.stringify(counts(h.operations))}; 80 unopened records remain lazy.`);
  h.reset();
  for (let index = 0; index < 10; index++) { h.changed.fire(); }
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 0, compose: 0 });
  h.freshArrays(true);
  h.changed.fire();
  h.changed.fire();
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 0, compose: 0 });
  t.diagnostic('10 stable-array refreshes plus 2 equivalent fresh-array refreshes: 0 setters, creations, disposals, or compositions.');
  h.inline.dispose();
});

test('one status, comment, or range change touches only its target among 600 threads', t => {
  const h = harness(Array.from({ length: 600 }, (_, index) => ref('paper.tex', index)));
  const target = h.refs[321];
  const thread = h.nativeFor(target);
  h.reset();
  target.data = { ...target.data, status: 'resolved' };
  h.changed.fire();
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 3, compose: 0 });
  assert.ok(h.operations.every(operation => operation.thread === thread));
  assert.deepEqual(h.operations.map(operation => operation.property).sort(), ['contextValue', 'label', 'state']);
  h.reset();
  changeComment(target, 'Changed comment');
  h.changed.fire();
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 1, compose: 1 });
  assert.ok(h.operations.every(operation => operation.thread === thread));
  assert.equal(thread.comments[0].body, 'Changed comment');
  h.reset();
  assert.equal(target.data.anchor.kind, 'text');
  if (target.data.anchor.kind === 'text') {
    target.data.anchor = { ...target.data.anchor, range: { start: { line: 950, character: 0 }, end: { line: 950, character: 5 } } };
  }
  h.changed.fire();
  assert.deepEqual(h.operations.map(operation => operation.property), ['range']);
  assert.equal(h.operations[0].thread, thread);
  t.diagnostic('600 threads: one status change = 3 target setters; one comment change = 1 target setter/compose; one range change = 1 target setter.');
  h.inline.dispose();
});

test('source-open and visible-editor events materialize lazily; unrelated and hidden events are no-ops', () => {
  const note = ref('notes.tex', 4); note.data.anchor = { kind: 'file' };
  const h = harness([ref('paper.tex', 0), ref('closed.tex', 1), ref('.review-comments/threads/data.json', 2),
    ref('remote.tex', 3, 'vscode-remote://ssh/workspace'), note], []);
  assert.equal(h.native.length, 0);
  h.open(document('comment:///test-publisher.review-comments/input'));
  h.open(document('untitled:///workspace/paper.tex', true));
  h.open(document('git:///workspace/paper.tex'));
  h.open(document('file:///workspace/.review-comments/threads/data.json'));
  h.open(document('file:///workspace/notes.tex'));
  assert.equal(h.operations.length, 0);
  h.open(document('file:///workspace/paper.tex'));
  assert.equal(h.native.length, 1);
  const thread = h.nativeFor(h.refs[0]);
  thread.replyDraft = 'Unsent reply';
  h.reset();
  h.hide();
  h.changed.fire();
  assert.equal(h.operations.length, 0, 'open but offscreen native widgets stay untouched');
  assert.equal(thread.replyDraft, 'Unsent reply');
  const closed = document('file:///workspace/closed.tex');
  h.window.visibleTextEditors = [editor(closed)];
  h.visible.fire(h.window.visibleTextEditors);
  assert.equal(h.native.length, 2, 'visible-editor events also materialize a source');
  h.open(document('vscode-remote://ssh/workspace/remote.tex'));
  assert.equal(h.native.length, 3);
  h.reset();
  h.open(document('file:///workspace/unrelated.tex'));
  h.visible.fire(h.window.visibleTextEditors);
  assert.equal(h.operations.length, 0);
  h.workspace.textDocuments = [];
  h.hide(); h.changed.fire();
  assert.equal(h.operations.length, 0, 'ordinary source closure does not evict opaque native replies');
  assert.equal(thread.replyDraft, 'Unsent reply');
  h.inline.dispose();
  assert.equal(h.opened.listeners.size, 0);
  assert.equal(h.visible.listeners.size, 0);
  assert.equal(h.changed.listeners.size, 0);
});

test('editing object identity and stale baseline survive external refreshes; completion affects only the target', async () => {
  const h = harness([ref('paper.tex', 0), ref('paper.tex', 1)]);
  const target = h.refs[0], thread = h.nativeFor(target);
  const displayed = thread.comments[0];
  changeComment(target, 'Saved externally before edit starts');
  h.changed.fire();
  h.reset();
  h.inline.edit(displayed);
  const editing = thread.comments[0];
  editing.body = 'My unsaved input';
  assert.equal(editing.mode, Editing);
  assert.equal(h.operations.length, 1);
  h.reset();
  h.inline.edit(editing);
  h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.freshArrays(true);
  changeComment(target, 'Saved externally again');
  h.changed.fire();
  assert.equal(thread.comments[0], editing);
  assert.equal(editing.body, 'My unsaved input');
  assert.equal(h.operations.filter(operation => operation.kind === 'set').length, 0);
  await assert.rejects(() => h.inline.saveEdit(editing), /edit conflict/);
  assert.equal(thread.comments[0], editing);
  assert.equal(h.editRequests[0].baseline.body, 'Comment 0', 'baseline comes from the originally displayed object');
  h.reset();
  h.inline.cancelEdit(editing);
  assert.equal(thread.comments[0].body, 'Saved externally again');
  assert.equal(thread.comments[0].mode, Preview);
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 1, compose: 1 });
  assert.ok(h.operations.every(operation => operation.thread === thread));
  h.freshArrays(false);
  h.inline.edit(thread.comments[0]);
  thread.comments[0].body = 'Successfully saved';
  h.reset();
  await h.inline.saveEdit(thread.comments[0]);
  assert.equal(thread.comments[0].body, 'Successfully saved');
  assert.equal(thread.comments[0].mode, Preview);
  assert.equal(h.operations.filter(operation => operation.kind === 'set').length, 1);
  assert.ok(h.operations.every(operation => operation.thread === thread));
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.inline.dispose();
});

test('removed comments and removed-thread edits remain available until cancellation', async () => {
  const h = harness();
  const target = h.refs[0], thread = h.nativeFor(target);
  target.data = { ...target.data, comments: [...target.data.comments, { ...target.data.comments[0], id: 'other', body: 'Keep saved reply' }] };
  h.changed.fire();
  h.inline.edit(thread.comments[0]);
  const editing = thread.comments[0]; editing.body = 'Keep removed draft';
  target.data = { ...target.data, comments: target.data.comments.slice(1) };
  h.changed.fire();
  assert.equal(thread.comments[1], editing);
  assert.match(editing.label!, /copy your draft before choosing Cancel/);
  await assert.rejects(() => h.inline.saveEdit(editing), /no longer exists/);
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.refs.length = 0;
  h.changed.fire();
  assert.equal(thread.comments[0], editing);
  assert.equal(thread.canReply, false);
  assert.equal(thread.disposed, false);
  assert.equal(h.inline.id(h.key(target)), h.key(target), 'retained scoped key remains addressable after deletion');
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0, 'unavailable thread also has a zero-setter refresh');
  h.inline.cancelEdit(editing);
  assert.equal(thread.disposed, true);
  assert.equal(h.operations.filter(operation => operation.kind === 'dispose').length, 1);
  h.inline.dispose();
});

test('persisted deletion without an active edit still disposes exactly the deleted thread', () => {
  const h = harness([ref('paper.tex', 0), ref('paper.tex', 1)]);
  const removed = h.nativeFor(h.refs[0]), retained = h.nativeFor(h.refs[1]);
  h.refs.shift();
  h.reset(); h.changed.fire();
  assert.equal(removed.disposed, true);
  assert.equal(retained.disposed, false);
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 1, set: 0, compose: 0 });
  assert.ok(h.operations.every(operation => operation.thread === removed));
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.inline.dispose();
});

test('reveals do not auto-collapse; explicit collapse preserves replies and skips edits, empty drafts, and pending saves', async () => {
  const h = harness([ref('paper.tex', 0), ref('paper.tex', 1), ref('paper.tex', 2)]);
  const first = h.nativeFor(h.refs[0]), second = h.nativeFor(h.refs[1]), third = h.nativeFor(h.refs[2]);
  await h.inline.reveal(h.key(h.refs[0]));
  first.replyDraft = 'Unsent reply survives collapse';
  await h.inline.reveal(h.key(h.refs[1]));
  assert.equal(first.collapsibleState, Expanded, 'reveal never auto-collapses another thread');
  h.inline.edit(second.comments[0]);
  const editing = second.comments[0];
  third.collapsibleState = Expanded;
  let finishReply!: () => void;
  h.gateReplies(new Promise<void>(resolve => { finishReply = resolve; }));
  const pending = h.inline.submit({ thread: asThread(third), text: 'Pending reply' });
  const targetEditor = editor(h.workspace.textDocuments[0], 900);
  h.window.activeTextEditor = targetEditor;
  const adding = h.inline.add(targetEditor);
  h.open(document('comment:///test-publisher.review-comments/draft-input'));
  await adding;
  const draft = h.native[h.native.length - 1];
  draft.replyDraft = 'Unsent first comment';
  assert.equal(draft.comments.length, 0);
  h.reset();
  h.inline.collapseAll();
  assert.deepEqual(counts(h.operations), { create: 0, dispose: 0, set: 1, compose: 0 });
  assert.equal(h.operations[0].thread, first);
  assert.equal(first.replyDraft, 'Unsent reply survives collapse');
  assert.equal(second.collapsibleState, Expanded);
  assert.equal(second.comments[0], editing);
  assert.equal(third.collapsibleState, Expanded);
  assert.equal(draft.collapsibleState, Expanded);
  assert.equal(draft.replyDraft, 'Unsent first comment');
  h.reset(); h.inline.collapseAll();
  assert.equal(h.operations.length, 0);
  finishReply(); await pending;
  h.inline.dispose();
});

test('moving or closing a source does not destroy expanded replies or active edits', async () => {
  const h = harness([ref('paper.tex', 0), ref('paper.tex', 1), ref('paper.tex', 2)]);
  const expanded = h.nativeFor(h.refs[0]), editingThread = h.nativeFor(h.refs[1]), openThread = h.nativeFor(h.refs[2]);
  expanded.collapsibleState = Expanded;
  expanded.replyDraft = 'Native reply on old source';
  h.inline.edit(editingThread.comments[0]);
  const editing = editingThread.comments[0];
  for (const item of h.refs) { item.data = { ...item.data, resource: { path: 'renamed.tex' } }; }
  h.reset(); h.changed.fire();
  assert.equal(h.operations.filter(operation => operation.kind === 'dispose').length, 0, 'open source protects even collapsed native threads');
  assert.equal(openThread.disposed, false);
  h.workspace.textDocuments = [];
  h.hide();
  h.open(document('file:///workspace/renamed.tex'));
  assert.equal(expanded.disposed, false);
  assert.equal(editingThread.disposed, false);
  assert.equal(expanded.replyDraft, 'Native reply on old source');
  assert.equal(editingThread.comments[0], editing);
  assert.equal(openThread.disposed, true, 'closed, collapsed, non-editing moved thread can relocate');
  assert.equal(await h.inline.reveal(h.key(h.refs[0])), false, 'wrong-source native thread falls back to the panel');
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.inline.dispose();
});

test('reveal and add materialize saved threads before use; draft add focuses once after its input event', async () => {
  const h = harness([ref('paper.tex', 0)], []);
  assert.equal(await h.inline.reveal(h.key(h.refs[0])), true);
  const saved = h.nativeFor(h.refs[0]);
  assert.equal(saved.collapsibleState, Expanded);
  h.reset();
  await h.inline.add(editor(h.workspace.textDocuments[0], 0));
  assert.equal(h.operations.length, 0, 'existing saved thread is reused, not duplicated');
  assert.deepEqual(h.commands, ['workbench.action.focusCommentOnCurrentLine', 'widgetNavigation.focusNext']);
  h.commands.length = 0;
  const target = editor(h.workspace.textDocuments[0], 999);
  h.window.activeTextEditor = target;
  const adding = h.inline.add(target);
  assert.equal(h.commands.length, 0, 'focus waits for the native input document');
  h.open(document('comment:///unrelated/input'));
  assert.equal(h.commands.length, 0);
  h.open(document('comment:///test-publisher.review-comments/new-input'));
  await adding;
  assert.deepEqual(h.commands, ['workbench.action.focusCommentOnCurrentLine', 'widgetNavigation.focusNext']);
  const draft = h.native[h.native.length - 1];
  await h.inline.submit({ thread: asThread(draft), text: 'New saved comment' });
  assert.equal(draft.disposed, false, 'reuse the input when no separate saved widget was materialized');
  assert.equal(h.nativeFor(h.refs[1]), draft);
  assert.equal(draft.comments[0].body, 'New saved comment');
  assert.equal(draft.collapsibleState, Expanded);
  h.inline.dispose();
});

test('a newly saved draft is adopted even when its source closed before submission completed', async () => {
  const h = harness([]);
  const target = editor(h.workspace.textDocuments[0], 25);
  h.window.activeTextEditor = target;
  const adding = h.inline.add(target);
  h.open(document('comment:///test-publisher.review-comments/close-before-save'));
  await adding;
  const draft = h.native[0];
  h.workspace.textDocuments = [];
  h.hide();
  h.reset();
  await h.inline.submit({ thread: asThread(draft), text: 'Saved with source closed' });
  assert.equal(h.nativeFor(h.refs[0]), draft);
  assert.equal(draft.disposed, false);
  assert.equal(draft.comments[0].body, 'Saved with source closed');
  assert.equal(h.operations.filter(operation => operation.kind === 'create' || operation.kind === 'dispose').length, 0);
  h.reset(); h.changed.fire();
  assert.equal(h.operations.length, 0);
  h.inline.dispose();
});

test('add catches up with an already-open source without a prior open event and respects selection changes', async () => {
  const h = harness([ref('paper.tex', 0)], []);
  const doc = document('file:///workspace/paper.tex');
  h.workspace.textDocuments.push(doc);
  const target = editor(doc, 0);
  h.window.activeTextEditor = target;
  await h.inline.add(target);
  assert.equal(h.native.length, 1);
  assert.equal(h.nativeFor(h.refs[0]).comments.length, 1, 'materialize before searching for an existing line');
  h.commands.length = 0;
  const addingEditor = editor(doc, 999);
  h.window.activeTextEditor = addingEditor;
  const adding = h.inline.add(addingEditor);
  const moved = new Selection({ line: 998, character: 0 }, { line: 998, character: 5 }) as unknown as vscode.Selection;
  h.selection.fire({ textEditor: addingEditor, selections: [moved], kind: undefined });
  h.open(document('comment:///test-publisher.review-comments/late-input'));
  await adding;
  assert.equal(h.commands.length, 0, 'changed selection cancels the one late focus request');
  const otherAdd = h.inline.add(editor(doc, 998));
  h.window.activeTextEditor = editor(document('file:///workspace/other.tex'));
  h.open(document('comment:///test-publisher.review-comments/other-late-input'));
  await otherAdd;
  assert.equal(h.commands.length, 0, 'switching source editors also cancels late focus');
  h.inline.dispose();
});

test('scoped identities stay distinct when workspaces share a persisted UUID', async () => {
  const a = ref('paper.tex', 0, 'file:///workspace-a'), b = ref('paper.tex', 0, 'file:///workspace-b');
  const h = harness([a, b], [document('file:///workspace-a/paper.tex'), document('file:///workspace-b/paper.tex')]);
  const first = h.nativeFor(a), second = h.nativeFor(b);
  assert.equal(h.inline.id(first), h.key(a));
  assert.equal(h.inline.id({ thread: second }), h.key(b));
  assert.equal(h.inline.id({ comment: first.comments[0] }), h.key(a));
  assert.throws(() => h.inline.id(a.data.id), /Ambiguous/);
  h.inline.edit(second.comments[0]);
  second.comments[0].body = 'Only workspace B';
  await h.inline.saveEdit(second.comments[0]);
  assert.equal(first.comments[0].body, 'Comment 0');
  assert.equal(second.comments[0].body, 'Only workspace B');
  assert.equal(h.editRequests[0].key, h.key(b));
  h.inline.dispose();
});
