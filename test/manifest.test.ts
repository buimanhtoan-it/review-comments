import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('release metadata and local package instructions stay consistent', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal(manifest.publisher, 'ToanBui');
  assert.equal(manifest.name, 'toanbui-review-comments');
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(manifest.license, 'ISC');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(lock.packages[''].license, manifest.license);
  assert.equal(manifest.repository.url, 'https://github.com/buimanhtoan-it/review-comments.git');
  assert.ok(fs.existsSync(path.join(root, 'LICENSE')));
  assert.ok(readme.includes(`${manifest.publisher}.${manifest.name}`));
  const packages = readme.match(/[a-z0-9-]+-\d+\.\d+\.\d+\.vsix/g) ?? [];
  assert.ok(packages.length > 0);
  assert.ok(packages.every(file => file === `${manifest.name}-${manifest.version}.vsix`));
});

test('extension branding uses correctly sized PNG assets', () => {
  const readPng = (asset: string, size: number): void => {
    const bytes = fs.readFileSync(path.join(root, asset));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${asset}: PNG signature`);
    assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(bytes.readUInt32BE(16), size, `${asset}: width`);
    assert.equal(bytes.readUInt32BE(20), size, `${asset}: height`);
    assert.equal(bytes[24], 8, `${asset}: 8-bit channels`);
    assert.equal(bytes[25], 6, `${asset}: RGBA with transparency`);
  };
  assert.equal(manifest.icon, 'media/logo.png');
  readPng(manifest.icon, 256);
  const container = manifest.contributes.viewsContainers.activitybar.find((item: { id: string }) => item.id === 'reviewComments');
  assert.equal(container.icon, 'media/logo-activity.png');
  readPng(container.icon, 48);
  assert.equal(fs.existsSync(path.join(root, 'media/review.svg')), false, 'Old branding is removed');
});

test('every menu command is contributed and there are no duplicate command IDs', () => {
  const ids = manifest.contributes.commands.map((command: { command: string }) => command.command);
  assert.equal(new Set(ids).size, ids.length);
  for (const menu of Object.values(manifest.contributes.menus) as Array<Array<{ command: string }>>) {
    for (const item of menu) { assert.ok(ids.includes(item.command), item.command); }
  }
});

test('interface vocabulary is review/copy only', () => {
  const sourceFiles = ['package.json', ...fs.readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.ts')).map(file => `src/${file}`)];
  for (const file of sourceFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /\b(?:AI|LLM|chat|Claude|GPT)\b/i, file);
  }
});

test('fast review bindings are scoped and copy notifications default to quiet', () => {
  const bindings = manifest.contributes.keybindings as Array<{ command: string; key: string; when: string }>;
  const add = bindings.find(item => item.command === 'reviewComments.add')!;
  assert.match(add.when, /!commentEditorFocused/);
  assert.doesNotMatch(add.when, /!editorReadonly/);
  assert.equal(bindings.find(item => item.command === 'reviewComments.copyOpen')?.key, 'ctrl+alt+c');
  assert.equal(bindings.find(item => item.command === 'reviewComments.nextOpen')?.key, 'alt+f8');
  assert.equal(manifest.contributes.configuration.properties['reviewComments.copyNotifications'].default, false);
});

test('global copy actions, counters, and themeable highlight colors are contributed', () => {
  const title = manifest.contributes.menus['editor/title'] as Array<{ command: string; when: string; group: string }>;
  const copyOpen = title.find(item => item.command === 'reviewComments.copyOpen')!;
  assert.match(copyOpen.group, /^navigation/, 'Copy Open is a visible title button');
  assert.match(copyOpen.when, /reviewComments\.hasOpen/);
  assert.ok(title.some(item => item.command === 'reviewComments.copyAll'));
  const colors = new Set((manifest.contributes.colors as Array<{ id: string }>).map(color => color.id));
  for (const id of ['openBorder', 'openBackground', 'activeBorder', 'activeBackground', 'activeLineBackground', 'resolvedBorder', 'staleBorder',
    'overviewRuler.open', 'overviewRuler.active', 'overviewRuler.resolved', 'overviewRuler.stale']) {
    assert.ok(colors.has(`reviewComments.${id}`), id);
  }
  const properties = manifest.contributes.configuration.properties;
  assert.equal(properties['reviewComments.toolbar'].default, 'whenComments');
  assert.equal(properties['reviewComments.highlights'].default, true);
  assert.equal(properties['reviewComments.statusBar'].default, true);
});

test('quick preview is the discoverable sidebar action with source and collapse alternatives', () => {
  assert.equal(manifest.contributes.configuration.properties['reviewComments.sidebarClickAction'].default, 'preview');
  for (const command of ['reviewComments.preview', 'reviewComments.collapseInline']) {
    assert.ok(manifest.contributes.commands.some((item: { command: string }) => item.command === command));
  }
  assert.ok(manifest.contributes.menus['view/item/context'].some((item: { command: string }) => item.command === 'reviewComments.preview'));
  assert.ok(manifest.contributes.menus['comments/commentThread/title'].some((item: { command: string }) => item.command === 'reviewComments.preview'));
});

test('native gutter templates have Cancel without a custom context value', () => {
  const cancel = manifest.contributes.menus['comments/commentThread/context'].find((item: { command: string }) => item.command === 'reviewComments.cancel');
  assert.match(cancel.when, /!commentThread/);
  assert.match(cancel.when, /commentController == reviewComments/);
});

test('file groups expose file-scoped context actions, never workspace-wide copy or delete', () => {
  const items = manifest.contributes.menus['view/item/context'] as Array<{ command: string; when: string; group: string }>;
  const fileItems = items.filter(item => item.when === 'view == reviewComments.list && viewItem == reviewFile');
  assert.deepEqual(fileItems.map(item => item.command), [
    'reviewComments.copyFile', 'reviewComments.copyFileOpen', 'reviewComments.copyFileResolved',
    'reviewComments.copyFileJson', 'reviewComments.openFile', 'reviewComments.addFile',
  ]);
  assert.ok(fileItems.every(item => !item.group.startsWith('inline')), 'Actions are in the right-click menu, not just row icons');
});

test('thread schema is bundled and schema matching covers independent JSON storage', () => {
  assert.equal(manifest.contributes.jsonValidation[0].fileMatch, '**/.review-comments/threads/*.json');
  assert.ok(fs.existsSync(path.join(root, 'schemas/thread.schema.json')));
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  assert.equal(manifest.dependencies, undefined, 'No runtime dependencies');
});
