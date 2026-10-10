import * as vscode from 'vscode';
import { Reviews } from './reviews';

type ToolbarMode = 'always' | 'whenComments' | 'off';

interface Counts { open: number; total: number; fileOpen: number; fileTotal: number }

/**
 * Global review actions: a row at the top of each reviewable file (directly under the
 * breadcrumb), a status bar counter, an activity badge, and context keys for title buttons.
 */
export class ReviewToolbar implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly status = vscode.window.createStatusBarItem('reviewComments.status', vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[] = [];
  private byFile = new Map<string, { open: number; total: number }>();
  private totals = { open: 0, total: 0 };
  private signature = '';
  private lensSignature = '';

  constructor(private readonly reviews: Reviews, private readonly view: vscode.TreeView<unknown>) {
    this.status.name = 'Review Comments';
    this.status.command = 'reviewComments.quickActions';
    this.subscriptions.push(
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'vscode-remote' }], this),
      reviews.onDidChangeData(() => { this.recount(); this.refresh(); }),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('reviewComments.toolbar') || event.affectsConfiguration('reviewComments.statusBar')) { this.refresh(); }
      })
    );
    this.recount();
    this.refresh();
  }

  private mode(): ToolbarMode {
    return vscode.workspace.getConfiguration('reviewComments').get<ToolbarMode>('toolbar', 'whenComments');
  }

  private activeUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) { return input.uri; }
    if (input instanceof vscode.TabInputTextDiff) { return input.modified; }
    return vscode.window.activeTextEditor?.document.uri;
  }

  private recount(): void {
    this.byFile.clear();
    this.totals = { open: 0, total: 0 };
    for (const ref of this.reviews.all()) {
      const uri = this.reviews.uri(ref).toString();
      const counts = this.byFile.get(uri) ?? { open: 0, total: 0 };
      counts.total++; this.totals.total++;
      if (ref.data.status === 'open') { counts.open++; this.totals.open++; }
      this.byFile.set(uri, counts);
    }
  }

  counts(uri = this.activeUri()): Counts {
    const inFile = uri ? this.byFile.get(uri.toString()) : undefined;
    return { ...this.totals, fileOpen: inFile?.open ?? 0, fileTotal: inFile?.total ?? 0 };
  }

  private refresh(): void {
    this.update();
    const signature = JSON.stringify([this.mode(), this.totals, [...this.byFile].sort(([a], [b]) => a.localeCompare(b))]);
    if (signature !== this.lensSignature) { this.lensSignature = signature; this.changed.fire(); }
  }

  private update(): void {
    const counts = this.counts();
    const showStatus = vscode.workspace.getConfiguration('reviewComments').get<boolean>('statusBar', true);
    const signature = JSON.stringify([counts, showStatus, this.mode()]);
    if (signature === this.signature) { return; }
    this.signature = signature;
    void vscode.commands.executeCommand('setContext', 'reviewComments.hasThreads', counts.total > 0);
    void vscode.commands.executeCommand('setContext', 'reviewComments.hasOpen', counts.open > 0);
    this.view.badge = counts.open > 0
      ? { value: counts.open, tooltip: `${counts.open} open review thread${counts.open === 1 ? '' : 's'}` }
      : undefined;
    if (!showStatus || (counts.total === 0 && this.mode() !== 'always')) { this.status.hide(); return; }
    this.status.text = counts.fileTotal
      ? `$(comment-discussion) ${counts.fileOpen} here · ${counts.open} open total`
      : `$(comment-discussion) ${counts.open} open`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendText(`Workspace: ${counts.open} open of ${counts.total} review threads. Replies are not counted separately.`);
    if (counts.fileTotal) { tooltip.appendText(`\nThis file: ${counts.fileOpen} open of ${counts.fileTotal} threads.`); }
    tooltip.appendText('\nClick for copy and navigation actions.');
    this.status.tooltip = tooltip;
    this.status.show();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const mode = this.mode();
    if (mode === 'off' || !this.reviews.folderFor(document.uri) || document.uri.path.includes('/.review-comments/')) { return []; }
    const counts = this.counts(document.uri);
    if (mode === 'whenComments' && counts.total === 0) { return []; }
    const top = new vscode.Range(0, 0, 0, 0);
    const lens = (title: string, command: string, tooltip: string, args?: unknown[]) =>
      new vscode.CodeLens(top, { title, command, tooltip, arguments: args });
    const lenses = [
      lens(`$(comment-discussion) Review: ${counts.fileOpen} open here · ${counts.open} open total`, 'workbench.view.extension.reviewComments', 'Show all review comments'),
      lens('$(copy) Copy Open', 'reviewComments.copyOpen', 'Copy all open threads across workspace folders, including their replies'),
      lens('$(copy) Copy All', 'reviewComments.copyAll', 'Copy all threads and replies across workspace folders, including resolved threads'),
    ];
    if (counts.fileTotal) {
      lenses.push(lens('$(file) Copy Open in This File', 'reviewComments.copyFileOpen', 'Copy open threads and their replies in this file only', [document.uri]));
    }
    if (counts.open) {
      lenses.push(lens('$(arrow-down) Next', 'reviewComments.nextOpen', 'Go to the next unresolved comment (Alt+F8)'));
    }
    lenses.push(lens('$(comment-add) Add', 'reviewComments.add', 'Comment on the selected text or current line'));
    return lenses;
  }

  async quickActions(): Promise<void> {
    const counts = this.counts();
    const uri = this.activeUri();
    const items: Array<vscode.QuickPickItem & { command?: string; args?: unknown[] }> = [
      { label: '$(copy) Copy Open Comments', description: `${counts.open} thread${counts.open === 1 ? '' : 's'}`, command: 'reviewComments.copyOpen' },
      { label: '$(copy) Copy All Comments', description: `${counts.total} including resolved`, command: 'reviewComments.copyAll' },
    ];
    if (uri && counts.fileTotal) {
      items.push({ label: '$(file) Copy Open Comments in This File', description: `${counts.fileOpen} thread${counts.fileOpen === 1 ? '' : 's'}`, command: 'reviewComments.copyFileOpen', args: [uri] });
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(arrow-down) Next Open Comment', description: 'Alt+F8', command: 'reviewComments.nextOpen' },
      { label: '$(arrow-up) Previous Open Comment', description: 'Shift+Alt+F8', command: 'reviewComments.previousOpen' },
      { label: '$(comment-add) Add Comment', description: process.platform === 'darwin' ? 'Cmd+Alt+M' : 'Ctrl+Alt+M', command: 'reviewComments.add' },
      { label: '$(list-tree) Show Comments Sidebar', command: 'workbench.view.extension.reviewComments' },
      { label: '$(export) Export Comments…', command: 'reviewComments.export' }
    );
    const choice = await vscode.window.showQuickPick(items, { placeHolder: `Review comments: ${counts.open} open of ${counts.total}` });
    if (choice?.command) { await vscode.commands.executeCommand(choice.command, ...(choice.args ?? [])); }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.status.dispose();
    this.changed.dispose();
  }
}
