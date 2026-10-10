import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Reviews } from '../src/reviews';
import { InlineReviews } from '../src/inline';
import { ReviewTree } from '../src/tree';
import { ReviewPanel } from '../src/panel';
import { ThreadRepository } from '../src/core/storage';
export async function run(): Promise<void> {
  const root = process.env.REVIEW_COMMENTS_TEST_ROOT;
  assert.ok(root, 'Tests require a disposable workspace');
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'Extension is discoverable');
  assert.equal(extension.packageJSON.version, manifest.version, 'Test the intended release version');
  if (process.env.REVIEW_COMMENTS_EXTENSION_PATH) {
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(normalize(extension.extensionPath),
      normalize(process.env.REVIEW_COMMENTS_EXTENSION_PATH), 'Load the requested packaged extension');
  }
  console.log(`Testing ${extension.id}@${extension.packageJSON.version} on VS Code ${vscode.version} from ${extension.extensionPath}`);
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['add', 'addFile', 'copyAll', 'copyOpen', 'copyJson', 'copyFileOpen', 'quickActions', 'preview', 'collapseInline', 'resolve', 'reopen', 'delete', 'export', 'nextOpen', 'previousOpen', 'search', 'clearFilters']) {
    assert.ok(commands.includes(`reviewComments.${command}`), `Command registered: ${command}`);
  }
  await runNativeFocusRegression(root);
  const reviews = new Reviews();
  await reviews.initialize();
  const inline = new InlineReviews(reviews, extension.id);
  try {
    const source = '\\section{Introduction}\nĐoạn cần nhận xét.\nUnchanged line.\n';
    const file = path.join(root, 'bản thảo.tex');
    await fs.writeFile(file, source);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 0, 1, 'Đoạn cần nhận xét.'.length);
    const thread = await reviews.add(document.uri, 'Làm rõ giả thiết.', editor.selection);
    assert.equal(thread.anchor.kind, 'text');
    if (thread.anchor.kind === 'text') {
      assert.deepEqual(thread.anchor.range.start, { line: 1, character: 0 });
      assert.equal(thread.anchor.snapshot, 'Đoạn cần nhận xét.');
    }
    assert.equal(await fs.readFile(file, 'utf8'), source, 'Adding review does not modify source');
    const ref = reviews.require(thread.id);
    reviews.view(ref);
    const beforeCached = reviews.diagnostics();
    for (let i = 0; i < 1000; i++) { assert.equal(reviews.require(reviews.key(ref)), ref); reviews.view(ref); }
    const afterCached = reviews.diagnostics();
    assert.equal(afterCached.viewComputations, beforeCached.viewComputations, 'Repeated consumers reuse one relocated view');
    assert.equal(afterCached.sourceReads, beforeCached.sourceReads, 'Repeated consumers never reread the unchanged source');
    console.log('Cache integration passed: 1000 repeated lookup/view calls perform zero source reads or relocations.');
    await reviews.reply(thread.id, 'Thêm một phản hồi.');
    await reviews.edit(thread.id, thread.comments[0].id, 'Làm rõ giả thiết trước định lý.', thread.comments[0]);
    await reviews.setStatus(thread.id, 'resolved');
    assert.equal(reviews.require(thread.id).data.comments.length, 2);
    assert.equal(reviews.require(thread.id).data.status, 'resolved');
    await reviews.setStatus(thread.id, 'open');
    await assertHighlights(document, thread.id);
    inline.sync();
    assert.equal(await inline.reveal(thread.id), true, 'Native thread created and revealed');
    // Exercise the comment bridge separately from native focus (tested on a fresh file below).
    const controller = (inline as unknown as { controller: vscode.CommentController }).controller;
    const draft = controller.createCommentThread(editor.document.uri, editor.selection, []);
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await inline.submit({ thread: draft, text: 'Native draft comment.' });
    const nativeReview = reviews.all().find(ref => ref.data.comments[0].body === 'Native draft comment.')!;
    assert.ok(nativeReview);
    const nativeThread = (inline as unknown as { threads: Map<string, vscode.CommentThread> }).threads.get(reviews.key(nativeReview))!;
    await inline.submit({ thread: nativeThread, text: 'Native reply.' });
    const nativeComment = nativeThread.comments[0] as any;
    inline.edit(nativeComment);
    const editingComment = nativeThread.comments[0] as any;
    assert.equal(editingComment.mode, vscode.CommentMode.Editing);
    editingComment.body = 'Updated native comment.';
    await inline.saveEdit(editingComment);
    assert.equal(reviews.require(nativeReview.data.id).data.comments[0].body, 'Updated native comment.');
    await runSafetyRegressions(reviews, inline, nativeReview.data.id, nativeThread, root);
    await reviews.remove(nativeReview.data.id, false);
    const bytes = Buffer.from([0, 255, 0, 13, 10, 17]);
    const binary = path.join(root, 'sample.pdf');
    await fs.writeFile(binary, bytes);
    const fileThread = await reviews.add(vscode.Uri.file(binary), 'Review the diagram on page 2.');
    assert.equal(fileThread.anchor.kind, 'file');
    assert.deepEqual(await fs.readFile(binary), bytes, 'File-level notes do not modify binary bytes');
    await reviews.setStatus(fileThread.id, 'resolved');
    const markdown = reviews.format(reviews.all(), 'markdown');
    assert.ok(markdown.includes('Làm rõ giả thiết trước định lý.'));
    assert.ok(markdown.includes('Thêm một phản hồi.'));
    assert.ok(markdown.includes('Review the diagram on page 2.'));
    const exported = JSON.parse(reviews.format(reviews.all(), 'json'));
    assert.equal(exported.threads.length, 2, 'Copy All includes resolved threads');
    const saved = JSON.parse(await fs.readFile(path.join(root, '.review-comments', 'threads', `${thread.id}.json`), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.kind, 'review-thread');
    assert.ok(saved.revision >= 5);
    await reviews.refresh();
    assert.equal(reviews.all().length, 2, 'Comments survive reload');
    // Commands use the production service, not the service instance above.
    await vscode.commands.executeCommand('reviewComments.refresh');
    await vscode.commands.executeCommand('reviewComments.resolve', thread.id);
    await reviews.refresh();
    assert.equal(reviews.require(thread.id).data.status, 'resolved');
    await vscode.commands.executeCommand('reviewComments.reopen', thread.id);
    await reviews.refresh();
    assert.equal(reviews.require(thread.id).data.status, 'open');
    const originalClipboard = await vscode.env.clipboard.readText();
    try {
      await vscode.commands.executeCommand('reviewComments.copyAll');
      const allCopy = await vscode.env.clipboard.readText();
      assert.ok(allCopy.includes('Làm rõ giả thiết trước định lý.'));
      assert.ok(allCopy.includes('Review the diagram on page 2.'));
      assert.match(allCopy, /^# Review comments\n\nAll comments: 2 threads · 1 open · 1 resolved/);
      assert.ok(allCopy.includes('## File `bản thảo.tex` (1 thread, 1 open)'));
      assert.ok(allCopy.includes('· OPEN · Line 2, columns 1–18'));
      assert.ok(allCopy.includes('```latex\nĐoạn cần nhận xét.\n```'));
      assert.ok(allCopy.includes('⟦Đoạn cần nhận xét.⟧'), 'surrounding context marks the selection');
      assert.ok(allCopy.includes('> Thêm một phản hồi.'));
      assert.ok(allCopy.includes('Whole file (file-level comment, no text position)'));
      // Top-of-file action row: copy buttons are available without opening the sidebar.
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', document.uri);
      const titles = (lenses ?? []).map(lens => lens.command?.title ?? '');
      assert.ok(titles.some(title => title.includes('Copy Open')), `Copy Open action row: ${titles.join(' | ')}`);
      assert.ok(titles.some(title => title.includes('Copy All')));
      assert.ok(titles.some(title => /Review: 1 open here · 1 open total/.test(title)));
      assert.ok((lenses ?? []).every(lens => lens.range.start.line === 0), 'Action row sits at the top of the file');
      await vscode.commands.executeCommand('reviewComments.copyFileOpen', document.uri);
      const fileCopy = await vscode.env.clipboard.readText();
      assert.ok(fileCopy.startsWith('# Review comments\n\nOpen comments in this file: 1 thread · 1 open · 0 resolved'));
      assert.ok(!fileCopy.includes('Review the diagram on page 2.'));
      await vscode.commands.executeCommand('reviewComments.copyOpen');
      const openCopy = await vscode.env.clipboard.readText();
      assert.ok(openCopy.includes('Làm rõ giả thiết trước định lý.'));
      assert.ok(!openCopy.includes('Review the diagram on page 2.'));
      await vscode.commands.executeCommand('reviewComments.copyJson');
      assert.equal(JSON.parse(await vscode.env.clipboard.readText()).threads.length, 2);
    } finally { await vscode.env.clipboard.writeText(originalClipboard); }
    const external = path.join(root, 'closed.txt');
    await fs.writeFile(external, 'Original passage.');
    const closedThread = await reviews.add(vscode.Uri.file(external), 'Check this passage.', new vscode.Range(0, 0, 0, 17));
    await vscode.window.showTextDocument(vscode.Uri.file(external));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await fs.writeFile(external, 'Completely changed.');
    const closedExport = JSON.parse(await reviews.formatForCopy([reviews.require(closedThread.id)], 'json'));
    assert.equal(closedExport.threads[0].anchor.stale, true, 'Copy flags changed closed files');
    assert.equal(closedExport.threads[0].anchor.snapshot, 'Original passage.');
    await reviews.remove(closedThread.id, false);
    await reviews.remove(fileThread.id, false);
    await reviews.remove(thread.id, false);
    assert.equal(reviews.all().length, 0);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    await runFileGroupMenuRegression(reviews, root);
    await runMultiRootRegression(reviews, inline, root);
    console.log('Extension Host integration passed: activation, native edits/drafts, stale-edit conflicts, queued mutations, guarded deletion, multi-root duplicate UUIDs, panel baselines, clipboard, storage, source integrity.');
  } finally { inline.dispose(); reviews.dispose(); }
}

