import * as vscode from 'vscode';
import { Reviews } from './reviews';
import { InlineReviews } from './inline';
import { ReviewTree, ReviewItem } from './tree';
import { ReviewPanel } from './panel';
import { ReviewNavigation } from './navigation';
import { ReviewToolbar } from './toolbar';
import { ReviewHighlights } from './highlights';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const reviews = new Reviews();
  context.subscriptions.push(reviews);
  await reviews.initialize();
  const inline = new InlineReviews(reviews, context.extension.id);
  const tree = new ReviewTree(reviews);
  const view = vscode.window.createTreeView('reviewComments.list', { treeDataProvider: tree, showCollapseAll: true });
  const panel = new ReviewPanel(context, {
    create: async (uri, body) => {
      const thread = await reviews.add(uri, body);
      return { thread, key: reviews.keyFor(uri, thread.id) };
    },
    reply: (id, body, status) => reviews.reply(id, body, status),
    deleteComment: (id, commentId) => reviews.deleteComment(id, commentId),
    edit: (id, commentId, body, baseline) => reviews.edit(id, commentId, body, baseline),
    setStatus: (id, status) => reviews.setStatus(id, status),
    remove: id => reviews.remove(id),
    copy: id => reviews.copy([reviews.require(id)], undefined, 'Selected thread'),
    getThread: id => { const ref = reviews.find(id); return ref ? reviews.view(ref) : undefined; },
    openSource: async id => {
      const ref = reviews.require(id);
      highlights.setActive(reviews.key(ref));
      if (ref.data.anchor.kind === 'text') {
        if (!await inline.reveal(id)) throw new Error('The inline thread could not be opened. Finish drafts in the old file, then try again.');
      } else { await vscode.commands.executeCommand('vscode.open', reviews.uri(ref)); }
    }
  });
  const toolbar = new ReviewToolbar(reviews, view);
  const highlights = new ReviewHighlights(reviews);
  context.subscriptions.push(toolbar, highlights);
  context.subscriptions.push(inline, tree, view, panel,
    reviews.onDidChange(() => panel.refresh()),
    reviews.onDidChangeData(() => updateViewDescription()));
  function updateViewDescription(): void {
    const count = reviews.all().filter(ref => ref.data.status === 'open').length;
    view.description = `${count} open total · ${tree.description}`;
  }

  const register = (name: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(`reviewComments.${name}`, async (...args: any[]) => {
      try { return await handler(...args); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reviews.output.appendLine(message);
        void vscode.window.showErrorMessage(`Review Comments: ${message}`);
        // Reject failed saves so the native comment editor does not treat a failure as a submission.
        throw error;
      }
    }));
  };
  const getId = async (arg?: unknown): Promise<string | undefined> => {
    const id = inline.id(arg);
    if (id) { return id; }
    const selected = await vscode.window.showQuickPick(reviews.all().map(ref => ({
      label: ref.data.comments[0].body.replace(/\s+/g, ' ').slice(0, 120),
      description: `${ref.folder.folder.name}/${ref.data.resource.path} · ${ref.data.status}`, id: reviews.key(ref)
    })), { placeHolder: 'Choose a review thread', matchOnDescription: true });
    return selected?.id;
  };
  const withId = (handler: (id: string) => unknown) => async (arg?: unknown) => { const id = await getId(arg); if (id) { await handler(id); } };

  register('add', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) { await inline.add(editor); }
    else { const uri = await pickUri(); if (uri) { panel.showFile(uri); } }
  });
  register('addFile', async (arg?: vscode.Uri | ReviewItem) => { const uri = await pickUri(arg); if (uri) { panel.showFile(uri); } });
  register('submit', (reply: vscode.CommentReply) => inline.submit(reply));
  register('replyResolve', (reply: vscode.CommentReply) => inline.submit(reply, 'resolved'));
  register('replyReopen', (reply: vscode.CommentReply) => inline.submit(reply, 'open'));
  register('cancel', (arg: vscode.CommentThread | vscode.CommentReply) => inline.cancel(arg));
  register('edit', (arg: any) => inline.edit(arg));
  register('saveEdit', (arg: any) => inline.saveEdit(arg));
  register('cancelEdit', (arg: any) => inline.cancelEdit(arg));
  register('deleteComment', (arg: any) => inline.deleteComment(arg));
  register('resolve', withId(id => reviews.setStatus(id, 'resolved')));
  register('reopen', withId(id => reviews.setStatus(id, 'open')));
  register('delete', withId(id => reviews.remove(id)));
  register('copy', withId(id => reviews.copy([reviews.require(id)], undefined, 'Selected thread')));
  register('copyAll', () => reviews.copy(reviews.all(), undefined, 'All comments'));
  register('copyOpen', () => reviews.copy(reviews.all().filter(ref => ref.data.status === 'open'), undefined, 'Open comments'));
  register('copyJson', () => reviews.copy(reviews.all(), 'json'));
  const fileRefs = (uri: vscode.Uri) => reviews.all().filter(ref => reviews.uri(ref).toString() === uri.toString());
  register('copyFile', async (arg?: vscode.Uri | ReviewItem) => {
    const uri = await pickUri(arg);
    if (uri) { await reviews.copy(fileRefs(uri), undefined, 'Comments in this file'); }
  });
  register('copyFileOpen', async (arg?: vscode.Uri | ReviewItem) => {
    const uri = await pickUri(arg);
    if (uri) { await reviews.copy(fileRefs(uri).filter(ref => ref.data.status === 'open'), undefined, 'Open comments in this file'); }
  });
  register('copyFileResolved', async (arg?: vscode.Uri | ReviewItem) => {
    const uri = await pickUri(arg);
    if (uri) { await reviews.copy(fileRefs(uri).filter(ref => ref.data.status === 'resolved'), undefined, 'Resolved comments in this file'); }
  });
  register('copyFileJson', async (arg?: vscode.Uri | ReviewItem) => {
    const uri = await pickUri(arg);
    if (uri) { await reviews.copy(fileRefs(uri), 'json', 'Comments in this file'); }
  });
  register('openFile', async (arg?: vscode.Uri | ReviewItem) => {
    const uri = await pickUri(arg);
    if (uri) { await vscode.commands.executeCommand('vscode.open', uri); }
  });
  const openReview = async (id: string): Promise<void> => {
    const ref = reviews.require(id);
    highlights.setActive(reviews.key(ref));
    try { if (await inline.reveal(id)) { return; } } catch { /* Preserve access to notes for deleted/unreadable source files. */ }
    panel.showThread(reviews.view(ref), reviews.key(ref));
  };
  const navigation = new ReviewNavigation(reviews, openReview);
  register('show', withId(async id => { navigation.reset(); await openReview(id); }));
  register('preview', withId(id => {
    const ref = reviews.require(id);
    highlights.setActive(reviews.key(ref));
    panel.showThread(reviews.view(ref), reviews.key(ref), { read: true });
  }));
  register('collapseInline', () => inline.collapseAll());
  register('nextOpen', () => navigation.move(1));
  register('previousOpen', () => navigation.move(-1));
  register('reanchor', withId(async id => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { throw new Error('Select the replacement source text in an editor first.'); }
    await reviews.reanchor(id, editor);
  }));
  register('quickActions', () => toolbar.quickActions());
  register('filter', async () => { await tree.chooseFilter(); updateViewDescription(); });
  register('search', async () => { await tree.search(); updateViewDescription(); });
  register('clearFilters', () => { tree.clearFilters(); updateViewDescription(); });
  register('refresh', () => reviews.refresh());
  register('openStorage', () => reviews.openStorage());
  register('clearResolved', async () => {
    const resolved = reviews.all().filter(ref => ref.data.status === 'resolved')
      .map(ref => ({ key: reviews.key(ref), revision: ref.data.revision }));
    if (!resolved.length) { void vscode.window.showInformationMessage('No resolved threads to delete.'); return; }
    if (await vscode.window.showWarningMessage(`Delete ${resolved.length} resolved threads and all their replies across the workspace? Sidebar filters do not apply. This cannot be undone.`, { modal: true }, 'Delete') !== 'Delete') { return; }
    let skipped = 0;
    for (const item of resolved) {
      try { await reviews.remove(item.key, false, { revision: item.revision, status: 'resolved' }); }
      catch (error) { skipped++; reviews.output.appendLine(String(error)); }
    }
    if (skipped) { void vscode.window.showWarningMessage(`${skipped} thread(s) were not deleted because they changed or a deletion failed. Check them again. For details, open Output and select Review Comments.`); }
  });
  register('export', async () => {
    const scope = await vscode.window.showQuickPick(['All comments', 'Open comments'], { placeHolder: 'Choose comments to export' });
    if (!scope) { return; }
    const format = await vscode.window.showQuickPick(['Markdown', 'JSON'], { placeHolder: 'Choose export format' });
    if (!format) { return; }
    const refs = reviews.all().filter(ref => scope === 'All comments' || ref.data.status === 'open');
    if (!refs.length) { void vscode.window.showInformationMessage('No comments to export.'); return; }
    const ext = format === 'JSON' ? 'json' : 'md';
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const destination = await vscode.window.showSaveDialog({ title: 'Export Comments', defaultUri: root ? vscode.Uri.joinPath(root, `review-comments.${ext}`) : undefined, filters: { [format]: [ext] } });
    if (!destination) { return; }
    if (!destination.path.endsWith(`.${ext}`) || destination.path.includes('/.review-comments/')) { throw new Error(`Choose a .${ext} export file outside the review storage directory.`); }
    if (reviews.all().some(ref => reviews.uri(ref).toString() === destination.toString())) { throw new Error('An export must not overwrite a reviewed source file.'); }
    await vscode.workspace.fs.writeFile(destination, Buffer.from(await reviews.formatForCopy(refs, ext === 'json' ? 'json' : 'markdown', scope), 'utf8'));
    await vscode.window.showTextDocument(destination, { preview: false });
  });
  updateViewDescription();
}

async function pickUri(argument?: vscode.Uri | ReviewItem): Promise<vscode.Uri | undefined> {
  if (argument instanceof vscode.Uri) { return argument; }
  // A tree group is not the active editor. Never fall back to another file for
  // an explicit node, even when its visible refs are filtered or out of date.
  if (argument !== undefined) {
    if (argument.kind === 'file' && argument.resourceUri instanceof vscode.Uri) { return argument.resourceUri; }
    throw new Error('Choose a file group in the Comments sidebar or a file in the Explorer.');
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) { return input.uri; }
  if (input instanceof vscode.TabInputTextDiff) { return input.modified; }
  const selected = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: 'Choose a file to review' });
  return selected?.[0];
}

export function deactivate(): void {}
