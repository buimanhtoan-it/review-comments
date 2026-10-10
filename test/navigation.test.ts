import assert = require('node:assert/strict');
import { test } from 'node:test';
import { chooseNextKey, NavigationItem, NavigationLocation } from '../src/core/navigation';

const item = (key: string, overrides: Partial<NavigationItem> = {}): NavigationItem => ({
  key, folderUri: 'file:///workspace/a', path: 'notes.txt', status: 'open', ...overrides
});
const location = (line: number, character = 0, overrides: Partial<NavigationLocation> = {}): NavigationLocation => ({
  folderUri: 'file:///workspace/a', path: 'notes.txt', position: { line, character }, ...overrides
});

test('empty and entirely resolved lists have no navigation target', () => {
  for (const direction of [1, -1] as const) {
    assert.equal(chooseNextKey([], direction), undefined);
    assert.equal(chooseNextKey([item('resolved', { status: 'resolved' })], direction), undefined);
  }
});

test('navigation orders folder URI, path, file comments, line, character, and scoped key', () => {
  const items = [
    item('folder-b', { folderUri: 'file:///workspace/b', path: 'a.txt' }),
    item('later-file', { path: 'z.txt' }),
    item('line-two', { position: { line: 2, character: 0 } }),
    item('same-position-b', { position: { line: 0, character: 2 } }),
    item('same-position-a', { position: { line: 0, character: 2 } }),
    item('line-zero', { position: { line: 0, character: 0 } }),
    item('file-note'),
    item('earlier-file', { path: 'a.txt' }),
    item('resolved', { status: 'resolved', path: '0.txt' })
  ];
  const original = structuredClone(items);
  const expected = ['earlier-file', 'file-note', 'line-zero', 'same-position-a', 'same-position-b', 'line-two', 'later-file', 'folder-b'];
  let key: string | undefined;
  for (const expectedKey of expected) {
    key = chooseNextKey(items, 1, key);
    assert.equal(key, expectedKey);
  }
  assert.equal(chooseNextKey(items, 1, key), expected[0]);
  assert.equal(chooseNextKey(items, -1), expected.at(-1));
  assert.deepEqual(items, original);
});

test('next and previous wrap and ignore resolved comments', () => {
  const items = [item('first'), item('resolved', { status: 'resolved' }), item('last', { path: 'z.txt' })];
  assert.equal(chooseNextKey(items, 1, 'first'), 'last');
  assert.equal(chooseNextKey(items, -1, 'last'), 'first');
  assert.equal(chooseNextKey(items, 1, 'last'), 'first');
  assert.equal(chooseNextKey(items, -1, 'first'), 'last');
  assert.equal(chooseNextKey([item('only')], 1, 'only'), 'only');
  assert.equal(chooseNextKey([item('only')], -1, 'only'), 'only');
});

test('cursor navigation includes exact positions and places file comments before text', () => {
  const items = [item('file'), item('early', { position: { line: 2, character: 3 } }), item('late', { position: { line: 4, character: 1 } })];
  assert.equal(chooseNextKey(items, 1, undefined, location(2, 3)), 'early');
  assert.equal(chooseNextKey(items, -1, undefined, location(2, 3)), 'early');
  assert.equal(chooseNextKey(items, 1, undefined, location(2, 4)), 'late');
  assert.equal(chooseNextKey(items, -1, undefined, location(2, 4)), 'early');
  assert.equal(chooseNextKey(items, -1, undefined, location(0)), 'file');
  assert.equal(chooseNextKey(items, 1, undefined, location(5)), 'file');
});

test('cursor navigation crosses files and folders with deterministic wrap', () => {
  const items = [item('first', { path: 'a.txt' }), item('last', { folderUri: 'file:///workspace/c', path: 'z.txt' })];
  const between = location(10, 0, { folderUri: 'file:///workspace/b' });
  assert.equal(chooseNextKey(items, 1, undefined, between), 'last');
  assert.equal(chooseNextKey(items, -1, undefined, between), 'first');
  assert.equal(chooseNextKey(items, 1, undefined, location(10, 0, { path: 'b.txt' })), 'last');
  assert.equal(chooseNextKey(items, -1, undefined, location(10, 0, { path: 'b.txt' })), 'first');
  assert.equal(chooseNextKey(items, -1, undefined, location(0, 0, { path: '0.txt' })), 'last');
});

test('a different active file or folder overrides the previously opened key', () => {
  const items = [item('old'), item('target', { path: 'target.txt', position: { line: 3, character: 0 } }), item('after', { path: 'z.txt' })];
  assert.equal(chooseNextKey(items, 1, 'old', location(4, 0, { path: 'target.txt' })), 'after');
  assert.equal(chooseNextKey(items, -1, 'old', location(4, 0, { path: 'target.txt' })), 'target');
  assert.equal(chooseNextKey(items, 1, 'old', location(0, 0, { folderUri: 'file:///workspace/z' })), 'old');
});

test('the current scoped key advances through comments sharing a position', () => {
  const first = item(JSON.stringify(['file:///workspace/a', 'shared-id']), { position: { line: 2, character: 0 } });
  const second = item(JSON.stringify(['file:///workspace/b', 'shared-id']), { folderUri: 'file:///workspace/b', position: { line: 2, character: 0 } });
  assert.equal(chooseNextKey([second, first], 1, first.key), second.key);
  assert.equal(chooseNextKey([second, first], -1, second.key), first.key);
  const samePosition = [item('a', { position: { line: 2, character: 0 } }), item('b', { position: { line: 2, character: 0 } })];
  assert.equal(chooseNextKey(samePosition, 1, 'a', location(2)), 'b');
  assert.equal(chooseNextKey(samePosition, -1, 'b', location(2)), 'a');
});

test('removed or resolved current keys fall back to the active cursor', () => {
  const items = [item('early', { position: { line: 1, character: 0 } }), item('resolved', { status: 'resolved', position: { line: 2, character: 0 } }), item('late', { position: { line: 3, character: 0 } })];
  for (const key of ['removed', 'resolved']) {
    assert.equal(chooseNextKey(items, 1, key, location(2)), 'late');
    assert.equal(chooseNextKey(items, -1, key, location(2)), 'early');
  }
});