async function runFileGroupMenuRegression(reviews: Reviews, root: string): Promise<void> {
  const copyRoot = process.env.REVIEW_COMMENTS_COPY_ROOT;
  assert.ok(copyRoot);
  const target = vscode.Uri.file(path.join(root, 'group-target.txt'));
  const sameName = vscode.Uri.file(path.join(copyRoot, 'group-target.txt'));
  const other = vscode.Uri.file(path.join(root, 'other-active.txt'));
  await fs.writeFile(target.fsPath, 'Target source.');
  await fs.writeFile(sameName.fsPath, 'Other workspace source.');
  await fs.writeFile(other.fsPath, 'Active editor source.');
  const open = await reviews.add(target, 'GROUP_OPEN');
  const resolved = await reviews.add(target, 'GROUP_RESOLVED');
  await reviews.setStatus(resolved.id, 'resolved');
  const otherThread = await reviews.add(other, 'WRONG_ACTIVE_FILE');
  const otherRootThread = await reviews.add(sameName, 'WRONG_WORKSPACE_ROOT');
  const tree = new ReviewTree(reviews);
  const clipboard = await vscode.env.clipboard.readText();
  try {
    // Use a real group produced under a filter. Its refs deliberately omit the
    // resolved sibling; commands must use its URI, not those visible children.
    (tree as unknown as { filter: string }).filter = 'open';
    const group = tree.getChildren().find(item => item.kind === 'file' && item.key === target.toString());
    assert.ok(group && group.kind === 'file');
    assert.equal(group.refs.length, 1);
    const node = tree.getTreeItem(group);
    assert.equal(node.contextValue, 'reviewFile');
    assert.equal(node.resourceUri?.toString(), target.toString());
    await reviews.reply(open.id, 'NEW_REPLY_AFTER_NODE_CREATED');
    await vscode.commands.executeCommand('reviewComments.refresh');
    await vscode.window.showTextDocument(other);

    await vscode.commands.executeCommand('reviewComments.copyFile', group);
    const all = await vscode.env.clipboard.readText();
    assert.ok(all.includes('GROUP_OPEN') && all.includes('GROUP_RESOLVED'));
    assert.ok(all.includes('NEW_REPLY_AFTER_NODE_CREATED'), 'Copy reads live records, not the old group snapshot');
    assert.ok(!all.includes('WRONG_ACTIVE_FILE') && !all.includes('WRONG_WORKSPACE_ROOT'));
    await vscode.commands.executeCommand('reviewComments.copyFileOpen', group);
    const onlyOpen = await vscode.env.clipboard.readText();
    assert.ok(onlyOpen.includes('GROUP_OPEN') && !onlyOpen.includes('GROUP_RESOLVED'));
    assert.ok(!onlyOpen.includes('WRONG_'));
    await vscode.commands.executeCommand('reviewComments.copyFileResolved', group);
    const onlyResolved = await vscode.env.clipboard.readText();
    assert.ok(onlyResolved.includes('GROUP_RESOLVED') && !onlyResolved.includes('GROUP_OPEN'));
    assert.ok(!onlyResolved.includes('WRONG_'));
    await vscode.commands.executeCommand('reviewComments.copyFileJson', group);
    const json = JSON.parse(await vscode.env.clipboard.readText());
    assert.equal(json.threads.length, 2);
    assert.ok(json.threads.every((item: { resource: { path: string } }) => item.resource.path === 'group-target.txt'));
    assert.deepEqual(new Set(json.threads.map((item: { id: string }) => item.id)), new Set([open.id, resolved.id]));
    // Explorer/CodeLens callers still pass a URI instead of a group.
    await vscode.commands.executeCommand('reviewComments.copyFileOpen', target);
    assert.ok((await vscode.env.clipboard.readText()).includes('GROUP_OPEN'));
    await vscode.commands.executeCommand('reviewComments.openFile', group);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), target.toString());

    await reviews.remove(open.id, false);
    await reviews.remove(resolved.id, false);
    await vscode.commands.executeCommand('reviewComments.refresh');
    await vscode.window.showTextDocument(other);
    await vscode.env.clipboard.writeText('NO_MATCHING_THREADS');
    await vscode.commands.executeCommand('reviewComments.copyFile', group);
    assert.equal(await vscode.env.clipboard.readText(), 'NO_MATCHING_THREADS', 'A stale group never falls back to the active file');
    console.log('File-group menus passed: filtered node, fresh replies, all/open/resolved/JSON, distinct workspace roots, source opening, empty group and URI callers.');
  } finally {
    tree.dispose();
    await vscode.env.clipboard.writeText(clipboard);
    for (const thread of [open, resolved, otherThread, otherRootThread]) {
      if (reviews.find(thread.id)) await reviews.remove(thread.id, false);
    }
    await vscode.commands.executeCommand('reviewComments.refresh');
  }
}

