import * as vscode from 'vscode';
import { Reviews, selectionRange } from './reviews';
import { ReviewComment } from './core/model';

interface InlineComment extends vscode.Comment {
  reviewId: string;
  commentId: string;
  savedBody: string;
  savedUpdatedAt: string;
}

export class InlineReviews implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('reviewComments', 'Review Comments');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly pending = new WeakSet<vscode.CommentThread>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly persisted = new WeakMap<vscode.CommentThread, { comments: readonly ReviewComment[]; signature: string }>();
  private readonly emptyComments: readonly ReviewComment[] = [];
  private readonly drafts = new Set<vscode.CommentThread>();
  private adding = false;

  constructor(private readonly reviews: Reviews, private readonly extensionId: string) {
    this.controller.options = { prompt: 'Write a review comment', placeHolder: process.platform === 'darwin' ? 'Write a comment · ⌘Enter to save · Enter for a new line' : 'Write a comment · Ctrl+Enter to save · Enter for a new line' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        if (!this.isSourceDocument(document)) { return []; }
        return [new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)];
      }
    };
    this.subscriptions.push(
      reviews.onDidChange(() => this.sync()),
      vscode.workspace.onDidOpenTextDocument(document => {
        if (this.isSourceDocument(document)) { this.sync(); }
      }),
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        if (editors.some(editor => this.isSourceDocument(editor.document))) { this.sync(); }
      })
    );
    this.sync();
  }

  private isSourceDocument(document: vscode.TextDocument): boolean {
    return !document.isUntitled && ['file', 'vscode-remote'].includes(document.uri.scheme)
      && !document.uri.path.split('/').includes('.review-comments') && !!this.reviews.folderFor(document.uri);
  }

  id(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
      const ref = this.reviews.find(arg);
      // Deleted threads can still own visible drafts; commands must fail for that
      // scoped key rather than accidentally selecting a different review.
      return ref ? this.reviews.key(ref) : this.threads.has(arg) ? arg : undefined;
    }
    if (!arg || typeof arg !== 'object') { return undefined; }
    const object = arg as { id?: string; reviewId?: string; thread?: vscode.CommentThread; comment?: InlineComment };
    return this.ids.get(arg as vscode.CommentThread) ?? (object.thread ? this.ids.get(object.thread) : undefined)
      ?? (object.comment ? this.id(object.comment) : undefined)
      ?? (object.reviewId ? this.id(object.reviewId) : undefined) ?? (object.id ? this.id(object.id) : undefined);
  }

  private comment(data: ReviewComment, id: string): InlineComment {
    // Plain strings, rather than trusted Markdown, prevent comment text from running commands.
    return { reviewId: id, commentId: data.id, savedBody: data.body, savedUpdatedAt: data.updatedAt, body: data.body,
      author: { name: data.author }, mode: vscode.CommentMode.Preview,
      contextValue: 'reviewComments.comment', timestamp: new Date(data.createdAt) };
  }

  private hasEdits(thread: vscode.CommentThread): boolean {
    return thread.comments.some(comment => comment.mode === vscode.CommentMode.Editing);
  }

  private commentsSignature(data: readonly ReviewComment[]): string {
    // Compare only persisted fields displayed by native comments, not unrelated metadata.
    return JSON.stringify(data.map(item => [item.id, item.body, item.author, item.createdAt, item.updatedAt]));
  }

  private syncComments(thread: vscode.CommentThread, data: readonly ReviewComment[], id: string, finished?: InlineComment): void {
    const previous = this.persisted.get(thread);
    // Reviews preserves array identity for unchanged persisted comments. Native editing
    // objects are deliberately separate and must not become the comparison baseline.
    if (!finished && previous?.comments === data) { return; }
    const signature = this.commentsSignature(data);
    if (finished || previous?.signature !== signature) { this.compose(thread, data, id, finished); }
    this.persisted.set(thread, { comments: data, signature });
  }

  private compose(thread: vscode.CommentThread, data: readonly ReviewComment[], id: string, finished?: InlineComment): void {
    const previous = thread.comments as readonly InlineComment[];
    const current = new Map(previous.map(comment => [comment.commentId, comment]));
    let labelsChanged = false;
    const mark = (comment: InlineComment, label: string | undefined): InlineComment => {
      if (comment.label !== label) { comment.label = label; labelsChanged = true; }
      return comment;
    };
    const comments = data.map(item => {
      const existing = current.get(item.id);
      current.delete(item.id);
      // Keep the actual editing object: the native editor can hold unsent input
      // which has not yet been reflected in its body property.
      if (existing && existing !== finished && existing.mode === vscode.CommentMode.Editing) {
        return mark(existing, undefined);
      }
      if (existing && existing !== finished && existing.savedBody === item.body && existing.savedUpdatedAt === item.updatedAt
          && existing.author.name === item.author && existing.timestamp?.getTime() === new Date(item.createdAt).getTime()) {
        return existing;
      }
      return this.comment(item, id);
    });
    // A deleted comment must not silently discard an active draft or be recreated
    // on save. Keep it available to copy/cancel while Reviews rejects the save.
    for (const comment of current.values()) {
      if (comment !== finished && comment.mode === vscode.CommentMode.Editing) {
        comments.push(mark(comment, 'Comment unavailable — copy your draft before choosing Cancel'));
      }
    }
    if (labelsChanged || comments.length !== previous.length || comments.some((comment, index) => comment !== previous[index])) {
      thread.comments = comments;
    }
  }

  private finishEdit(comment: InlineComment): void {
    const thread = this.threads.get(comment.reviewId);
    if (!thread) { return; }
    const ref = this.reviews.find(comment.reviewId);
    this.syncComments(thread, ref?.data.comments ?? this.emptyComments, comment.reviewId, comment);
    this.sync();
  }

  sync(): void {
    const documents = new Map<string, vscode.TextDocument>();
    for (const document of [...vscode.workspace.textDocuments, ...vscode.window.visibleTextEditors.map(editor => editor.document)]) {
      if (this.isSourceDocument(document)) { documents.set(document.uri.toString(), document); }
    }
    const active = new Set<string>();
    for (const ref of this.reviews.all()) {
      // File-level notes use the review panel; native file threads need newer editor APIs.
      if (ref.data.anchor.kind === 'file') { continue; }
      const id = this.reviews.key(ref);
      const uri = this.reviews.uri(ref);
      const uriKey = uri.toString();
      active.add(id);
      let thread = this.threads.get(id);
      const document = documents.get(uriKey);
      // Never create native widgets (or calculate live anchors) for unopened sources.
      // Existing widgets are not viewport-virtualized: the native reply draft is opaque.
      if (!thread && !document) { continue; }
      if (thread && thread.uri.toString() !== uriKey && !documents.has(thread.uri.toString())
          && thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded
          && !this.hasEdits(thread) && !this.pending.has(thread)) {
        thread.dispose(); this.threads.delete(id); thread = undefined;
        if (!document) { continue; }
      }
      const data = this.reviews.view(ref);
      if (data.anchor.kind !== 'text') { continue; }
      let range = new vscode.Range(data.anchor.range.start.line, data.anchor.range.start.character, data.anchor.range.end.line, data.anchor.range.end.character);
      if (document) { range = document.validateRange(range); }
      if (!thread) {
        thread = this.controller.createCommentThread(uri, range, data.comments.map(comment => this.comment(comment, id)));
        if (thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Collapsed) {
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        }
        this.threads.set(id, thread);
        this.ids.set(thread, id);
        this.persisted.set(thread, { comments: data.comments, signature: this.commentsSignature(data.comments) });
      } else {
        // The URI is immutable. Retain open/expanded/editing widgets on moves too.
        if (thread.uri.toString() === uriKey && !thread.range.isEqual(range)) { thread.range = range; }
        this.syncComments(thread, data.comments, id);
      }
      const context = `reviewComments.${data.status}`;
      const state = data.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      const label = `Review · ${data.status}${data.anchor.stale ? ' · Location unverified — saved excerpt retained' : ''}${thread.uri.toString() !== uriKey ? ' · Source moved — save or cancel drafts, collapse this thread, then close the old file to relocate it' : ''}`;
      if (thread.contextValue !== context) { thread.contextValue = context; }
      if (thread.state !== state) { thread.state = state; }
      if (thread.label !== label) { thread.label = label; }
      if (thread.canReply !== true) { thread.canReply = true; }
    }
    for (const [id, thread] of this.threads) {
      if (active.has(id)) { continue; }
      if (this.hasEdits(thread)) {
        this.syncComments(thread, this.emptyComments, id);
        if (thread.contextValue !== 'reviewComments.unavailable') { thread.contextValue = 'reviewComments.unavailable'; }
        const label = 'Thread unavailable — copy unsaved edits before choosing Cancel';
        if (thread.label !== label) { thread.label = label; }
        if (thread.canReply !== false) { thread.canReply = false; }
      } else { thread.dispose(); this.threads.delete(id); }
    }
  }

  async add(editor: vscode.TextEditor): Promise<void> {
    if (editor.document.uri.path.split('/').includes('.review-comments')) { throw new Error('Review storage cannot itself be annotated.'); }
    if (!this.isSourceDocument(editor.document)) { throw new Error('Save this file inside an open workspace folder, then try again.'); }
    if (this.adding) { return; }
    this.sync();
    this.adding = true;
    const range = selectionRange(editor);
    const sourceUri = editor.document.uri.toString();
    const requestedSelection = new vscode.Selection(range.start, range.end);
    let cancelled = false;
    const watchSelection = vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor === editor && !event.selections[0]?.isEqual(requestedSelection)) { cancelled = true; }
    });
    try {
      editor.selection = requestedSelection;
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      const existing = [...this.threads.values(), ...this.drafts].find(thread => thread.uri.toString() === sourceUri
        && thread.range.end.line === range.end.line);
      // Creating our own thread avoids provider pickers and works even before native
      // commenting ranges finish loading. Focus is requested only after its input exists.
      const priorInputs = new Set(vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'comment').map(doc => doc.uri.toString()));
      let thread = existing;
      if (!thread) {
        thread = this.controller.createCommentThread(editor.document.uri, range, []);
        thread.contextValue = 'reviewComments.draft';
        thread.label = 'New review';
        thread.canReply = true;
        this.drafts.add(thread);
      }
      if (thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
      if (!existing) {
        const isNewInput = (doc: vscode.TextDocument) => doc.uri.scheme === 'comment'
          && doc.uri.path.toLowerCase().includes(this.extensionId.toLowerCase()) && !priorInputs.has(doc.uri.toString());
        if (!vscode.workspace.textDocuments.some(isNewInput)) {
          await new Promise<void>((resolve, reject) => {
            const listener = vscode.workspace.onDidOpenTextDocument(doc => {
              if (!isNewInput(doc)) { return; }
              clearTimeout(timeout); listener.dispose(); resolve();
            });
            const timeout = setTimeout(() => {
              listener.dispose(); reject(new Error('The comment input did not open. Try Add Comment again.'));
            }, 8000);
          });
        }
      }
      // One event-driven focus request, not a delayed retry loop. Never follow the
      // user to another source editor or move their new selection back.
      const active = vscode.window.activeTextEditor;
      if (cancelled || (active && active.document.uri.toString() !== sourceUri && active.document.uri.scheme !== 'comment')) { return; }
      await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
      await vscode.commands.executeCommand('widgetNavigation.focusNext');
    } finally { watchSelection.dispose(); this.adding = false; }
  }

  async submit(reply: vscode.CommentReply, status?: 'open' | 'resolved'): Promise<void> {
    if (!reply?.thread || typeof reply.text !== 'string') { return; }
    const thread = reply.thread;
    if (this.pending.has(thread)) { return; }
    if (!reply.text.trim()) { throw new Error('The comment cannot be empty.'); }
    this.pending.add(thread);
    try {
      const id = this.ids.get(thread);
      if (id) { await this.reviews.reply(id, reply.text, status); }
      else {
        if (status !== undefined) throw new Error('Save the first comment before using a reply-and-status action.');
        const data = await this.reviews.add(thread.uri, reply.text, thread.range);
        const savedId = this.reviews.keyFor(thread.uri, data.id);
        let saved = this.threads.get(savedId);
        if (!saved) {
          // The source may have closed while persistence was pending. Adopt the
          // existing input instead of disposing it before a saved widget exists.
          saved = thread;
          this.threads.set(savedId, thread);
          this.ids.set(thread, savedId);
        }
        this.drafts.delete(thread);
        this.sync();
        if (saved !== thread) { thread.dispose(); }
        if (saved.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
          saved.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        }
      }
    } finally { this.pending.delete(thread); }
  }

  cancel(arg: vscode.CommentThread | vscode.CommentReply): void {
    const thread = 'thread' in arg ? arg.thread : arg;
    if (!this.ids.has(thread)) { this.drafts.delete(thread); thread.dispose(); }
  }

  private unpack(arg: InlineComment | { comment: InlineComment }): InlineComment {
    return 'comment' in arg ? arg.comment : arg;
  }

  edit(arg: InlineComment | { comment: InlineComment }): void {
    const comment = this.unpack(arg);
    const thread = this.threads.get(comment.reviewId);
    if (!thread) { return; }
    // The command's displayed comment supplies the baseline, not a fresh read
    // which could silently authorize overwriting a change the user never saw.
    const previous = thread.comments as readonly InlineComment[];
    const comments = previous.map(item => item.commentId === comment.commentId && item.mode !== vscode.CommentMode.Editing
      ? { ...comment, mode: vscode.CommentMode.Editing } : item);
    if (comments.some((item, index) => item !== previous[index])) { thread.comments = comments; }
  }

  async saveEdit(arg: InlineComment | { comment: InlineComment }): Promise<void> {
    const comment = this.unpack(arg);
    const body = typeof comment.body === 'string' ? comment.body : comment.body.value;
    await this.reviews.edit(comment.reviewId, comment.commentId, body, {
      body: comment.savedBody, updatedAt: comment.savedUpdatedAt
    });
    // A rejected save deliberately leaves the same editing object and baseline.
    this.finishEdit(comment);
  }

  cancelEdit(arg: InlineComment | { comment: InlineComment }): void {
    this.finishEdit(this.unpack(arg));
  }

  async deleteComment(arg: InlineComment | { comment: InlineComment }): Promise<void> {
    const comment = this.unpack(arg);
    await this.reviews.deleteComment(comment.reviewId, comment.commentId);
  }

  collapseAll(): void {
    // An explicit collapse keeps saved native widgets (and their reply inputs) alive.
    // Empty drafts and active edits must not be hidden or disposed by this command.
    for (const thread of this.threads.values()) {
      if (thread.comments.length && !this.hasEdits(thread) && !this.pending.has(thread)
          && thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Collapsed) {
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      }
    }
  }

  async reveal(id: string): Promise<boolean> {
    const ref = this.reviews.require(id);
    if (ref.data.anchor.kind !== 'text') { return false; }
    const document = await vscode.workspace.openTextDocument(this.reviews.uri(ref));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    this.sync();
    const thread = this.threads.get(this.reviews.key(ref));
    // A renamed source may still have drafts attached to its old native thread.
    // Let the review panel handle that case rather than reveal the wrong range.
    if (!thread || thread.uri.toString() !== document.uri.toString()) { return false; }
    if (thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    editor.selection = new vscode.Selection(thread.range.start, thread.range.end);
    editor.revealRange(thread.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    for (const draft of this.drafts) { draft.dispose(); }
    this.controller.dispose();
  }
}
