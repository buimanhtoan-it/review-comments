import assert = require('node:assert/strict');
import { test } from 'node:test';
import { containsPosition, groupHighlights, HighlightGroups, HighlightInput } from '../src/core/highlights';

const item = (key: string, start: [number, number], end: [number, number], overrides: Partial<HighlightInput> = {}): HighlightInput => ({
  key,
  status: 'open',
  stale: false,
  range: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } },
  ...overrides
});
const at = (line: number, character: number) => ({ line, character });
const keys = (groups: HighlightGroups) => ({
  active: groups.active?.key,
  open: groups.open.map(entry => entry.key),
  resolved: groups.resolved.map(entry => entry.key),
  stale: groups.stale.map(entry => entry.key)
});

test('without an active key or cursor every visible item is grouped by state', () => {
  const items = [
    item('open', [1, 0], [1, 5]),
    item('resolved', [2, 0], [2, 5], { status: 'resolved' }),
    item('stale', [3, 0], [3, 5], { stale: true })
  ];
  assert.deepEqual(keys(groupHighlights(items, { showResolved: true })),
    { active: undefined, open: ['open'], resolved: ['resolved'], stale: ['stale'] });
  assert.equal('active' in groupHighlights(items, { showResolved: true }), false);
});

test('an explicit active key wins over the cursor and is excluded from other groups', () => {
  const items = [item('outer', [1, 0], [5, 0]), item('inner', [2, 2], [2, 6]), item('chosen', [8, 0], [8, 4])];
  const groups = groupHighlights(items, { activeKey: 'chosen', cursor: at(2, 3), showResolved: true });
  assert.deepEqual(keys(groups), { active: 'chosen', open: ['outer', 'inner'], resolved: [], stale: [] });
  assert.equal(groups.active, items[2]);
});

test('an explicit key that is not in this editor falls back to the cursor', () => {
  const items = [item('here', [1, 0], [1, 9])];
  assert.equal(groupHighlights(items, { activeKey: 'elsewhere', cursor: at(1, 4), showResolved: true }).active?.key, 'here');
  assert.equal(groupHighlights(items, { activeKey: 'elsewhere', showResolved: true }).active, undefined);
});

test('cursor containment selects the smallest containing range', () => {
  const items = [
    item('document', [0, 0], [20, 0]),
    item('paragraph', [2, 0], [6, 10]),
    item('sentence', [3, 4], [3, 30]),
    item('word', [3, 10], [3, 14]),
    item('other', [9, 0], [9, 3])
  ];
  const active = (line: number, character: number) => groupHighlights(items, { cursor: at(line, character), showResolved: true }).active?.key;
  assert.equal(active(3, 12), 'word');
  assert.equal(active(3, 5), 'sentence');
  assert.equal(active(5, 0), 'paragraph');
  assert.equal(active(15, 0), 'document');
  assert.equal(active(30, 0), undefined);
  const groups = groupHighlights(items, { cursor: at(3, 12), showResolved: true });
  assert.deepEqual(groups.open.map(entry => entry.key), ['document', 'paragraph', 'sentence', 'other']);
});

test('containment includes both ends and empty ranges match their line', () => {
  const selection = item('selection', [4, 2], [6, 7]);
  assert.equal(containsPosition(selection.range, at(4, 2)), true);
  assert.equal(containsPosition(selection.range, at(6, 7)), true, 'cursor left at the end of a selection');
  assert.equal(containsPosition(selection.range, at(4, 1)), false);
  assert.equal(containsPosition(selection.range, at(6, 8)), false);
  const empty = item('empty', [7, 3], [7, 3]);
  assert.equal(containsPosition(empty.range, at(7, 0)), true);
  assert.equal(containsPosition(empty.range, at(7, 50)), true);
  assert.equal(containsPosition(empty.range, at(8, 0)), false);
  assert.equal(groupHighlights([selection, empty], { cursor: at(7, 9), showResolved: true }).active?.key, 'empty');
  assert.equal(groupHighlights([selection], { cursor: at(6, 7), showResolved: true }).active?.key, 'selection');
});

