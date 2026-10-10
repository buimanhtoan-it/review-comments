import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import type { PanelCallbacks, ReviewPanel } from '../src/panel';
import { createThread } from '../src/core/model';

// Exercise the actual generated webview script without an extension host or browser.
// A type-only panel import makes tsc emit panel.js without requiring vscode in Node.
type Message = Record<string, any>;
type Handler = (event: any) => void;
class Element {
  children: Element[] = [];
  parent: Element | undefined;
  hidden = false;
  disabled = false;
  readOnly = false;
  textContent = '';
  value = '';
  className = '';
  selectionStart = 0;
  selectionEnd = 0;
  focusCount = 0;
  attributes = new Map<string, string>();
  listeners = new Map<string, Handler[]>();
  constructor(readonly tagName: string, readonly document: Document) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(type: string, handler: Handler): void {
    this.listeners.set(type, [...(this.listeners.get(type) || []), handler]);
  }
  emit(type: string, fields: Message = {}): Message {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  focus(): void {
    this.focusCount++;
    this.document.activeElement = this;
    this.document.focused = true;
    this.emit('focus');
  }
  append(...children: Element[]): void {
    for (const child of children) this.insertBefore(child, null);
  }
  insertBefore(child: Element, before: Element | null): void {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
    child.parent = this;
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
  replaceChildren(): void {
    for (const child of [...this.children]) child.remove();
  }
}
class Document {
  activeElement: Element | undefined;
  focused = true;
  hasFocus(): boolean { return this.focused; }
  elements = new Map<string, Element>();
  main = new Element('main', this);
  constructor(html: string) {
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const element = new Element(match[1], this);
      element.hidden = /\bhidden\b/.test(match[0]);
      this.elements.set(match[2], element);
    }
  }
  getElementById(id: string): Element {
    const element = this.elements.get(id);
    assert.ok(element, id);
    return element;
  }
  createElement(tag: string): Element { return new Element(tag, this); }
  querySelector(selector: string): Element { assert.equal(selector, 'main'); return this.main; }
}
function descendants(root: Element): Element[] {
  return root.children.flatMap(child => [child, ...descendants(child)]);
}
function harness() {
  const thread = createThread('paper.tex', { kind: 'file' }, 'Original', 'Reviewer');
  const key = 'workspace-a:' + thread.id;
  let failure: Error | undefined;
  let deleteApproved = false;
  let threadAvailable = true;
  const replies: Array<{ body: string; status?: 'open' | 'resolved' }> = [];
  const callbacks: PanelCallbacks = {
    create: async () => { if (failure) throw failure; return { thread, key }; },
    reply: async (_id, body, status) => {
      if (failure) throw failure;
      replies.push({ body, status });
      if (status) thread.status = status;
    },
    edit: async () => { if (failure) throw failure; },
    deleteComment: async (_id, commentId) => {
      if (!deleteApproved) return false;
      thread.comments = thread.comments.filter(comment => comment.id !== commentId);
      if (!thread.comments.length) threadAvailable = false;
      return true;
    },
    setStatus: async (_id, status) => { thread.status = status; },
    remove: async () => { if (deleteApproved) threadAvailable = false; return deleteApproved; },
    copy: async () => {},
    openSource: async id => { assert.equal(id, key); },
    getThread: id => id === key && threadAvailable ? thread : undefined,
  };
  const sent: Message[] = [];
  let deliver: ((message: Message) => void) | undefined;
  const panel = {
    webview: {
      html: '',
      postMessage: async (message: Message) => {
        sent.push(message);
        try { deliver?.(message); } catch (error) { console.error('Webview test delivery failed:', error); throw error; }
        return true;
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }),
  };
  const exported: { ReviewPanel?: typeof ReviewPanel } = {};
  runInNewContext(readFileSync(path.resolve(__dirname, '../src/panel.js'), 'utf8'), {
    exports: exported,
    Error,
    require: (id: string) => id === 'vscode'
      ? { ViewColumn: { Beside: 2 }, window: { createWebviewPanel: () => panel, showErrorMessage: () => Promise.resolve() } }
      : createRequire(path.resolve(__dirname, '../src/panel.js'))(id),
  });
  assert.ok(exported.ReviewPanel);
  const review = new exported.ReviewPanel({ subscriptions: [] } as unknown as vscode.ExtensionContext, callbacks);
  const file = { scheme: 'file', fsPath: '/workspace/paper.tex', toString: () => 'file:///workspace/paper.tex' } as unknown as vscode.Uri;
  review.showFile(file);
  const document = new Document(panel.webview.html);
  const posted: Message[] = [];
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panel.webview.html)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document,
    window: { addEventListener: (type: string, handler: Handler) => {
      assert.equal(type, 'message');
      deliver = message => handler({ data: message });
    } },
    acquireVsCodeApi: () => ({ postMessage: (message: Message) => posted.push(message) }),
  });
  const receive = (message: Message) => (review as unknown as {
    receive(message: unknown, originatingPanel: unknown): Promise<void>;
  }).receive(message, panel);
  return {
    review, file, thread, key, sent, posted, document, receive, replies,
    approveDelete: (value: boolean) => { deleteApproved = value; },
    deliver: (message: Message) => deliver!(message),
    fail: (error: Error) => { failure = error; },
    byId: (id: string) => document.getElementById(id),
    ready: () => receive(posted[0]),
    lastRequest: () => posted[posted.length - 1],
    comment: (index = 0) => {
      const article = document.getElementById('comments').children[index];
      const all = descendants(article);
      return {
        input: all.find(element => element.tagName === 'textarea')!,
        edit: all.find(element => element.textContent === 'Edit')!,
        save: all.find(element => element.textContent === 'Save changes')!,
        remove: all.find(element => element.textContent === 'Delete Comment')!,
        cancel: all.find(element => element.textContent === 'Cancel')!,
      };
    },
  };
}