async function assertHighlights(document: vscode.TextDocument, threadId: string): Promise<void> {
  // Use the module directly with a spy on setDecorations, since editors expose no decoration getter.
  const { ReviewHighlights } = await import('../src/highlights');
  const local = new Reviews();
  await local.initialize();
  const editor = await vscode.window.showTextDocument(document);
  // Real editors are frozen; render into a recording editor that shares the real document.
  const applied = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
  const recorder = {
    document,
    selection: new vscode.Selection(0, 0, 0, 0),
    setDecorations(type: vscode.TextEditorDecorationType, items: readonly (vscode.Range | vscode.DecorationOptions)[]) {
      applied.set(type, items.map(item => item instanceof vscode.Range ? item : item.range));
      editor.setDecorations(type, items as vscode.DecorationOptions[]);
    }
  };
  const highlights = new ReviewHighlights(local);
  try {
    const internals = highlights as unknown as {
      types: Record<string, vscode.TextEditorDecorationType>;
      cursorEditor: unknown;
      compute(document: vscode.TextDocument): unknown;
      render(editor: unknown, state: unknown, explicitShown: boolean, force: boolean): void;
    };
    const types = internals.types;
    const draw = (explicitShown = false) => {
      internals.cursorEditor = recorder;
      internals.render(recorder, internals.compute(document), explicitShown, true);
    };
    draw();
    assert.equal(applied.get(types.open)?.length, 1, 'Unresolved comment is outlined');
    assert.equal(applied.get(types.open)![0].start.line, 1);
    assert.equal(applied.get(types.active)?.length, 0, 'Nothing active while the cursor is elsewhere');
    recorder.selection = new vscode.Selection(1, 3, 1, 3);
    draw();
    assert.equal(applied.get(types.active)?.length, 1, 'Comment under the cursor gets the active color');
    assert.equal(applied.get(types.open)?.length, 0, 'Active comment is not drawn twice');
    assert.equal(applied.get(types.activeLine)?.[0].start.line, 1, 'Active line is tinted');
    recorder.selection = new vscode.Selection(0, 0, 0, 0);
    highlights.setActive(local.keyFor(document.uri, threadId));
    draw(true);
    assert.equal(applied.get(types.active)?.length, 1, 'Sidebar/navigation selection is active');
    console.log('Highlight regression passed: open outline, cursor and explicit active colors, active line.');
  } finally {
    highlights.dispose();
    local.dispose();
  }
}

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) { throw new Error(`Timed out: ${description}`); }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function runNativeFocusRegression(root: string): Promise<void> {
  const file = path.join(root, 'focus-check.tex');
  const source = 'Source must remain unchanged.\n';
  await fs.writeFile(file, source);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 0, 6);
  let input: vscode.TextDocument | undefined;
  const opened = vscode.workspace.onDidOpenTextDocument(doc => { if (doc.uri.scheme === 'comment') { input = doc; } });
  try {
    // Add immediately after opening the source: the extension waits for its range provider.
    await vscode.commands.executeCommand('reviewComments.add');
    await until(() => !!input, `native comment input initialized (${vscode.workspace.textDocuments.map(doc => doc.uri.scheme).join(',')})`);
    // Send typing to the focused editor, without clicking or focusing it from the test.
    await vscode.commands.executeCommand('type', { text: 'Typed without clicking.' });
    await until(() => input!.getText().includes('Typed without clicking.'), 'typing goes directly to new comment');
    assert.equal(document.getText(), source, 'Source editor never receives comment keystrokes');
    await vscode.commands.executeCommand('editor.action.submitComment');
    const repository = new ThreadRepository(root);
    let created: Awaited<ReturnType<ThreadRepository['loadAll']>>['threads'][number] | undefined;
    const deadline = Date.now() + 8000;
    while (!created && Date.now() < deadline) {
      created = (await repository.loadAll()).threads.find(thread => thread.resource.path === 'focus-check.tex');
      if (!created) { await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    assert.ok(created, 'Native Ctrl+Enter action saves the focused comment');
    assert.equal(created.comments[0].body, 'Typed without clicking.');
    await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 6);
    await new Promise(resolve => setTimeout(resolve, 250));
    await vscode.commands.executeCommand('reviewComments.add');
    await vscode.commands.executeCommand('type', { text: 'Reply without another click.' });
    await vscode.commands.executeCommand('editor.action.submitComment');
    const replyDeadline = Date.now() + 8000;
    while (created.comments.length < 2 && Date.now() < replyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      created = (await repository.loadAll()).threads.find(thread => thread.id === created!.id)!;
    }
    assert.equal(created.comments[1]?.body, 'Reply without another click.', 'Add on same line focuses existing reply instead of duplicating thread');
    assert.equal(document.getText(), source);
    // Native Escape hides without discarding reply text; Add re-enters that draft.
    await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 6);
    await vscode.commands.executeCommand('reviewComments.add');
    await vscode.commands.executeCommand('type', { text: 'Preserved on Escape.' });
    await vscode.commands.executeCommand('workbench.action.hideComment');
    // Newer hosts keep the comment input as activeTextEditor after hideComment.
    // Add is a source-editor action; explicitly return there, as its keybinding requires.
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('reviewComments.add');
    await vscode.commands.executeCommand('type', { text: ' Continued.' });
    await vscode.commands.executeCommand('editor.action.submitComment');
    const resumeDeadline = Date.now() + 8000;
    while (created.comments.length < 3 && Date.now() < resumeDeadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      created = (await repository.loadAll()).threads.find(thread => thread.id === created!.id)!;
    }
    assert.equal(created.comments[2]?.body, 'Preserved on Escape. Continued.', 'Returning to a comment keeps unsent reply text');
    assert.equal(document.getText(), source);
    await repository.delete(created.id, created.revision);
    await vscode.commands.executeCommand('reviewComments.refresh');
    console.log('Native focus regression passed: Add → type directly → native submit, source unchanged.');
  } finally { opened.dispose(); }
}

