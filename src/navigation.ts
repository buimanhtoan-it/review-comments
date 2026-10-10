import * as vscode from 'vscode';
import * as path from 'node:path';
import { Reviews } from './reviews';
import { chooseNextKey, NavigationLocation } from './core/navigation';

export class ReviewNavigation {
  private lastKey: string | undefined;

  constructor(private readonly reviews: Reviews, private readonly open: (key: string) => Promise<void>) {}

  reset(): void { this.lastKey = undefined; }

  async move(direction: 1 | -1): Promise<void> {
    const refs = this.reviews.all();
    const editor = vscode.window.activeTextEditor;
    const last = refs.find(ref => this.reviews.key(ref) === this.lastKey);
    const currentKey = last && (!editor || this.reviews.uri(last).toString() === editor.document.uri.toString())
      ? this.lastKey : undefined;
    const folder = editor && this.reviews.folderFor(editor.document.uri);
    const location: NavigationLocation | undefined = editor && folder ? {
      folderUri: folder.folder.uri.toString(),
      path: path.relative(folder.folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/'),
      position: { line: editor.selection.active.line, character: editor.selection.active.character }
    } : undefined;
    const items = refs.map(ref => {
      const thread = this.reviews.view(ref);
      return {
        key: this.reviews.key(ref),
        folderUri: ref.folder.folder.uri.toString(),
        path: thread.resource.path,
        status: thread.status,
        position: thread.anchor.kind === 'text' ? thread.anchor.range.start : undefined
      };
    });
    const key = chooseNextKey(items, direction, currentKey, location);
    if (!key) {
      vscode.window.setStatusBarMessage('No open review comments.', 3000);
      return;
    }
    await this.open(key);
    this.lastKey = key;
  }
}