test('opening waits for ready then focuses once; repeated opens preserve the active caret', async () => {
  const h = harness();
  assert.equal(h.sent.length, 0);
  assert.equal(h.byId('body').focusCount, 0);
  await h.ready();
  const input = h.byId('body');
  assert.equal(h.document.activeElement, input);
  assert.equal(input.focusCount, 1);
  input.value = 'draft text';
  input.selectionStart = 2;
  input.selectionEnd = 6;
  input.emit('input');
  h.review.showFile(h.file);
  h.review.refresh();
  assert.equal(input.focusCount, 1);
  assert.equal(input.value, 'draft text');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 6);
  h.document.focused = false;
  h.review.showFile(h.file);
  assert.equal(input.focusCount, 2, 'explicit open refocuses a webview whose retained activeElement lost document focus');
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 6);
  h.review.refresh();
  assert.equal(h.byId('draft-status').hidden, false);
  assert.match(h.byId('draft-status').textContent, /only while this panel stays open/);
  const explicit = [...h.sent].reverse().find(message => message.focus)!;
  h.byId('submit-button').focus();
  h.deliver(explicit);
  assert.equal(h.document.activeElement, h.byId('submit-button'), 'a repeated focus sequence is ignored');
  h.review.refresh();
  await h.ready();
  assert.equal(h.document.activeElement, h.byId('submit-button'), 'refresh/duplicate ready never refocus');
});

test('quick preview focuses the readable discussion and unchanged refresh sends no payload', async () => {
  const h = harness();
  await h.ready();
  h.review.showThread(h.thread, h.key, { read: true });
  assert.equal(h.document.activeElement, h.byId('comments-section'));
  assert.equal(h.byId('source-button').hidden, false);
  assert.equal(h.byId('body').value, '');
  const count = h.sent.length;
  for (let i = 0; i < 100; i++) h.review.refresh();
  assert.equal(h.sent.length, count, '100 unchanged refreshes do not reset text selection or transfer discussion payload');
  assert.equal(h.document.activeElement, h.byId('comments-section'));
  h.thread.comments[0].body = 'Updated discussion';
  h.review.refresh();
  assert.equal(h.sent.length, count + 1, 'changed text still reaches the preview');
  assert.equal(h.document.activeElement, h.byId('comments-section'));
});