async function runSafetyRegressions(reviews: Reviews, inline: InlineReviews, id: string, nativeThread: vscode.CommentThread, root: string): Promise<void> {
  const currentComment = (commentId: string) => nativeThread.comments.find(item => (item as any).commentId === commentId) as any;
  const [first, second] = reviews.require(id).data.comments;
  inline.edit(currentComment(first.id));
  inline.edit(currentComment(second.id));
  const firstDraft = currentComment(first.id);
  const secondDraft = currentComment(second.id);
  firstDraft.body = 'First concurrent draft.';
  secondDraft.body = 'Second concurrent draft must survive.';
  await inline.saveEdit(firstDraft);
  assert.equal(currentComment(second.id), secondDraft, 'Saving first edit preserves other editing object');
  assert.equal(secondDraft.mode, vscode.CommentMode.Editing);
  assert.equal(secondDraft.body, 'Second concurrent draft must survive.');
  inline.edit(currentComment(first.id));
  inline.cancelEdit(currentComment(first.id));
  assert.equal(currentComment(second.id), secondDraft, 'Cancelling first edit preserves second draft');
  await inline.saveEdit(secondDraft);

  // An external process commits while this editor retains its original baseline.
  inline.edit(currentComment(first.id));
  const staleDraft = currentComment(first.id);
  staleDraft.body = 'My stale draft.';
  const externalRepository = new ThreadRepository(root);
  const externalData = structuredClone(reviews.require(id).data);
  externalData.comments[0].body = 'External change that must not be overwritten.';
  externalData.comments[0].updatedAt = new Date(Date.now() + 1000).toISOString();
  await externalRepository.save(externalData, externalData.revision);
  await reviews.refresh();
  await assert.rejects(() => inline.saveEdit(staleDraft), /changed|conflict/i);
  assert.equal(reviews.require(id).data.comments[0].body, externalData.comments[0].body);
  assert.equal(currentComment(first.id), staleDraft, 'Conflict retains the editing object');
  assert.equal(staleDraft.body, 'My stale draft.');
  inline.cancelEdit(staleDraft);

  await Promise.all([reviews.reply(id, 'Queued reply.'), reviews.setStatus(id, 'resolved'), reviews.reply(id, 'Another queued reply.')]);
  assert.equal(reviews.require(id).data.status, 'resolved');
  assert.ok(reviews.require(id).data.comments.some(c => c.body === 'Another queued reply.'));
  const approvedRevision = reviews.require(id).data.revision;
  await reviews.setStatus(id, 'open');
  await assert.rejects(() => reviews.remove(id, false, { revision: approvedRevision, status: 'resolved' }), /changed|conflict|revision/i);
  assert.equal(reviews.require(id).data.status, 'open', 'Reopened thread survives old delete confirmation');
  await reviews.setStatus(id, 'resolved');
  const approvedBeforeReply = reviews.require(id).data.revision;
  await reviews.reply(id, 'Reply after confirmation snapshot.');
  await assert.rejects(() => reviews.remove(id, false, { revision: approvedBeforeReply, status: 'resolved' }), /changed|conflict|revision/i);

  // Native gutter templates do not have our custom draft context value.
  const controller = (inline as unknown as { controller: vscode.CommentController }).controller;
  const gutterDraft = controller.createCommentThread(nativeThread.uri, nativeThread.range, []);
  assert.equal(gutterDraft.contextValue, undefined);
  inline.cancel(gutterDraft);
  console.log('Safety regressions passed: independent drafts, stale external edits, same-window concurrency, guarded delete, gutter cancellation.');
}

