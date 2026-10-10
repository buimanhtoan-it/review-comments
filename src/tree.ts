import * as vscode from 'vscode';
import { Reviews, ThreadRef } from './reviews';

type Group = { kind: 'file'; key: string; resourceUri: vscode.Uri; label: string; refs: ThreadRef[] };
export type ReviewItem = Group | { kind: 'thread'; id: string };

export class ReviewTree implements vscode.TreeDataProvider<ReviewItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private filter: 'all' | 'open' | 'resolved' | 'stale' = 'all';
  private query = '';
  private readonly subscriptions: vscode.Disposable[] = [];
  private groups: Group[] | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly reviews: Reviews) {
    this.subscriptions.push(reviews.onDidChange(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('reviewComments.sidebarClickAction')) { this.invalidate(); }
      }));
  }
  private invalidate(): void {
    this.groups = undefined;
    if (this.refreshTimer) { return; }
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.changed.fire(); }, 100);
  }
  getTreeItem(item: ReviewItem): vscode.TreeItem {
    if (item.kind === 'file') {
      const node = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded);
      node.id = item.key;
      const open = item.refs.filter(ref => ref.data.status === 'open').length;
      node.description = open ? `${open} open / ${item.refs.length}` : `${item.refs.length} resolved`;
      node.iconPath = new vscode.ThemeIcon('file');
      node.contextValue = 'reviewFile';
      node.resourceUri = item.resourceUri;
      node.tooltip = `${item.resourceUri.fsPath}\n\nRight-click for file actions. Copy commands include matching threads from the whole file, regardless of sidebar filters.`;
      return node;
    }
    const ref = this.reviews.require(item.id);
    const data = this.reviews.view(ref);
    const node = new vscode.TreeItem(data.comments[0].body.slice(0, 180).split(/\r?\n/)[0]);
    node.id = this.reviews.key(ref);
    node.contextValue = `reviewThread.${data.status}`;
    const stale = data.anchor.kind === 'text' && data.anchor.stale;
    node.description = `${data.anchor.kind === 'text' ? `L${data.anchor.range.start.line + 1}` : 'File'} · ${stale ? 'location unverified · ' : ''}${data.status}${data.comments.length > 1 ? ` · ${data.comments.length} comments` : ''}`;
    node.iconPath = new vscode.ThemeIcon(stale ? 'warning' : data.status === 'resolved' ? 'pass' : 'comment', new vscode.ThemeColor(stale ? 'reviewComments.staleBorder' : data.status === 'resolved' ? 'testing.iconPassed' : 'reviewComments.openBorder'));
    // Native tree tooltips are not a reading surface: keep them short and point to the durable preview.
    node.tooltip = `${data.resource.path}\n${node.description}\n\n${data.comments[0].body.slice(0, 240)}${data.comments[0].body.length > 240 ? '…' : ''}\n\nQuick Preview opens the full discussion for scrolling, selecting and copying.`;
    const preview = vscode.workspace.getConfiguration('reviewComments').get<string>('sidebarClickAction', 'preview') === 'preview';
    node.command = { command: preview ? 'reviewComments.preview' : 'reviewComments.show', title: preview ? 'Quick Preview' : 'Go to Source', arguments: [{ kind: 'thread', id: this.reviews.key(ref) }] };
    return node;
  }
  getChildren(item?: ReviewItem): ReviewItem[] {
    if (item?.kind === 'thread') { return []; }
    if (item?.kind === 'file') { return item.refs.map(ref => ({ kind: 'thread', id: this.reviews.key(ref) })); }
    if (this.groups) { return this.groups; }
    const groups = new Map<string, Group>();
    for (const ref of this.reviews.all().sort((a, b) => a.data.resource.path.localeCompare(b.data.resource.path) || a.data.createdAt.localeCompare(b.data.createdAt))) {
      const data = this.filter === 'stale' ? this.reviews.view(ref) : ref.data;
      if (this.filter === 'stale' && !(data.anchor.kind === 'text' && data.anchor.stale)) { continue; }
      if (this.filter !== 'stale' && this.filter !== 'all' && this.filter !== data.status) { continue; }
      if (this.query && !`${data.resource.path} ${data.comments.map(c => `${c.author} ${c.body}`).join(' ')} ${data.tags.join(' ')}`.toLocaleLowerCase().includes(this.query.toLocaleLowerCase())) { continue; }
      const resourceUri = this.reviews.uri(ref);
      const key = resourceUri.toString();
      const group = groups.get(key) ?? { kind: 'file' as const, key, resourceUri, label: `${(vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${ref.folder.folder.name}/` : ''}${data.resource.path}`, refs: [] };
      group.refs.push(ref);
      groups.set(key, group);
    }
    this.groups = [...groups.values()];
    return this.groups;
  }
  async chooseFilter(): Promise<void> {
    const choice = await vscode.window.showQuickPick([
      { label: 'All comments', value: 'all' as const },
      { label: 'Open comments', value: 'open' as const },
      { label: 'Resolved comments', value: 'resolved' as const },
      { label: 'Unverified source locations', description: 'Check the saved text location', value: 'stale' as const }
    ], { placeHolder: 'Filter the sidebar only. Copy, Export, and navigation keep their own scope.' });
    if (!choice) { return; }
    this.filter = choice.value;
    this.invalidate();
  }
  async search(): Promise<void> {
    const query = await vscode.window.showInputBox({ title: 'Search comments', prompt: 'Search sidebar threads by file path, comment text, author, or stored tag. Leave empty to clear the search.', value: this.query });
    if (query === undefined) { return; }
    this.query = query.trim();
    this.invalidate();
  }
  clearFilters(): void { this.filter = 'all'; this.query = ''; this.invalidate(); }
  get description(): string { return `${this.filter === 'stale' ? 'location unverified' : this.filter}${this.query ? ` · ${this.query}` : ''}`; }
  dispose(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.changed.dispose();
  }
}
