import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { Thread, MAX_COMMENT_LENGTH, validateCommentBody } from './core/model';
import { describeLocation } from './core/export';

export interface PanelCallbacks {
  create(uri: vscode.Uri, body: string): Promise<{ thread: Thread; key: string }>;
  reply(id: string, body: string, status?: 'open' | 'resolved'): Promise<void>;
  deleteComment(id: string, commentId: string): Promise<boolean>;
  edit(id: string, commentId: string, body: string, baseline: { body: string; updatedAt: string }): Promise<void>;
  setStatus(id: string, status: 'open' | 'resolved'): Promise<void>;
  remove(id: string): Promise<boolean>;
  copy(id: string): Promise<void>;
  getThread(id: string): Thread | undefined;
  openSource?(id: string): Promise<void>;
}

const MAX_BODY_LENGTH = MAX_COMMENT_LENGTH;
const ACTIONS = new Set(['create', 'reply', 'edit', 'deleteComment', 'setStatus', 'remove', 'copy', 'openSource']);
type Action = 'create' | 'reply' | 'edit' | 'deleteComment' | 'setStatus' | 'remove' | 'copy' | 'openSource';

type Selection = { kind: 'file'; uri: vscode.Uri } | { kind: 'thread'; id: string };
interface ViewBase {
  viewId: string;
  key: string;
  path: string;
}
interface FileView extends ViewBase {
  kind: 'file';
}
interface ThreadView extends ViewBase {
  kind: 'thread';
  id: string;
  status: 'open' | 'resolved';
  location: string;
  anchor: { kind: 'file' } | {
    kind: 'text';
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    snapshot: string;
    stale: boolean;
  };
  comments: Array<{
    id: string;
    body: string;
    author: string;
    createdAt: string;
    updatedAt: string;
  }>;
  tags: string[];
}
interface MissingView extends ViewBase {
  kind: 'missing';
  id: string;
}
type View = FileView | ThreadView | MissingView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function readBody(value: unknown): string {
  validateCommentBody(value);
  // Validation never trims the saved body.
  return value;
}

function messageFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The review action could not be completed. Please try again.';
}

