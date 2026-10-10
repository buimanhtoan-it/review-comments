import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Thread, createThread, TextAnchor, validateCommentBody } from './core/model';
import { ThreadRepository } from './core/storage';
import { AnchorResolver, createAnchorResolver, createTextAnchor } from './core/anchoring';
import { formatMarkdownWorkspaces, formatJson } from './core/export';

export interface FolderState {
  folder: vscode.WorkspaceFolder;
  repository: ThreadRepository;
  threads: Map<string, Thread>;
}
export interface ThreadRef { folder: FolderState; data: Thread }

interface DocumentView {
  document: vscode.TextDocument;
  version: number;
  resolve: AnchorResolver;
  views: WeakMap<Thread, Thread>;
}
interface ChangeBatch { changed: boolean }

export class Reviews implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly dataChanged = new vscode.EventEmitter<void>();
  /** Persisted thread/count/comment changes only; source edits still reach onDidChange. */
  readonly onDidChangeData = this.dataChanged.event;
  private readonly states = new Map<string, FolderState>();
  private readonly byKey = new Map<string, ThreadRef>();
  private readonly byId = new Map<string, Set<ThreadRef>>();
  private readonly byUri = new Map<string, Set<ThreadRef>>();
  private readonly identities = new WeakMap<ThreadRef, { key: string; uri: vscode.Uri }>();
  private refs: ThreadRef[] | undefined;
  private readonly documents = new Map<string, vscode.TextDocument>();
  private readonly documentViews = new Map<string, DocumentView>();
  private readonly counters = { viewComputations: 0, viewCacheHits: 0, indexBuilds: 0, indexUpdates: 0, resolverBuilds: 0, sourceReads: 0, dataEvents: 0, visualEvents: 0 };
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly anchorQueues = new Map<string, Promise<void>>();
  readonly output = vscode.window.createOutputChannel('Review Comments');
  private lastErrors = '';
  private loadedOnce = false;
  private disposed = false;

  async initialize(): Promise<void> {
    for (const document of vscode.workspace.textDocuments) this.documents.set(document.uri.toString(), document);
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.safe(() => this.resetFolders()); }),
      vscode.workspace.onDidSaveTextDocument(document => { void this.safe(() => this.saved(document)); }),
      vscode.workspace.onDidOpenTextDocument(document => {
        const key = document.uri.toString();
        this.documents.set(key, document);
        this.documentViews.delete(key);
        if (this.byUri.has(key)) this.scheduleView(key, 50);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = document.uri.toString();
        if (this.documents.get(key) !== document) return;
        this.documents.delete(key);
        this.documentViews.delete(key);
        if (this.byUri.has(key)) this.scheduleView(key, 50);
      }),
      vscode.workspace.onDidRenameFiles(event => { void this.safe(() => this.renamed(event)); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        const key = event.document.uri.toString();
        if (!event.contentChanges.length || !this.byUri.has(key)) return;
        // The original snapshot is never replaced automatically. Views use this source generation.
        this.documents.set(key, event.document);
        this.documentViews.delete(key);
        this.scheduleView(key, 180);
      })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/.review-comments/threads/*.json');
    const reload = () => this.schedule('reload', () => { void this.safe(() => this.refresh()); }, 200);
    this.subscriptions.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload));
    // Subscribe before the first read so concurrent watcher/document changes cannot be missed.
    await this.resetFolders();
  }

  private scheduleView(key: string, delay: number): void {
    this.schedule(`view:${key}`, () => { if (this.byUri.has(key)) this.emitVisual(); }, delay);
  }

  private emitVisual(): void {
    if (this.disposed) return;
    this.counters.visualEvents++;
    this.changed.fire();
  }

  private emitData(batch?: ChangeBatch): void {
    if (batch) { batch.changed = true; return; }
    if (this.disposed) return;
    this.counters.dataEvents++;
    this.dataChanged.fire();
    this.emitVisual();
  }

  /** Detached, read-only lifetime counters; no instrumentation can mutate the store. */
  diagnostics(): Readonly<typeof this.counters & { documentCaches: number; indexedThreads: number }> {
    return Object.freeze({ ...this.counters, documentCaches: this.documentViews.size, indexedThreads: this.byKey.size });
  }

  private schedule(key: string, fn: () => void, delay: number): void {
    const previous = this.timers.get(key);
    if (previous) { clearTimeout(previous); }
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); if (!this.disposed) { fn(); } }, delay));
  }

  async safe(action: () => Promise<unknown>): Promise<void> {
    try { await action(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(message);
      void vscode.window.showErrorMessage(`Review Comments: ${message}`);
    }
  }

  private async resetFolders(): Promise<void> {
    const batch: ChangeBatch = { changed: false };
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => ['file', 'vscode-remote'].includes(f.uri.scheme));
    for (const [key, state] of this.states) {
      if (!folders.some(folder => folder.uri.toString() === key)) {
        for (const data of state.threads.values()) this.removeIndex(this.byKey.get(this.scopedKey(state, data.id))!);
        if (state.threads.size) batch.changed = true;
        this.states.delete(key);
      }
    }
    for (const folder of folders) {
      if (!this.states.has(folder.uri.toString())) {
        this.states.set(folder.uri.toString(), { folder, repository: new ThreadRepository(folder.uri.fsPath), threads: new Map() });
      }
    }
    await this.refreshBatch(batch);
  }

  async refresh(): Promise<void> { await this.refreshBatch({ changed: false }); }

  private async refreshBatch(batch: ChangeBatch): Promise<void> {
    const errors: string[] = [];
    try {
      for (const state of this.states.values()) await this.load(state, batch, errors);
      if (!this.loadedOnce) { this.loadedOnce = true; batch.changed = true; }
    } finally {
      if (batch.changed) this.emitData();
      this.reportLoadErrors(errors);
    }
  }

  private reportLoadErrors(errors: string[]): void {
    const signature = errors.join('\n');
    if (signature && signature !== this.lastErrors) {
      this.output.appendLine(signature);
      void vscode.window.showWarningMessage('Some review files could not be loaded. They have not been modified. See Review Comments output.', 'Show Output')
        .then(choice => { if (choice) { this.output.show(); } });
    }
    this.lastErrors = signature;
  }

  private async enqueue(state: FolderState, action: () => Promise<void>): Promise<void> {
    const key = state.folder.uri.toString();
    const task = (this.loads.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.loads.set(key, task);
    try { await task; } finally { if (this.loads.get(key) === task) this.loads.delete(key); }
  }

  private assertActive(state: FolderState): void {
    if (this.disposed || this.states.get(state.folder.uri.toString()) !== state) {
      throw new Error('The workspace folder changed. Refresh the review list and retry.');
    }
  }

  private async load(state: FolderState, batch?: ChangeBatch, errors?: string[]): Promise<void> {
    const loadErrors = errors ?? [];
    // Serialize watcher loads and local saves so an older read cannot replace a newer revision.
    await this.enqueue(state, async () => {
      if (this.disposed || this.states.get(state.folder.uri.toString()) !== state) return;
      const result = await state.repository.loadAll();
      loadErrors.push(...result.errors.map(error => `${state.folder.name}: ${error}`));
      if (this.disposed || this.states.get(state.folder.uri.toString()) !== state) return;
      const incoming = new Set(result.threads.map(thread => thread.id));
      let changed = false;
      for (const thread of result.threads) {
        const current = state.threads.get(thread.id);
        // Revision alone misses external/manual edits and unknown JSON extension fields.
        if (current !== undefined && isDeepStrictEqual(current, thread)) continue;
        this.put(state, thread);
        changed = true;
      }
      for (const [id] of state.threads) {
        if (incoming.has(id)) continue;
        this.removeIndex(this.byKey.get(this.scopedKey(state, id))!);
        state.threads.delete(id);
        changed = true;
      }
      if (changed) this.emitData(batch);
    });
    if (!errors) this.reportLoadErrors(loadErrors);
  }

  folderFor(uri: vscode.Uri): FolderState | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder && this.states.get(folder.uri.toString());
  }

  private resource(uri: vscode.Uri): { state: FolderState; relative: string } {
    const state = this.folderFor(uri);
    if (!state) { throw new Error('Open a filesystem workspace and choose a saved file inside it. Untitled and virtual documents are not supported.'); }
    const relative = path.relative(state.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) { throw new Error('Choose a file inside the workspace.'); }
    if (relative === '.review-comments' || relative.startsWith('.review-comments/')) { throw new Error('Review storage cannot itself be annotated.'); }
    return { state, relative };
  }

  private scopedKey(folder: FolderState, id: string): string {
    return JSON.stringify([folder.folder.uri.toString(), id]);
  }

  private identity(ref: ThreadRef): { key: string; uri: vscode.Uri } {
    let identity = this.identities.get(ref);
    if (!identity) {
      identity = { key: this.scopedKey(ref.folder, ref.data.id), uri: vscode.Uri.joinPath(ref.folder.folder.uri, ...ref.data.resource.path.split('/')) };
      this.identities.set(ref, identity);
    }
    return identity;
  }

  private removeIndex(ref: ThreadRef, preserveSource = false): void {
    const { key, uri } = this.identity(ref);
    const source = uri.toString();
    this.byKey.delete(key);
    const ids = this.byId.get(ref.data.id)!;
    ids.delete(ref);
    if (!ids.size) this.byId.delete(ref.data.id);
    const resources = this.byUri.get(source)!;
    resources.delete(ref);
    if (!resources.size) {
      this.byUri.delete(source);
      if (!preserveSource) {
        this.documentViews.delete(source);
        const timerKey = `view:${source}`;
        clearTimeout(this.timers.get(timerKey));
        this.timers.delete(timerKey);
      }
    }
    this.documentViews.get(source)?.views.delete(ref.data);
    this.refs = undefined;
    this.counters.indexUpdates++;
  }

  private put(folder: FolderState, data: Thread): void {
    const ref = { folder, data };
    const { key, uri } = this.identity(ref);
    const previous = this.byKey.get(key);
    if (previous) this.removeIndex(previous, this.uri(previous).toString() === uri.toString());
    folder.threads.set(data.id, data);
    this.byKey.set(key, ref);
    const ids = this.byId.get(data.id) ?? new Set<ThreadRef>();
    ids.add(ref);
    this.byId.set(data.id, ids);
    const resources = this.byUri.get(uri.toString()) ?? new Set<ThreadRef>();
    resources.add(ref);
    this.byUri.set(uri.toString(), resources);
    this.refs = undefined;
    this.counters.indexUpdates++;
  }

  all(): ThreadRef[] {
    if (!this.refs) {
      this.refs = [...this.byKey.values()];
      this.counters.indexBuilds++;
    }
    return this.refs.slice(); // Consumers may sort; stable records, never the owned array.
  }

  key(ref: ThreadRef): string { return this.identity(ref).key; }

  keyFor(uri: vscode.Uri, id: string): string {
    const folder = this.folderFor(uri);
    const data = folder?.threads.get(id);
    if (!folder || !data) { throw new Error('This thread does not exist in the selected workspace folder. Refresh the review list.'); }
    return this.scopedKey(folder, id);
  }

  find(keyOrId: string): ThreadRef | undefined {
    const scoped = this.byKey.get(keyOrId);
    if (scoped) return scoped;
    const matches = this.byId.get(keyOrId);
    if (matches && matches.size > 1) { throw new Error('Ambiguous review thread UUID: it exists in multiple workspace folders. Use a workspace-scoped thread key.'); }
    return matches?.values().next().value;
  }

  uri(ref: ThreadRef): vscode.Uri { return this.identity(ref).uri; }
  author(): string { return vscode.workspace.getConfiguration('reviewComments').get<string>('author', 'Reviewer').trim() || 'Reviewer'; }
  require(keyOrId: string): ThreadRef {
    const ref = this.find(keyOrId);
    if (!ref) { throw new Error('This thread no longer exists. Refresh the review list.'); }
    return ref;
  }

  private prepareDocument(document: vscode.TextDocument): DocumentView {
    const key = document.uri.toString();
    let prepared = this.documentViews.get(key);
    if (!prepared || prepared.document !== document || prepared.version !== document.version) {
      this.counters.sourceReads++;
      this.counters.resolverBuilds++;
      prepared = { document, version: document.version, resolve: createAnchorResolver(document.getText()), views: new WeakMap() };
      // Do not retain sources without comments, including removed threads held by a consumer.
      if (this.byUri.has(key) && !document.isClosed) this.documentViews.set(key, prepared);
    }
    return prepared;
  }

  view(ref: ThreadRef): Thread {
    if (ref.data.anchor.kind === 'file') return ref.data;
    const document = this.documents.get(this.uri(ref).toString());
    if (!document || document.isClosed) return ref.data;
    const prepared = this.prepareDocument(document);
    const cached = prepared.views.get(ref.data);
    if (cached) { this.counters.viewCacheHits++; return cached; }
    this.counters.viewComputations++;
    const view = { ...ref.data, anchor: prepared.resolve(ref.data.anchor) };
    prepared.views.set(ref.data, view);
    return view;
  }

  async add(uri: vscode.Uri, body: string, range?: vscode.Range): Promise<Thread> {
    this.checkBody(body);
    const { state, relative } = this.resource(uri);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) { throw new Error('Choose a file, not a directory.'); }
    const anchor = range ? createTextAnchor((await vscode.workspace.openTextDocument(uri)).getText(), plainRange(range)) : { kind: 'file' as const };
    const data = createThread(relative, anchor, body, this.author());
    await this.store(state, data);
    return this.require(this.key({ folder: state, data })).data;
  }

  private checkBody(body: string): void { validateCommentBody(body); }

  private async recover(state: FolderState, error: unknown, batch?: ChangeBatch): Promise<never> {
    // Reload outside the queue task: load() itself joins the same queue.
    try { await this.load(state, batch); } catch (reloadError) {
      throw new AggregateError([error, reloadError], `${String(error)}; Reload also failed: ${String(reloadError)}`);
    }
    throw error;
  }

  private async store(state: FolderState, data: Thread): Promise<void> {
    try {
      await this.enqueue(state, async () => {
        this.assertActive(state);
        const saved = await state.repository.save(data, data.revision);
        this.assertActive(state);
        this.put(state, saved);
        this.emitData();
      });
    } catch (error) { await this.recover(state, error); }
  }

  private async update(keyOrId: string, mutate: (data: Thread) => void | boolean, batch?: ChangeBatch): Promise<void> {
    const ref = this.require(keyOrId);
    const threadKey = this.key(ref);
    try {
      await this.enqueue(ref.folder, async () => {
        // Read and clone only once earlier loads and mutations have committed.
        this.assertActive(ref.folder);
        const current = this.require(threadKey);
        if (current.folder !== ref.folder) { throw new Error('The workspace folder changed. Refresh the review list and retry.'); }
        const data = structuredClone(current.data);
        if (mutate(data) === false) return;
        data.updatedAt = new Date().toISOString();
        const saved = await ref.folder.repository.save(data, current.data.revision);
        this.assertActive(ref.folder);
        this.put(ref.folder, saved);
        this.emitData(batch);
      });
    } catch (error) { await this.recover(ref.folder, error, batch); }
  }

  private checkRevision(data: Thread, expectedRevision: number): void {
    if (data.revision !== expectedRevision) {
      throw new Error(`Review thread revision conflict: expected ${expectedRevision}, found ${data.revision}. Refresh the thread and retry.`);
    }
  }

  async reply(id: string, body: string, status?: 'open' | 'resolved'): Promise<void> {
    this.checkBody(body);
    if (status !== undefined && status !== 'open' && status !== 'resolved') throw new Error('Choose Open or Resolved.');
    await this.update(id, data => {
      const now = new Date().toISOString();
      data.comments.push({ id: randomUUID(), body, author: this.author(), createdAt: now, updatedAt: now });
      // A combined action commits both changes or neither. Plain Reply preserves status.
      if (status !== undefined) data.status = status;
    });
  }

  async edit(key: string, commentId: string, body: string, baseline: { body: string; updatedAt: string }): Promise<void> {
    this.checkBody(body);
    const expected = { ...baseline };
    await this.update(key, data => {
      const comment = data.comments.find(item => item.id === commentId);
      if (!comment) { throw new Error('This comment no longer exists.'); }
      if (comment.body !== expected.body || comment.updatedAt !== expected.updatedAt) {
        throw new Error('This comment changed after you started editing. Copy your draft, cancel editing to load the latest version, then edit again.');
      }
      comment.body = body;
      comment.updatedAt = new Date().toISOString();
    });
  }

  async setStatus(id: string, status: 'open' | 'resolved'): Promise<void> {
    if (status !== 'open' && status !== 'resolved') throw new Error('Choose Open or Resolved.');
    await this.update(id, data => {
      if (data.status === status) return false;
      data.status = status;
    });
  }

  async remove(key: string, confirm = true, expected?: { revision: number; status?: 'open' | 'resolved' }): Promise<boolean> {
    const ref = this.require(key);
    const threadKey = this.key(ref);
    const expectedRevision = expected ? expected.revision : ref.data.revision;
    const expectedStatus = expected?.status;
    if (confirm && await vscode.window.showWarningMessage('Delete this thread and all its replies? This cannot be undone.', { modal: true }, 'Delete') !== 'Delete') { return false; }
    try {
      await this.enqueue(ref.folder, async () => {
        this.assertActive(ref.folder);
        const current = this.require(threadKey);
        if (current.folder !== ref.folder) { throw new Error('The workspace folder changed. Refresh the review list and retry.'); }
        this.checkRevision(current.data, expectedRevision);
        if (expectedStatus !== undefined && current.data.status !== expectedStatus) {
          throw new Error(`Review thread status conflict: expected ${expectedStatus}, found ${current.data.status}. Refresh the thread and retry.`);
        }
        await ref.folder.repository.delete(current.data.id, expectedRevision);
        this.assertActive(ref.folder);
        this.removeIndex(current);
        ref.folder.threads.delete(current.data.id);
        this.emitData();
      });
    } catch (error) { await this.recover(ref.folder, error); }
    return true;
  }

  async deleteComment(key: string, commentId: string): Promise<boolean> {
    const ref = this.require(key);
    const threadKey = this.key(ref);
    const revision = ref.data.revision;
    if (!ref.data.comments.some(comment => comment.id === commentId)) { throw new Error('This comment no longer exists.'); }
    if (ref.data.comments.length === 1) { return this.remove(threadKey, true, { revision }); }
    if (await vscode.window.showWarningMessage('Delete this comment? The other comments in this thread will be kept. This cannot be undone.', { modal: true }, 'Delete') !== 'Delete') { return false; }
    await this.update(threadKey, data => {
      this.checkRevision(data, revision);
      if (!data.comments.some(comment => comment.id === commentId)) { throw new Error('This comment no longer exists.'); }
      data.comments = data.comments.filter(comment => comment.id !== commentId);
    });
    return true;
  }

  async reanchor(key: string, editor: vscode.TextEditor): Promise<void> {
    const resource = this.resource(editor.document.uri);
    const ref = this.require(key);
    if (resource.state !== ref.folder || resource.relative !== ref.data.resource.path) { throw new Error('Select text in the same file as the comment before attaching it.'); }
    const threadKey = this.key(ref);
    const revision = ref.data.revision;
    const anchor = createTextAnchor(editor.document.getText(), plainRange(selectionRange(editor)));
    if (await vscode.window.showWarningMessage('Replace the stored source excerpt with the current selection?', { modal: true }, 'Attach') !== 'Attach') { return; }
    await this.update(threadKey, data => {
      this.checkRevision(data, revision);
      data.anchor = anchor;
    });
  }

  private async saved(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const refs = this.byUri.get(key);
    if (!refs || ![...refs].some(ref => ref.data.anchor.kind === 'text')) return;
    const previous = this.anchorQueues.get(key) ?? Promise.resolve();
    // Capture this save's exact generation before awaiting any queued write or later edit.
    const resolve = this.prepareDocument(document).resolve;
    const task = previous.catch(() => {}).then(async () => {
      const batch: ChangeBatch = { changed: false };
      const errors: string[] = [];
      try {
        for (const ref of [...(this.byUri.get(key) ?? [])]) {
          if (ref.data.anchor.kind !== 'text') continue;
          try {
            await this.update(this.key(ref), data => {
              if (data.anchor.kind !== 'text' || this.uri({ folder: ref.folder, data }).toString() !== key) return false;
              // Relocate the latest anchor, including a reattachment queued before this save.
              const anchor = resolve(data.anchor);
              if (isDeepStrictEqual(anchor, data.anchor)) return false;
              data.anchor = anchor;
            }, batch);
          } catch (error) {
            errors.push(`${ref.folder.folder.name}: ${ref.data.resource.path} (${ref.data.id}): ${String(error)}`);
          }
        }
      } finally {
        // This token only defers this save's mutations. Unrelated concurrent writes still emit.
        if (batch.changed) this.emitData();
      }
      if (errors.length) throw new Error(`Some review anchors could not be saved:\n${errors.join('\n')}`);
    });
    this.anchorQueues.set(key, task);
    try { await task; } finally { if (this.anchorQueues.get(key) === task) this.anchorQueues.delete(key); }
  }

  private async renamed(event: vscode.FileRenameEvent): Promise<void> {
    const errors: string[] = [];
    for (const change of event.files) {
      for (const ref of this.all()) {
        try {
          const uri = this.uri(ref);
          if (uri.scheme !== change.oldUri.scheme || uri.authority !== change.oldUri.authority) { continue; }
          const suffix = path.relative(change.oldUri.fsPath, uri.fsPath);
          if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) { continue; }
          await this.update(this.key(ref), data => {
            // A preceding rename may already have moved this record while it was queued.
            const currentUri = this.uri({ folder: ref.folder, data });
            const currentSuffix = path.relative(change.oldUri.fsPath, currentUri.fsPath);
            if (currentSuffix === '..' || currentSuffix.startsWith(`..${path.sep}`) || path.isAbsolute(currentSuffix)) { return false; }
            const destination = vscode.Uri.joinPath(change.newUri, ...currentSuffix.split(path.sep).filter(Boolean));
            if (this.folderFor(destination) !== ref.folder) {
              void vscode.window.showWarningMessage('A reviewed file moved outside its workspace folder. Its comments were kept at the original path.');
              return false;
            }
            const { relative } = this.resource(destination);
            if (data.resource.path === relative) { return false; }
            data.resource.path = relative;
          });
        } catch (error) {
          errors.push(`${ref.folder.folder.name}: ${ref.data.resource.path} (${ref.data.id}): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (errors.length) { throw new Error(`Some review threads could not follow the renamed files:\n${errors.join('\n')}`); }
  }

  format(refs: ThreadRef[], format: 'markdown' | 'json', refreshLive = true, scope?: string): string {
    const dataFor = (ref: ThreadRef) => refreshLive ? this.view(ref) : ref.data;
    const folders = [...new Set(refs.map(ref => ref.folder))].sort((a, b) => a.folder.uri.toString().localeCompare(b.folder.uri.toString()));
    const groups = folders.map(folder => ({ folder, threads: refs.filter(ref => ref.folder === folder).map(dataFor) }));
    if (format === 'markdown') {
      return formatMarkdownWorkspaces(groups.length
        ? groups.map(group => ({ name: group.folder.folder.name, threads: group.threads }))
        : [{ name: vscode.workspace.name, threads: [] }], { scope });
    }
    if (folders.length <= 1) { return formatJson(groups[0]?.threads ?? [], folders[0]?.folder.name ?? vscode.workspace.name); }
    return JSON.stringify({ schemaVersion: 1, kind: 'review-comments-workspace-export', workspaces: groups.map(group => ({ root: group.folder.folder.uri.toString(), ...JSON.parse(formatJson(group.threads, group.folder.folder.name)) })) }, null, 2);
  }

  async formatForCopy(refs: ThreadRef[], format: 'markdown' | 'json', scope?: string): Promise<string> {
    // Recheck closed source files too, without writing anchors or loading huge files into an editor.
    const sources = new Map<string, AnchorResolver | null>();
    const refreshed: ThreadRef[] = [];
    for (const ref of refs) {
      if (ref.data.anchor.kind === 'file') { refreshed.push(ref); continue; }
      const uri = this.uri(ref);
      const key = uri.toString();
      const document = this.documents.get(key);
      if (document?.isDirty) { refreshed.push({ ...ref, data: this.view(ref) }); continue; }
      if (!sources.has(key)) {
        let text: string | null = null;
        try {
          const size = (await fs.stat(uri.fsPath)).size;
          if (size <= 16 * 1024 * 1024) {
            const bytes = await fs.readFile(uri.fsPath);
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          }
        } catch { /* Missing, large, or non-UTF-8 sources retain their original snapshot with a warning. */ }
        sources.set(key, text === null ? null : createAnchorResolver(text));
      }
      const resolve = sources.get(key)!;
      const anchor = resolve === null ? { ...ref.data.anchor, stale: true } : resolve(ref.data.anchor);
      refreshed.push({ ...ref, data: { ...ref.data, anchor } });
    }
    return this.format(refreshed, format, false, scope);
  }

  async copy(refs: ThreadRef[], forced?: 'markdown' | 'json', scope?: string): Promise<void> {
    if (!refs.length) { vscode.window.setStatusBarMessage(`$(info) No ${scope ? scope.toLowerCase() : 'comments'} to copy.`, 3000); return; }
    const format = forced ?? vscode.workspace.getConfiguration('reviewComments').get<'markdown' | 'json'>('copyFormat', 'markdown');
    await vscode.env.clipboard.writeText(await this.formatForCopy(refs, format, scope));
    const open = refs.filter(ref => ref.data.status === 'open').length;
    const message = `Copied ${refs.length} review thread${refs.length === 1 ? '' : 's'} (${open} open).`;
    vscode.window.setStatusBarMessage(`$(check) ${message}`, 3000);
    if (vscode.workspace.getConfiguration('reviewComments').get<boolean>('copyNotifications', false)) {
      void vscode.window.showInformationMessage(message);
    }
  }

  async openStorage(): Promise<void> {
    const folders = [...this.states.values()];
    const selected = folders.length === 1 ? { state: folders[0] } : await vscode.window.showQuickPick(folders.map(state => ({ label: state.folder.name, description: state.folder.uri.fsPath, state })), { placeHolder: 'Choose workspace folder' });
    if (!selected) { return; }
    const uri = vscode.Uri.joinPath(selected.state.folder.uri, '.review-comments', 'threads');
    await vscode.workspace.fs.createDirectory(uri);
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) { clearTimeout(timer); }
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.timers.clear();
    this.documents.clear();
    this.documentViews.clear();
    this.byKey.clear(); this.byId.clear(); this.byUri.clear();
    this.states.clear(); this.refs = undefined;
    this.changed.dispose(); this.dataChanged.dispose(); this.output.dispose();
  }
}

function plainRange(range: vscode.Range): TextAnchor['range'] {
  // VS Code Position stores coordinates in private fields; do not spread the class instance.
  return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

export function selectionRange(editor: vscode.TextEditor): vscode.Range {
  return editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range : editor.selection;
}