async function runMultiRootRegression(reviews: Reviews, inline: InlineReviews, root: string): Promise<void> {
  const copyRoot = process.env.REVIEW_COMMENTS_COPY_ROOT;
  assert.ok(copyRoot);
  const relative = 'shared.txt';
  await fs.writeFile(path.join(root, relative), 'Shared text.');
  await fs.writeFile(path.join(copyRoot, relative), 'Shared text.');
  const original = await reviews.add(vscode.Uri.file(path.join(root, relative)), 'Original root comment.', new vscode.Range(0, 0, 0, 12));
  const duplicate = structuredClone(original);
  duplicate.revision = 0;
  duplicate.comments[0].body = 'Copied root comment.';
  await new ThreadRepository(copyRoot).save(duplicate, 0);
  await reviews.refresh();
  const keyA = reviews.keyFor(vscode.Uri.file(path.join(root, relative)), original.id);
  const keyB = reviews.keyFor(vscode.Uri.file(path.join(copyRoot, relative)), original.id);
  assert.notEqual(keyA, keyB);
  assert.throws(() => reviews.require(original.id), /ambiguous|multiple/i);
  await reviews.setStatus(keyB, 'resolved');
  assert.equal(reviews.require(keyA).data.status, 'open');
  assert.equal(reviews.require(keyB).data.status, 'resolved');
  const copied = await reviews.formatForCopy([reviews.require(keyB)], 'markdown');
  assert.ok(copied.includes('Copied root comment.'));
  assert.ok(!copied.includes('Original root comment.'));
  // Unopened source files deliberately have no native widgets until first opened.
  await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative)));
  await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(copyRoot, relative)));
  inline.sync();
  const threadMap = (inline as unknown as { threads: Map<string, vscode.CommentThread> }).threads;
  assert.ok(threadMap.has(keyA) && threadMap.has(keyB), 'Native threads remain independent across roots');
  assert.notEqual(threadMap.get(keyA)!.uri.toString(), threadMap.get(keyB)!.uri.toString());
  const tree = new ReviewTree(reviews);
  const children = tree.getChildren().flatMap(group => tree.getChildren(group));
  assert.equal(new Set(children.map(item => tree.getTreeItem(item).id)).size, 2, 'Tree IDs scoped by root');
  assert.ok(children.every(item => tree.getTreeItem(item).command?.command === 'reviewComments.preview'), 'Sidebar defaults to stable readable preview');
  assert.ok(children.every(item => String(tree.getTreeItem(item).tooltip).includes('Quick Preview')));
  tree.dispose();
  await vscode.commands.executeCommand('reviewComments.refresh');
  await vscode.commands.executeCommand('reviewComments.reopen', { id: keyB });
  await reviews.refresh();
  assert.equal(reviews.require(keyB).data.status, 'open');
  await testPanelIdentityAndBaseline(reviews, keyA, keyB);
  await reviews.remove(keyB, false);
  assert.ok(reviews.find(keyA));
  await reviews.remove(keyA, false);
  console.log('Multi-root regressions passed: copied UUIDs, sidebar/inline/commands/panel scoping, edit baselines and isolated deletion.');
}