/** A presentation-only surface; all persistence and confirmation belong to the caller. */
export class ReviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelSubscriptions: vscode.Disposable[] = [];
  private selection: Selection | undefined;
  private view: View | undefined;
  private ready = false;
  private busy = false;
  private disposed = false;
  private focusSequence = 0;
  private pendingFocus: { sequence: number; viewId: string; target?: 'read' } | undefined;
  private lastSent = '';

  constructor(context: vscode.ExtensionContext, private readonly callbacks: PanelCallbacks) {
    context.subscriptions.push(this);
  }

  showFile(uri: vscode.Uri): void {
    if (this.disposed) {
      return;
    }
    const key = `file:${uri.toString()}`;
    this.selection = { kind: 'file', uri };
    this.view = {
      kind: 'file',
      key,
      viewId: this.view?.key === key ? this.view.viewId : this.newViewId(),
      path: uri.scheme === 'file' ? uri.fsPath : uri.toString(true),
    };
    this.pendingFocus = { sequence: ++this.focusSequence, viewId: this.view.viewId };
    this.reveal();
    this.sendView();
  }

  showThread(thread: Thread, threadKey: string, options: { read?: boolean } = {}): void {
    if (this.disposed) {
      return;
    }
    const key = `thread:${threadKey}`;
    this.selection = { kind: 'thread', id: threadKey };
    this.view = this.threadView(thread, threadKey, this.view?.key === key ? this.view.viewId : this.newViewId());
    this.pendingFocus = { sequence: ++this.focusSequence, viewId: this.view.viewId, ...(options.read ? { target: 'read' as const } : {}) };
    this.reveal();
    this.sendView();
  }

  refresh(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.updateThread();
      this.sendView();
    } catch (error) {
      this.reportError(error);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.disposePanelSubscriptions();
    panel?.dispose();
  }

  private newViewId(): string {
    return randomBytes(16).toString('hex');
  }

  private threadView(thread: Thread, threadKey: string, viewId: string): ThreadView {
    const anchor = thread.anchor;
    return {
      kind: 'thread',
      key: `thread:${threadKey}`,
      viewId,
      id: threadKey,
      path: thread.resource.path,
      status: thread.status,
      location: describeLocation(thread),
      anchor: anchor.kind === 'file' ? { kind: 'file' } : {
        kind: 'text',
        startLine: anchor.range.start.line,
        startCharacter: anchor.range.start.character,
        endLine: anchor.range.end.line,
        endCharacter: anchor.range.end.character,
        snapshot: anchor.snapshot,
        stale: anchor.stale === true,
      },
      comments: thread.comments.map(comment => ({
        id: comment.id,
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
      tags: [...thread.tags],
    };
  }

  private reveal(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'reviewComments.review',
      'Review Comments',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        enableCommandUris: false,
        localResourceRoots: [],
        retainContextWhenHidden: true,
      },
    );
    this.panel = panel;
    this.ready = false;
    this.lastSent = '';
    this.panelSubscriptions.push(
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.panel = undefined;
          this.ready = false;
          this.disposePanelSubscriptions();
        }
      }),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.receive(message, panel);
      }),
    );
    // The document is created once. Subsequent updates never replace its textareas.
    panel.webview.html = this.html();
  }

  private disposePanelSubscriptions(): void {
    const subscriptions = this.panelSubscriptions;
    this.panelSubscriptions = [];
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }

  private send(message: unknown): void {
    if (this.panel && this.ready && !this.disposed) {
      // Closing the panel while a callback is running is normal.
      void this.panel.webview.postMessage(message).then(undefined, () => undefined);
    }
  }

  private sendView(): void {
    if (this.view && this.panel && this.ready && !this.disposed) {
      // Keep an explicit request until the initial ready handshake, but never replay it
      // on a storage refresh (including refreshes caused by our own submissions).
      const focus = this.pendingFocus?.viewId === this.view.viewId ? this.pendingFocus : undefined;
      this.pendingFocus = undefined;
      const signature = JSON.stringify([this.view, this.busy, !!this.callbacks.openSource]);
      if (!focus && signature === this.lastSent) { return; }
      this.lastSent = signature;
      this.send({ type: 'view', view: this.view, busy: this.busy, focus, canOpenSource: !!this.callbacks.openSource });
    }
  }

  private updateThread(): void {
    if (this.selection?.kind !== 'thread' || !this.view) {
      return;
    }
    const thread = this.callbacks.getThread(this.selection.id);
    this.view = thread ? this.threadView(thread, this.selection.id, this.view.viewId) : {
      kind: 'missing',
      key: this.view.key,
      viewId: this.view.viewId,
      path: this.view.path,
      id: this.selection.id,
    };
  }

  private reportError(error: unknown, requestId?: string, viewId?: string): void {
    const message = messageFor(error);
    void vscode.window.showErrorMessage(`Review Comments: ${message}`);
    this.send({ type: 'error', message, requestId, viewId, busy: this.busy });
  }

  private async receive(value: unknown, originatingPanel: vscode.WebviewPanel): Promise<void> {
    if (this.disposed || this.panel !== originatingPanel || !isRecord(value)) {
      return;
    }
    if (value.command === 'ready' && Object.keys(value).length === 1) {
      this.ready = true;
      this.sendView();
      return;
    }
    if (typeof value.command !== 'string' || !ACTIONS.has(value.command)
      || !isIdentifier(value.requestId) || !isIdentifier(value.viewId)) {
      return;
    }

    const command = value.command as Action;
    const requestId = value.requestId;
    const viewId = value.viewId;
    let acquired = false;
    let error: unknown;
    let succeeded = false;
    let cancelled = false;
    let createdViewId: string | undefined;
    try {
      if (!this.view || this.view.viewId !== viewId || !this.selection) {
        throw new Error('This review has changed. Please submit from the current review.');
      }
      if (this.busy) {
        throw new Error('Another review action is in progress. Please wait.');
      }
      // The host, rather than the message, determines the resource and selected thread.
      this.busy = true;
      acquired = true;
      if (command === 'create') {
        if (this.selection.kind !== 'file') {
          throw new Error('Select a file before adding a file-level review.');
        }
        const created = await this.callbacks.create(this.selection.uri, readBody(value.body));
        if (this.panel === originatingPanel && this.view?.viewId === viewId && !this.disposed) {
          this.selection = { kind: 'thread', id: created.key };
          this.view = this.threadView(created.thread, created.key, this.newViewId());
          createdViewId = this.view.viewId;
          // This is a submission result, not another explicit reveal. Let the webview
          // restore focus once, after it has received the result and unlocked input.
          this.sendView();
        }
      } else {
        if (this.selection.kind !== 'thread' || value.id !== this.selection.id) {
          throw new Error('The selected review does not match this action.');
        }
        const id = this.selection.id;
        const thread = this.callbacks.getThread(id);
        if (!thread) {
          throw new Error('This review is no longer available.');
        }
        switch (command) {
          case 'reply':
            if (value.status !== undefined && value.status !== 'open' && value.status !== 'resolved') {
              throw new Error('Choose Open or Resolved.');
            }
            await this.callbacks.reply(id, readBody(value.body), value.status);
            break;
          case 'deleteComment':
            if (!isIdentifier(value.commentId) || !thread.comments.some(comment => comment.id === value.commentId)) {
              throw new Error('This comment is no longer available.');
            }
            cancelled = !await this.callbacks.deleteComment(id, value.commentId);
            break;
          case 'edit':
            if (!isIdentifier(value.commentId)
              || !thread.comments.some(comment => comment.id === value.commentId)) {
              throw new Error('This comment is no longer available.');
            }
            if (!isRecord(value.baseline) || typeof value.baseline.body !== 'string' || typeof value.baseline.updatedAt !== 'string') {
              throw new Error('The edit baseline is missing. Cancel and reopen the comment editor.');
            }
            await this.callbacks.edit(id, value.commentId, readBody(value.body), { body: value.baseline.body, updatedAt: value.baseline.updatedAt });
            break;
          case 'setStatus':
            if (value.status !== 'open' && value.status !== 'resolved') {
              throw new Error('Select a valid review status.');
            }
            await this.callbacks.setStatus(id, value.status);
            break;
          case 'remove':
            // The callback owns confirmation; cancellation may leave the thread intact.
            cancelled = !await this.callbacks.remove(id);
            break;
          case 'copy':
            await this.callbacks.copy(id);
            break;
          case 'openSource':
            await this.callbacks.openSource?.(id);
            break;
        }
        this.updateThread();
      }
      succeeded = true;
    } catch (caught) {
      error = caught;
    } finally {
      if (acquired) {
        this.busy = false;
      }
      if (succeeded) {
        this.send({ type: 'result', requestId, viewId, command, createdViewId, cancelled, busy: this.busy });
      } else {
        this.reportError(error, requestId, viewId);
      }
      this.sendView();
    }
  }

  private html(): string {
    const nonce = randomBytes(24).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';">
  <title>Review Comments</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    main { max-width: 900px; margin: 0 auto; }
    [hidden] { display: none !important; }
    h1 { margin: 0 0 12px; font-size: 1.45em; font-weight: 600; }
    h2 { font-size: 1.1em; margin: 22px 0 10px; }
    p { line-height: 1.5; }
    .path { overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .muted, .metadata, .hint { color: var(--vscode-descriptionForeground); }
    .hint { margin: 8px 0; font-size: .9em; }
    .toolbar, .actions, .comment-heading { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .toolbar { margin: 14px 0; position: sticky; top: 0; z-index: 1; padding: 10px 0; background: var(--vscode-editor-background); }
    #comments-section { user-select: text; }
    #comments-section:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 4px; }
    .badge { padding: 3px 8px; border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border)); border-radius: 3px; }
    .notice { margin: 12px 0; padding: 10px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
    #error { color: var(--vscode-errorForeground); overflow-wrap: anywhere; }
    #activity { min-height: 1.5em; margin: 8px 0; }
    button { padding: 6px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font: inherit; }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger { color: var(--vscode-errorForeground); background: transparent; border-color: var(--vscode-errorForeground); }
    button.danger:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    textarea { display: block; width: 100%; min-height: 110px; resize: vertical; padding: 10px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; line-height: 1.5; }
    textarea:read-only { opacity: .8; }
    label { display: block; font-weight: 600; margin: 0 0 8px; }
    .comment { margin: 12px 0; padding: 14px; border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder)); border-radius: 4px; }
    .comment-heading { margin-bottom: 10px; }
    .author { font-weight: 600; }
    .metadata { font-size: .9em; }
    .comment-heading button { margin-left: auto; }
    .comment-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
    .edit-area { margin-top: 12px; }
    .actions { margin-top: 10px; }
    summary { cursor: pointer; margin: 12px 0; }
    pre { padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border, transparent); }
    #tags { overflow-wrap: anywhere; }
    @media (max-width: 420px) { body { padding: 12px; } .toolbar { gap: 6px; } }
  </style>