test('incoming comments do not steal focus; navigation restores drafts and original edit baseline', async () => {
  const h = harness();
  await h.ready();
  h.review.showThread(h.thread, h.key);
  const editor = h.comment();
  editor.edit.emit('click');
  editor.input.value = 'Unsaved edit';
  editor.input.emit('input');
  const original = { body: h.thread.comments[0].body, updatedAt: h.thread.comments[0].updatedAt };
  h.byId('body').value = 'Unsaved reply';
  h.byId('body').emit('input');
  editor.input.selectionStart = 3;
  h.thread.comments[0].body = 'Changed externally';
  h.thread.comments[0].updatedAt = '2026-10-04T05:00:00.000Z';
  h.thread.comments.push({ ...h.thread.comments[0], id: 'incoming', body: 'Incoming comment' });
  h.review.refresh();
  assert.equal(h.document.activeElement, editor.input);
  assert.equal(editor.input.focusCount, 1);
  assert.equal(editor.input.selectionStart, 3);
  assert.equal(editor.input.value, 'Unsaved edit');
  h.byId('copy-button').focus();
  h.review.refresh();
  assert.equal(h.document.activeElement, h.byId('copy-button'));
  h.review.showThread(h.thread, h.key);
  assert.equal(h.document.activeElement, editor.input, 'explicit open prefers an existing edit');
  h.byId('body').focus();
  h.byId('body').selectionStart = 4;
  h.review.showThread(h.thread, h.key);
  assert.equal(h.document.activeElement, h.byId('body'), 'an already active composer takes precedence');
  assert.equal(h.byId('body').selectionStart, 4);
  h.review.showFile(h.file);
  assert.match(h.byId('draft-status').textContent, /other reviews/);
  h.review.showThread(h.thread, h.key);
  const restored = h.comment();
  assert.equal(h.document.activeElement, restored.input);
  assert.equal(restored.input.value, 'Unsaved edit');
  assert.equal(h.byId('body').value, 'Unsaved reply');
  restored.save.emit('click');
  assert.equal(h.lastRequest().baseline.body, original.body);
  assert.equal(h.lastRequest().baseline.updatedAt, original.updatedAt);
  h.fail(new Error('Changed externally. Reopen the editor.'));
  restored.save.focus();
  await h.receive(h.lastRequest());
  assert.equal(h.document.activeElement, restored.input);
  assert.equal(restored.input.value, 'Unsaved edit');
});

test('removed-comment edits remain recoverable after navigation', async () => {
  const h = harness();
  await h.ready();
  h.review.showThread(h.thread, h.key);
  h.comment().edit.emit('click');
  h.comment().input.value = 'Keep this edit';
  h.comment().input.emit('input');
  h.review.showFile(h.file);
  h.thread.comments = [];
  h.review.showThread(h.thread, h.key);
  assert.equal(h.comment().input.value, 'Keep this edit');
  assert.equal(h.comment().input.readOnly, true);
  assert.equal(h.comment().save.disabled, true);
});

test('create/reply completion returns focus once after unlocking; errors retain draft', async () => {
  const h = harness();
  await h.ready();
  const input = h.byId('body');
  const submit = h.byId('submit-button');
  input.value = 'New review';
  input.emit('input');
  submit.focus();
  submit.emit('click');
  const before = input.focusCount;
  await h.receive(h.lastRequest());
  assert.equal(h.document.activeElement, input);
  assert.equal(input.focusCount, before + 1);
  assert.equal(input.readOnly, false);
  assert.equal(input.value, '');
  input.value = 'A reply';
  input.emit('input');
  submit.focus();
  submit.emit('click');
  await h.receive(h.lastRequest());
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, '');
  input.value = 'Retry me';
  input.emit('input');
  h.fail(new Error('Cannot save'));
  submit.focus();
  submit.emit('click');
  await h.receive(h.lastRequest());
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, 'Retry me');
  assert.equal(h.byId('error').textContent, 'Cannot save');
});

test('late submission results for another view do not steal focus or surface unrelated errors', async () => {
  const h = harness();
  await h.ready();
  h.review.showThread(h.thread, h.key);
  h.byId('body').value = 'Pending reply';
  h.byId('body').emit('input');
  h.byId('submit-button').emit('click');
  const request = h.lastRequest();
  h.review.showFile(h.file);
  h.document.main.focus();
  h.deliver({ type: 'error', requestId: request.requestId, viewId: request.viewId, message: 'Old error', busy: false });
  assert.equal(h.document.activeElement, h.document.main);
  assert.equal(h.byId('error').hidden, true);
});

test('Ctrl/Cmd+Enter submits but plain Enter and IME composition never do', async () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const h = harness();
    await h.ready();
    const input = h.byId('body');
    input.value = 'Composition draft';
    input.emit('input');
    assert.equal(input.emit('keydown', { key: 'Enter' }).defaultPrevented, false);
    assert.equal(input.emit('keydown', { key: 'Enter', [modifier]: true, isComposing: true }).defaultPrevented, false);
    assert.equal(input.emit('keydown', { key: 'Enter', [modifier]: true, keyCode: 229 }).defaultPrevented, false);
    input.emit('compositionstart');
    assert.equal(input.emit('keydown', { key: 'Enter', [modifier]: true }).defaultPrevented, false);
    input.emit('compositionend');
    assert.equal(h.posted.length, 1, 'only ready was sent');
    assert.equal(input.emit('keydown', { key: 'Enter', [modifier]: true }).defaultPrevented, true);
    assert.equal(h.lastRequest().command, 'create');
    assert.equal(h.lastRequest().body, 'Composition draft');
  }
});