async function testPanelIdentityAndBaseline(reviews: Reviews, keyA: string, keyB: string): Promise<void> {
  const subscriptions: vscode.Disposable[] = [];
  const fakeContext = { subscriptions } as vscode.ExtensionContext;
  const panel = new ReviewPanel(fakeContext, {
    create: async (uri, body) => { const thread = await reviews.add(uri, body); return { thread, key: reviews.keyFor(uri, thread.id) }; },
    reply: (id, body, status) => reviews.reply(id, body, status),
    deleteComment: (id, commentId) => reviews.deleteComment(id, commentId),
    edit: (id, commentId, body, baseline) => reviews.edit(id, commentId, body, baseline),
    setStatus: (id, status) => reviews.setStatus(id, status),
    remove: id => reviews.remove(id, false),
    copy: async () => {},
    getThread: id => reviews.find(id)?.data
  });
  try {
    panel.showThread(reviews.require(keyB).data, keyB);
    const internals = panel as any;
    assert.equal(internals.selection.id, keyB);
    assert.equal(internals.view.id, keyB);
    const before = structuredClone(reviews.require(keyB).data.comments[0]);
    await reviews.edit(keyB, before.id, 'New external panel body.', before);
    panel.refresh();
    let reported = '';
    internals.reportError = (error: Error) => { reported = error.message; };
    await internals.receive({ command: 'edit', id: keyB, commentId: before.id, body: 'Old panel draft.', baseline: before, viewId: internals.view.viewId, requestId: 'conflicting-edit' }, internals.panel);
    assert.match(reported, /changed|conflict/i);
    assert.equal(reviews.require(keyB).data.comments[0].body, 'New external panel body.');
    assert.equal(reviews.require(keyA).data.comments[0].body, 'Original root comment.');
    const current = reviews.require(keyB).data.comments[0];
    await internals.receive({ command: 'edit', id: keyB, commentId: current.id, body: 'Fresh panel edit.', baseline: current, viewId: internals.view.viewId, requestId: 'fresh-edit' }, internals.panel);
    assert.equal(reviews.require(keyB).data.comments[0].body, 'Fresh panel edit.');
  } finally { panel.dispose(); }
}