</head>
<body>
  <main aria-busy="false">
    <h1 id="heading">Review Comments</h1>
    <p id="path" class="path"></p>
    <p id="location" class="muted" hidden></p>
    <p id="file-note" class="muted" hidden>This comment applies to the whole file, not a specific line, PDF page, or image region. The source file is not changed.</p>
    <p id="stale" class="notice" hidden>Location unverified: the saved text could not be matched reliably to the current source, or the file could not be checked. Check the location before making changes. The saved excerpt is kept below.</p>
    <p id="missing" class="notice" hidden>This review is no longer available. Any draft below is kept for you to copy.</p>
    <details id="snapshot-section" hidden>
      <summary>Saved source selection</summary>
      <pre id="snapshot"></pre>
    </details>
    <p id="tags" class="muted" hidden></p>
    <div id="toolbar" class="toolbar" hidden>
      <span id="status" class="badge"></span>
      <button id="status-button" type="button" class="secondary">Resolve</button>
      <button id="copy-button" type="button" class="secondary">Copy Thread</button>
      <button id="source-button" type="button" class="secondary" hidden>Go to Source</button>
      <button id="remove-button" type="button" class="danger">Delete Thread</button>
    </div>
    <section id="comments-section" aria-label="Comments" tabindex="0" hidden>
      <h2>Comments</h2>
      <p class="hint">Select text to copy an excerpt, or use Copy Thread to include the full discussion and saved source context.</p>
      <div id="comments"></div>
    </section>
    <section id="composer" hidden>
      <h2 id="composer-heading">Add Comment</h2>
      <label id="body-label" for="body">Comment</label>
      <textarea id="body" rows="5" maxlength="${MAX_BODY_LENGTH}" aria-describedby="submit-hint" placeholder="Write a comment"></textarea>
      <p id="submit-hint" class="hint">Ctrl+Enter (macOS: Cmd+Enter) saves your comment or reply. Enter adds a new line. Comments are displayed as plain text.</p>
      <p id="reply-status-hint" class="hint" hidden></p>
      <div class="actions">
        <button id="submit-button" type="button">Add Comment</button>
        <button id="reply-status-button" type="button" class="secondary" hidden>Reply &amp; Resolve</button>
      </div>
    </section>
    <p id="draft-status" class="hint" role="status" aria-live="polite" hidden></p>
    <p id="activity" class="muted" role="status" aria-live="polite"></p>
    <p id="error" role="alert" hidden></p>
  </main>
  <script nonce="${nonce}">
    (() => {
      'use strict';
      const host = acquireVsCodeApi();
      const byId = id => document.getElementById(id);
      const body = byId('body');
      const commentList = byId('comments');
      const nodes = new Map();
      const drafts = new Map();
      const allowed = new Set(['create', 'reply', 'edit', 'deleteComment', 'setStatus', 'remove', 'copy', 'openSource']);
      let current;
      let activeRequest;
      let serverBusy = false;
      let counter = 0;
      let lastFocusSequence = 0;
      let activeEditId;

      function record(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }
      function showError(message) {
        byId('error').textContent = message;
        byId('error').hidden = !message;
      }
      function dateLabel(value) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      }
      function saveDraft() {
        if (!current) return;
        const edits = new Map();
        for (const [id, node] of nodes) {
          if (!node.editor.hidden) edits.set(id, {
            body: node.input.value,
            baseline: node.baseline,
            comment: { id, body: node.original, updatedAt: node.updatedAt, createdAt: node.createdAt, author: node.author.textContent },
          });
        }
        drafts.set(current.key, { body: body.value, edits, activeEditId });
      }
      function focusInput(input) {
        // Refocusing an already active textarea is unnecessary; never reset its
        // value or selection just because the user opens the same review again.
        if (input && (document.activeElement !== input || !document.hasFocus())) input.focus();
      }
      function preferredInput() {
        const active = nodes.get(activeEditId);
        if (active && !active.editor.hidden) return active.input;
        for (const node of nodes.values()) {
          if (!node.editor.hidden) return node.input;
        }
        return body;
      }
      function focusEditor(command, commentId) {
        const node = command === 'edit' ? nodes.get(commentId) : undefined;
        focusInput(node && !node.editor.hidden ? node.input : body);
      }
      function applyFocus(request, sameReview) {
        if (!record(request) || !Number.isSafeInteger(request.sequence)
          || request.sequence <= lastFocusSequence || request.viewId !== current?.viewId) return;
        lastFocusSequence = request.sequence;
        if (request.target === 'read' && current.kind === 'thread') {
          focusInput(byId('comments-section'));
          return;
        }
        if (current.kind !== 'missing') {
          focusInput(sameReview && document.activeElement === body ? body : preferredInput());
        }
      }
      function updateDraftStatus() {
        const here = Boolean(body.value.length) || [...nodes.values()].some(node => !node.editor.hidden);
        const elsewhere = [...drafts].some(([key, draft]) => key !== current?.key && (draft.body.length || draft.edits.size));
        const status = byId('draft-status');
        status.hidden = !here && !elsewhere;
        status.textContent = here || elsewhere
          ? (here ? 'Unsaved draft' : 'Unsaved drafts in other reviews') + ' — kept only while this panel stays open. Copy and Export include saved comments only.'
          : '';
      }
      function updateControls() {
        const busy = Boolean(activeRequest) || serverBusy;
        const editable = current && current.kind !== 'missing';
        document.querySelector('main').setAttribute('aria-busy', String(busy));
        byId('submit-button').disabled = busy || !editable || !body.value.trim();
        body.readOnly = busy || !editable;
        for (const id of ['status-button', 'copy-button', 'remove-button', 'source-button']) {
          byId(id).disabled = busy || !current || current.kind !== 'thread';
        }
        for (const node of nodes.values()) {
          node.toggle.disabled = busy || !editable || node.unavailable;
          node.save.disabled = busy || !editable || node.unavailable || !node.input.value.trim();
          node.cancel.disabled = busy;
          node.input.readOnly = busy || !editable || node.unavailable;
        }
        byId('activity').textContent = busy ? 'Working…' : '';
        updateDraftStatus();
      }
      function submit(command, fields) {
        if (!current || activeRequest || serverBusy || !allowed.has(command)) return;
        if ((command === 'create' && current.kind !== 'file')
          || (command !== 'create' && current.kind !== 'thread')) return;
        if (command === 'create' || command === 'reply' || command === 'edit') {
          if (typeof fields.body !== 'string' || !fields.body.trim()) {
            showError('Enter a comment before submitting.');
            focusEditor(command, fields.commentId);
            return;
          }
          if (fields.body.length > ${MAX_BODY_LENGTH}) {
            showError('The comment is too long. Please shorten it before submitting.');
            focusEditor(command, fields.commentId);
            return;
          }
        }
        const requestId = String(Date.now()) + '-' + String(++counter);
        activeRequest = { requestId, viewId: current.viewId, key: current.key, command, commentId: fields.commentId };
        showError('');
        updateControls();
        try {
          host.postMessage({ ...fields, command, requestId, viewId: current.viewId, id: current.kind === 'thread' ? current.id : undefined });
        } catch (_) {
          activeRequest = undefined;
          showError('The review action could not be sent. Please try again.');
          updateControls();
          focusEditor(command, fields.commentId);
        }
      }
      function submitBody() {
        if (!current) return;
        submit(current.kind === 'file' ? 'create' : 'reply', { body: body.value });
      }
      function bindShortcut(input, action) {
        let composing = false;
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => { composing = false; });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)
            && !composing && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            action();
          }
        });
      }
      function makeButton(label, className) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = className || 'secondary';
        return button;
      }
      function createComment(comment) {
        const article = document.createElement('article');
        article.className = 'comment';
        const heading = document.createElement('div');
        heading.className = 'comment-heading';
        const author = document.createElement('span');
        author.className = 'author';
        const time = document.createElement('span');
        time.className = 'metadata';
        const toggle = makeButton('Edit');
        heading.append(author, time, toggle);
        const text = document.createElement('div');
        text.className = 'comment-body';
        const editor = document.createElement('div');
        editor.className = 'edit-area';
        editor.hidden = true;
        const label = document.createElement('label');
        label.textContent = 'Edit comment';
        const input = document.createElement('textarea');
        input.rows = 4;
        input.maxLength = ${MAX_BODY_LENGTH};
        // Wrapping the control in its label avoids using external identifiers in DOM attributes.
        label.append(input);
        const actions = document.createElement('div');
        actions.className = 'actions';
        const save = makeButton('Save changes', 'primary');
        const cancel = makeButton('Cancel');
        actions.append(save, cancel);
        editor.append(label, actions);
        article.append(heading, text, editor);
        const node = { article, author, time, toggle, text, editor, input, save, cancel, original: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, baseline: { body: comment.body, updatedAt: comment.updatedAt }, unavailable: false };
        toggle.addEventListener('click', () => {
          if (activeRequest || serverBusy) return;
          if (editor.hidden) {
            input.value = node.original;
            node.baseline = { body: node.original, updatedAt: node.updatedAt };
          }
          editor.hidden = false;
          toggle.hidden = true;
          activeEditId = comment.id;
          saveDraft();
          updateControls();
          focusInput(input);
        });
        cancel.addEventListener('click', () => {
          editor.hidden = true;
          toggle.hidden = false;
          if (activeEditId === comment.id) activeEditId = undefined;
          saveDraft();
          updateControls();
          toggle.focus();
        });
        const submitEdit = () => submit('edit', { commentId: comment.id, body: input.value, baseline: node.baseline });
        save.addEventListener('click', submitEdit);
        bindShortcut(input, submitEdit);
        input.addEventListener('focus', () => { activeEditId = comment.id; saveDraft(); });
        input.addEventListener('input', () => { saveDraft(); updateControls(); });
        return node;
      }
      function restoreEdit(node, edit) {
        node.input.value = edit.body;
        node.baseline = edit.baseline;
        node.editor.hidden = false;
        node.toggle.hidden = true;
      }
      function renderComments(comments) {
        const retained = new Set(comments.map(comment => comment.id));
        for (const [id, node] of nodes) {
          if (!retained.has(id)) {
            if (!node.editor.hidden) {
              // Keep an unsaved edit even when another window removes the comment.
              node.unavailable = true;
              node.time.textContent = 'Comment removed. Copy your draft before cancelling.';
            } else {
              node.article.remove();
              nodes.delete(id);
            }
          }
        }
        const saved = drafts.get(current.key);
        comments.forEach((comment, index) => {
          let node = nodes.get(comment.id);
          if (!node) {
            node = createComment(comment);
            nodes.set(comment.id, node);
            if (saved && saved.edits.has(comment.id)) {
              restoreEdit(node, saved.edits.get(comment.id));
            }
          }
          node.original = comment.body;
          node.createdAt = comment.createdAt;
          node.updatedAt = comment.updatedAt;
          node.unavailable = false;
          const authorText = comment.author || 'Unknown author';
          const timeText = dateLabel(comment.createdAt)
            + (comment.updatedAt !== comment.createdAt ? ' · Edited ' + dateLabel(comment.updatedAt) : '');
          if (node.author.textContent !== authorText) node.author.textContent = authorText;
          if (node.time.textContent !== timeText) node.time.textContent = timeText;
          // Replacing textContent destroys an active text selection, even when the string is unchanged.
          if (node.text.textContent !== comment.body) node.text.textContent = comment.body;
          node.toggle.setAttribute('aria-label', 'Edit comment by ' + (comment.author || 'Unknown author'));
          // Do not move an existing focused editor during an ordinary refresh.
          if (commentList.children[index] !== node.article) {
            commentList.insertBefore(node.article, commentList.children[index] || null);
          }
        });
        // Navigation must not discard an edit whose comment disappeared meanwhile.
        for (const [id, edit] of saved?.edits || []) {
          if (!retained.has(id) && !nodes.has(id)) {
            const node = createComment(edit.comment);
            restoreEdit(node, edit);
            node.unavailable = true;
            node.author.textContent = edit.comment.author || 'Unknown author';
            node.time.textContent = 'Comment removed. Copy your draft before cancelling.';
            node.text.textContent = edit.comment.body;
            nodes.set(id, node);
            commentList.append(node.article);
          }
        }
      }
      function validView(view) {
        if (!record(view) || typeof view.viewId !== 'string' || typeof view.key !== 'string' || typeof view.path !== 'string') return false;
        if (view.kind === 'file') return true;
        if (view.kind === 'missing') return typeof view.id === 'string';
        if (view.kind !== 'thread' || typeof view.id !== 'string' || !['open', 'resolved'].includes(view.status)
          || !record(view.anchor) || !Array.isArray(view.comments) || !Array.isArray(view.tags)) return false;
        if (!view.tags.every(tag => typeof tag === 'string')) return false;
        if (!view.comments.every(comment => record(comment)
          && ['id', 'body', 'author', 'createdAt', 'updatedAt'].every(key => typeof comment[key] === 'string'))) return false;
        return view.anchor.kind === 'file' || (view.anchor.kind === 'text'
          && typeof view.anchor.snapshot === 'string' && typeof view.anchor.stale === 'boolean'
          && ['startLine', 'startCharacter', 'endLine', 'endCharacter'].every(key => Number.isInteger(view.anchor[key]) && view.anchor[key] >= 0));
      }
      function render(view) {
        const changed = !current || current.key !== view.key;
        if (changed) {
          saveDraft();
          nodes.clear();
          commentList.replaceChildren();
          body.value = drafts.get(view.key)?.body || '';
          activeEditId = drafts.get(view.key)?.activeEditId;
          showError('');
          byId('snapshot-section').open = false;
        }
        current = view;
        const isThread = view.kind === 'thread';
        const isText = isThread && view.anchor.kind === 'text';
        const isFile = view.kind === 'file' || (isThread && view.anchor.kind === 'file');
        byId('heading').textContent = isText ? 'Text Comment' : isFile ? 'File Comment' : 'Thread Unavailable';
        byId('path').textContent = view.path;
        byId('file-note').hidden = !isFile;
        byId('location').hidden = !isText;
        byId('snapshot-section').hidden = !isText;
        byId('stale').hidden = !isText || !view.anchor.stale;
        byId('missing').hidden = view.kind !== 'missing';
        if (isText) {
          const anchor = view.anchor;
          byId('location').textContent = 'Line ' + (anchor.startLine + 1) + ', column ' + (anchor.startCharacter + 1)
            + ' to line ' + (anchor.endLine + 1) + ', column ' + (anchor.endCharacter + 1);
          byId('snapshot').textContent = anchor.snapshot;
        }
        byId('tags').hidden = !isThread || view.tags.length === 0;
        if (isThread) byId('tags').textContent = 'Tags: ' + view.tags.join(', ');
        byId('toolbar').hidden = !isThread;
        if (isThread) {
          byId('status').textContent = view.status === 'resolved' ? 'Resolved' : 'Open';
          byId('status-button').textContent = view.status === 'resolved' ? 'Reopen' : 'Resolve';
          renderComments(view.comments);
        } else if (view.kind === 'missing') {
          renderComments([]);
        }
        byId('comments-section').hidden = !isThread && nodes.size === 0;
        byId('composer').hidden = false;
        byId('composer-heading').textContent = view.kind === 'file' ? 'Add Comment' : 'Reply';
        byId('body-label').textContent = view.kind === 'file' ? 'Comment' : 'Reply';
        byId('submit-button').textContent = view.kind === 'file' ? 'Add Comment' : 'Reply';
        body.placeholder = view.kind === 'file' ? 'Write a comment' : 'Write a reply';
        updateControls();
      }
      function complete(message, success) {
        if (!activeRequest || message.requestId !== activeRequest.requestId || message.viewId !== activeRequest.viewId) return;
        const request = activeRequest;
        const sameView = current && current.viewId === request.viewId;
        const createdView = success && request.command === 'create'
          && typeof message.createdViewId === 'string' && current?.viewId === message.createdViewId;
        activeRequest = undefined;
        if (typeof message.busy === 'boolean') serverBusy = message.busy;
        let returnFocus;
        if (success) {
          const saved = drafts.get(request.key);
          if (request.command === 'create' || request.command === 'reply') {
            if (saved) saved.body = '';
            if (current && current.key === request.key) body.value = '';
            if (sameView || createdView) returnFocus = body;
          } else if (request.command === 'edit') {
            if (saved) saved.edits.delete(request.commentId);
            const node = current && current.key === request.key ? nodes.get(request.commentId) : undefined;
            if (node) {
              node.editor.hidden = true;
              node.toggle.hidden = false;
              if (activeEditId === request.commentId) activeEditId = undefined;
              if (sameView) returnFocus = node.toggle;
            }
          }
          if (sameView || createdView) showError('');
        } else if (sameView) {
          showError(message.message);
          const node = request.command === 'edit' ? nodes.get(request.commentId) : undefined;
          returnFocus = node && !node.editor.hidden ? node.input : body;
        }
        saveDraft();
        updateControls();
        // A late completion for another review must not interrupt the current one.
        focusInput(returnFocus);
      }
      body.addEventListener('input', () => { saveDraft(); updateControls(); });
      bindShortcut(body, submitBody);
      byId('submit-button').addEventListener('click', submitBody);
      byId('status-button').addEventListener('click', () => {
        if (current && current.kind === 'thread') submit('setStatus', { status: current.status === 'open' ? 'resolved' : 'open' });
      });
      byId('copy-button').addEventListener('click', () => submit('copy', {}));
      byId('source-button').addEventListener('click', () => submit('openSource', {}));
      byId('remove-button').addEventListener('click', () => submit('remove', {}));
      window.addEventListener('message', event => {
        const message = event.data;
        if (!record(message)) return;
        switch (message.type) {
          case 'view': {
            if (!validView(message.view) || typeof message.busy !== 'boolean') return;
            const sameReview = current?.key === message.view.key;
            serverBusy = message.busy;
            render(message.view);
            byId('source-button').hidden = !message.canOpenSource || message.view.kind !== 'thread';
            applyFocus(message.focus, sameReview);
            break;
          }
          case 'result':
            complete(message, true);
            break;
          case 'error':
            if (typeof message.message !== 'string') return;
            if (typeof message.requestId === 'string') complete(message, false);
            else showError(message.message);
            break;
        }
      });
      host.postMessage({ command: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}