test('a tie on range size prefers the open thread', () => {
  const items = [
    item('a-resolved', [2, 0], [2, 8], { status: 'resolved' }),
    item('b-open', [2, 0], [2, 8]),
    item('c-resolved', [2, 0], [2, 8], { status: 'resolved' })
  ];
  for (const order of [items, [...items].reverse()]) {
    const groups = groupHighlights(order, { cursor: at(2, 4), showResolved: true });
    assert.deepEqual(keys(groups), { active: 'b-open', open: [], resolved: ['a-resolved', 'c-resolved'], stale: [] });
  }
  const resolvedOnly = [items[0]!, items[2]!];
  assert.equal(groupHighlights(resolvedOnly, { cursor: at(2, 4), showResolved: true }).active?.key, 'a-resolved');
});

test('resolved threads are omitted when they are hidden', () => {
  const items = [
    item('open', [1, 0], [1, 5]),
    item('resolved', [2, 0], [2, 5], { status: 'resolved' }),
    item('resolved-stale', [3, 0], [3, 5], { status: 'resolved', stale: true })
  ];
  assert.deepEqual(keys(groupHighlights(items, { showResolved: false })),
    { active: undefined, open: ['open'], resolved: [], stale: [] });
  // A hidden thread never becomes active from the cursor alone.
  assert.equal(groupHighlights(items, { cursor: at(2, 1), showResolved: false }).active, undefined);
  // An explicit selection, such as from the sidebar, is still shown.
  assert.deepEqual(keys(groupHighlights(items, { activeKey: 'resolved', showResolved: false })),
    { active: 'resolved', open: ['open'], resolved: [], stale: [] });
});

test('stale threads are grouped as stale regardless of status', () => {
  const items = [
    item('open-stale', [1, 0], [1, 5], { stale: true }),
    item('resolved-stale', [2, 0], [2, 5], { status: 'resolved', stale: true }),
    item('open', [3, 0], [3, 5]),
    item('resolved', [4, 0], [4, 5], { status: 'resolved' })
  ];
  assert.deepEqual(keys(groupHighlights(items, { showResolved: true })),
    { active: undefined, open: ['open'], resolved: ['resolved'], stale: ['open-stale', 'resolved-stale'] });
  const activeStale = groupHighlights(items, { activeKey: 'open-stale', showResolved: true });
  assert.deepEqual(keys(activeStale), { active: 'open-stale', open: ['open'], resolved: ['resolved'], stale: ['resolved-stale'] });
  assert.equal(groupHighlights(items, { cursor: at(1, 2), showResolved: true }).active?.key, 'open-stale');
});

test('the cursor-selected thread is excluded from every other group', () => {
  const items = [
    item('open', [1, 0], [1, 5]),
    item('resolved', [2, 0], [2, 5], { status: 'resolved' }),
    item('stale', [3, 0], [3, 5], { stale: true })
  ];
  for (const [line, key] of [[1, 'open'], [2, 'resolved'], [3, 'stale']] as const) {
    const groups = groupHighlights(items, { cursor: at(line, 2), showResolved: true });
    assert.equal(groups.active?.key, key);
    const grouped = [...groups.open, ...groups.resolved, ...groups.stale].map(entry => entry.key);
    assert.equal(grouped.includes(key), false);
    assert.equal(grouped.length, 2);
  }
});

test('grouping is deterministic and does not mutate its input', () => {
  const items = [
    item('z', [5, 0], [5, 2]),
    item('b', [1, 0], [1, 4]),
    item('a', [1, 0], [1, 4]),
    item('c', [1, 0], [2, 0]),
    item('s2', [4, 0], [4, 1], { stale: true }),
    item('s1', [0, 0], [0, 1], { stale: true })
  ];
  const original = structuredClone(items);
  const expected = { active: undefined, open: ['a', 'b', 'c', 'z'], resolved: [], stale: ['s1', 's2'] };
  assert.deepEqual(keys(groupHighlights(items, { showResolved: true })), expected);
  assert.deepEqual(keys(groupHighlights([...items].reverse(), { showResolved: true })), expected);
  assert.deepEqual(items, original);
  // Identical ranges resolve by key so the cursor choice is stable too.
  assert.equal(groupHighlights(items, { cursor: at(1, 2), showResolved: true }).active?.key, 'a');
  assert.equal(groupHighlights([...items].reverse(), { cursor: at(1, 2), showResolved: true }).active?.key, 'a');
});
