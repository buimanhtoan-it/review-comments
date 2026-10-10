import assert = require('node:assert/strict');
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createAnchorResolver, createTextAnchor, relocateAnchor } from '../src/core/anchoring';
import { createThread, Position, TextAnchor, Thread } from '../src/core/model';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { Reviews } from '../src/reviews';

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start }, end: { line, character: end },
});

// Independent copy of the previous conservative search, not the compatibility wrapper.
function legacyRelocate(anchor: TextAnchor, text: string): TextAnchor {
  const sourceLines: { start: number; end: number }[] = [];
  const breaks = /\r\n|\r|\n/g;
  let offset = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    sourceLines.push({ start: offset, end: match.index });
    offset = match.index + match[0].length;
  }
  sourceLines.push({ start: offset, end: text.length });
  const positionAt = (index: number): Position | undefined => {
    const line = sourceLines.findIndex(item => index >= item.start && index <= item.end);
    return line < 0 ? undefined : { line, character: index - sourceLines[line].start };
  };
  const copied = (stale: boolean): TextAnchor => ({ ...anchor, range: structuredClone(anchor.range), stale });
  if (!anchor.snapshot.length && !anchor.before.length && !anchor.after.length) {
    return text.length ? copied(true) : { ...copied(false), range: range(0, 0, 0) };
  }
  const candidates: { start: number; end: number; context: number; sourceContext: number }[] = [];
  for (let start = text.indexOf(anchor.snapshot); start >= 0 && start <= text.length;) {
    const end = start + anchor.snapshot.length;
    const before = anchor.before.length > 0
      ? text.slice(Math.max(0, start - anchor.before.length), start) === anchor.before : start === 0;
    const after = anchor.after.length > 0
      ? text.slice(end, end + anchor.after.length) === anchor.after : end === text.length;
    if (positionAt(start) !== undefined && positionAt(end) !== undefined
        && (anchor.snapshot.length > 0 || (before && after))) {
      candidates.push({ start, end, context: Number(before) + Number(after),
        sourceContext: Number(anchor.before.length > 0 && before) + Number(anchor.after.length > 0 && after) });
    }
    if (start === text.length) break;
    start = text.indexOf(anchor.snapshot, start + 1);
  }
  let chosen: typeof candidates[number] | undefined;
  if (candidates.length === 1) {
    if (candidates[0].context > 0) chosen = candidates[0];
  } else if (candidates.length > 1) {
    const score = Math.max(...candidates.map(candidate => candidate.sourceContext));
    const best = candidates.filter(candidate => candidate.sourceContext === score);
    if (score > 0 && best.length === 1) chosen = best[0];
  }
  return chosen ? { ...copied(false), range: { start: positionAt(chosen.start)!, end: positionAt(chosen.end)! } } : copied(true);
}

test('prepared relocation agrees with the previous conservative algorithm across source generations', () => {
  const sources = ['', 'x', 'aaaa', 'head\nitem\ntail', 'one\r\ntwo\rthree\nfour',
    'first\n\nlast', '😀é\r\n日本語\nend', 'prefix\nitem\nsuffix\nprefix\nitem\nsuffix'];
  let comparisons = 0;
  for (const source of sources) {
    const sourceLines = source.split(/\r\n|\r|\n/);
    const anchors = sourceLines.flatMap((line, lineNumber) => {
      const result: TextAnchor[] = [];
      for (let start = 0; start <= line.length; start++) {
        for (const end of new Set([start, Math.min(start + 1, line.length), line.length])) {
          const anchor = createTextAnchor(source, range(lineNumber, start, end));
          result.push(anchor, { ...anchor, before: '', after: '' }, { ...anchor, before: 'missing', after: 'missing' });
        }
      }
      return result;
    });
    anchors.push(createTextAnchor(source, { start: { line: 0, character: 0 },
      end: { line: sourceLines.length - 1, character: sourceLines[sourceLines.length - 1].length } }));
    for (const target of [source, `new\r\n${source}`, `${source}\n${source}`, source.replace(/item/g, 'edited'), '']) {
      const resolve = createAnchorResolver(target);
      for (const anchor of anchors) {
        const expected = legacyRelocate(anchor, target);
        assert.deepEqual(resolve(anchor), expected);
        assert.deepEqual(relocateAnchor(anchor, target), expected);
        comparisons++;
      }
      assert.equal(resolve.diagnostics().lineIndexBuilds, 1);
    }
  }
  assert.ok(comparisons > 1_000);
});

test('occurrence reuse never reuses anchor context, metadata, mutable coordinates, or another generation', () => {
  const text = 'left:item:right\nother:item:end';
  const first: TextAnchor = {
    kind: 'text', snapshot: 'item', before: 'left:', after: ':right', stale: false, range: range(0, 5, 9),
  };
  const second = { ...first, before: 'other:', after: ':end', range: range(1, 6, 10) };
  const extended = {
    ...first, custom: { retained: [1, 'yes'] },
    range: { ...first.range, extension: 'range', start: { ...first.range.start, affinity: 'left' } },
  };
  const original = structuredClone(extended);
  Object.freeze(extended.range.start);
  Object.freeze(extended.range.end);
  Object.freeze(extended.range);
  Object.freeze(extended);
  const resolve = createAnchorResolver(text);
  const relocated = resolve(extended);
  assert.deepEqual(relocated, extended);
  assert.notEqual(relocated, extended);
  assert.notEqual(relocated.range, extended.range);
  assert.notEqual(relocated.range.start, extended.range.start);
  relocated.range.start.character = 100;
  assert.deepEqual(resolve(extended), original, 'Mutating output cannot poison cached occurrence positions');
  assert.deepEqual(resolve(second).range, range(1, 6, 10), 'Same snapshot, different context');
  assert.equal(resolve({ ...first, before: 'missing', after: 'missing' }).stale, true);
  assert.deepEqual(extended, original, 'Stored snapshot/context and extension fields remain immutable');
  assert.equal(resolve.diagnostics().occurrenceScans, 1);
  assert.equal(resolve.diagnostics().occurrenceCacheHits, 3);
  assert.ok(Object.isFrozen(resolve.diagnostics()));
  const changed = createAnchorResolver(`inserted\n${text}`);
  assert.deepEqual(changed(first).range, range(1, 5, 9));
  assert.deepEqual(resolve(first).range, range(0, 5, 9));
  assert.equal(changed.diagnostics().occurrenceScans, 1);
  const ambiguous = createAnchorResolver('left:item:right\nleft:item:right');
  assert.equal(ambiguous(first).stale, true, 'Old coordinates never settle an ambiguous tie');
});

test('prepared occurrence caches are bounded, including absent, very common, and huge snapshots', () => {
  const resolve = createAnchorResolver('x'.repeat(20_000));
  const anchor: TextAnchor = { kind: 'text', range: range(0, 0, 1), snapshot: 'x', before: '', after: '', stale: false };
  assert.equal(resolve(anchor).stale, true);
  assert.equal(resolve.diagnostics().cachedOccurrences, 0, 'An oversized occurrence list is streamed, not retained');
  resolve(anchor);
  assert.equal(resolve.diagnostics().occurrenceScans, 2);
  for (let index = 0; index < 200; index++) resolve({ ...anchor, snapshot: `absent-${index}` });
  assert.equal(resolve.diagnostics().cachedSnapshots, 128);
  const before = resolve.diagnostics().occurrenceScans;
  resolve({ ...anchor, snapshot: 'absent-0' });
  assert.equal(resolve.diagnostics().occurrenceScans, before + 1, 'Evicted entries are safely recomputed');
  for (let index = 0; index < 200; index++) resolve({ ...anchor, snapshot: `${index}${'z'.repeat(4_096)}` });
  const stats = resolve.diagnostics();
  assert.ok(stats.cachedSnapshots <= 128);
  assert.ok(stats.cachedOccurrences <= 16_384);
  assert.ok(stats.cachedSnapshotCharacters <= 262_144);
  resolve({ ...anchor, snapshot: 'z'.repeat(300_000) });
  assert.equal(resolve.diagnostics().cachedSnapshotCharacters, stats.cachedSnapshotCharacters);
  const empty = { ...anchor, snapshot: '', before: 'x', after: 'x' };
  assert.equal(resolve(empty).stale, true, 'Numerous zero-width matches remain ambiguous');
  assert.ok(resolve.diagnostics().cachedOccurrences <= 16_384);
});

// Exercise the actual Reviews implementation without launching an extension host.
class Emitter<T = void> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void { for (const listener of [...this.listeners]) listener(value); }
  dispose(): void { this.listeners.clear(); }
}

function reviewHarness(initial: Thread[], text = 'head\nitem\ntail') {
  const uri = (value: string) => ({ scheme: 'file', authority: '', fsPath: value, toString: () => value });
  const root = uri('file:///fixture');
  const folder = { name: 'Fixture', uri: root, index: 0 };
  let reads = 0;
  const doc = { uri: uri(`${root}/source.txt`), version: 1, isClosed: false, isDirty: false,
    getText: () => { reads++; return text; } };
  const opened = new Emitter<typeof doc>();
  const closed = new Emitter<typeof doc>();
  const edited = new Emitter<{ document: typeof doc; contentChanges: unknown[] }>();
  const folders = new Emitter<void>();
  const watcher = new Emitter<void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let beforeSave: ((thread: Thread) => Promise<void>) | undefined;
  const disk = new Map(initial.map(thread => [thread.id, structuredClone(thread)]));
  const warnings: string[] = [];
  const loadErrors: string[] = [];
  class Repository {
    async loadAll() { return { threads: [...disk.values()].map(thread => structuredClone(thread)), errors: [...loadErrors] }; }
    async save(thread: Thread, revision: number) {
      await beforeSave?.(thread);
      if ((disk.get(thread.id)?.revision ?? 0) !== revision) throw new Error('revision conflict');
      const saved = structuredClone({ ...thread, revision: revision + 1 });
      disk.set(thread.id, saved);
      return structuredClone(saved);
    }
    async delete(id: string, revision: number) {
      if (disk.get(id)?.revision !== revision) throw new Error('revision conflict');
      disk.delete(id);
    }
  }
  const workspace = {
    workspaceFolders: [folder], textDocuments: [doc],
    getWorkspaceFolder: () => folder,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeWorkspaceFolders: folders.event,
    onDidSaveTextDocument: new Emitter().event,
    onDidRenameFiles: new Emitter().event,
    onDidOpenTextDocument: opened.event,
    onDidCloseTextDocument: closed.event,
    onDidChangeTextDocument: edited.event,
    createFileSystemWatcher: () => ({ onDidChange: watcher.event, onDidCreate: watcher.event,
      onDidDelete: watcher.event, dispose() {} }),
  };
  const vscode = { EventEmitter: Emitter, workspace,
    Uri: { joinPath: (base: { toString(): string }, ...parts: string[]) => uri(`${base}/${parts.join('/')}`) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showWarningMessage: async (message: string) => { warnings.push(message); },
    } };
  const sourcePath = path.resolve(__dirname, __filename.endsWith('.ts') ? '../src/reviews.ts' : '../../src/reviews.ts');
  const script = transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  const localRequire = createRequire(path.resolve(__dirname, '../src/reviews.js'));
  const exported: { Reviews?: new () => Reviews } = {};
  new Function('require', 'exports', 'setTimeout', 'clearTimeout', script)(
    (id: string) => id === 'vscode' ? vscode : id === './core/storage' ? { ThreadRepository: Repository } : localRequire(id),
    exported, (action: () => void) => { timers.set(++timerId, action); return timerId; },
    (id: number) => { timers.delete(id); });
  const reviews = new exported.Reviews!();
  return { reviews, doc, disk, workspace, folders, opened, closed, edited, watcher, warnings, loadErrors,
    reads: () => reads, timers,
    changeText: (value: string) => { text = value; doc.version++; },
    beforeSave: (action?: (thread: Thread) => Promise<void>) => { beforeSave = action; },
    flush: () => { const pending = [...timers.values()]; timers.clear(); for (const action of pending) action(); },
    save: () => (reviews as unknown as { saved(document: typeof doc): Promise<void> }).saved(doc),
    reset: () => (reviews as unknown as { resetFolders(): Promise<void> }).resetFolders(),
  };
}

const reviewFixture = (count: number) => Array.from({ length: count }, () =>
  createThread('source.txt', createTextAnchor('head\nitem\ntail', range(1, 0, 4)), 'Review', 'Reviewer'));

test('Reviews indexes and document generations eliminate repeated work and unchanged loads retain identity', async context => {
  const h = reviewHarness(reviewFixture(600));
  const { reviews } = h;
  try {
    let dataEvents = 0, visualEvents = 0;
    reviews.onDidChangeData(() => { dataEvents++; });
    reviews.onDidChange(() => { visualEvents++; });
    await reviews.initialize();
    const refs = reviews.all();
    assert.equal(refs.length, 600);
    assert.notEqual(reviews.all(), refs);
    refs.reverse();
    assert.notEqual(reviews.all()[0], refs[0], 'Caller sorting never changes the owned index');
    const views = refs.map(ref => reviews.view(ref));
    for (let pass = 0; pass < 4; pass++) {
      refs.forEach((ref, index) => {
        assert.equal(reviews.find(reviews.key(ref)), ref);
        assert.equal(reviews.find(ref.data.id), ref);
        assert.equal(reviews.uri(ref), reviews.uri(ref));
        assert.equal(reviews.view(ref), views[index]);
      });
    }
    assert.equal(h.reads(), 1);
    assert.equal(reviews.diagnostics().viewComputations, 600);
    assert.equal(reviews.diagnostics().viewCacheHits, 2400);
    assert.equal(reviews.diagnostics().indexBuilds, 1);
    await reviews.refresh();
    assert.equal(dataEvents, 1);
    assert.equal(visualEvents, 1);
    refs.forEach(ref => assert.equal(reviews.require(ref.data.id), ref));
    const changed = refs[0];
    const diskThread = h.disk.get(changed.data.id)!;
    diskThread.metadata = { manual: 'same revision, unknown JSON field' };
    h.watcher.fire();
    h.flush();
    await reviews.refresh(); // Join the watcher's queued read; the second unchanged load must not emit.
    assert.notEqual(reviews.require(changed.data.id), changed);
    assert.equal(reviews.require(refs[1].data.id), refs[1]);
    assert.equal(dataEvents, 2);
    h.changeText('new\nhead\nitem\ntail');
    h.edited.fire({ document: h.doc, contentChanges: [{}] });
    assert.equal(h.timers.size, 1);
    h.flush();
    assert.equal(dataEvents, 2, 'Source events are visual only');
    assert.equal(visualEvents, 3);
    refs.forEach(ref => reviews.view(reviews.require(ref.data.id)));
    assert.equal(h.reads(), 2);
    const current = reviews.require(changed.data.id);
    const closedView = reviews.view(current);
    h.closed.fire(h.doc);
    assert.equal(reviews.diagnostics().documentCaches, 0);
    assert.equal(reviews.view(current), current.data);
    const reopened = { ...h.doc, getText: () => 'other\nnew\nhead\nitem\ntail' };
    h.opened.fire(reopened);
    const freshView = reviews.view(current);
    assert.notEqual(freshView, closedView, 'Same URI/version but a different document identity rebuilds');
    assert.equal(freshView.anchor.kind === 'text' && freshView.anchor.range.start.line, 3);
    h.disk.clear();
    await reviews.refresh();
    assert.equal(reviews.all().length, 0);
    assert.equal(reviews.diagnostics().documentCaches, 0);
    assert.equal(reviews.find(current.data.id), undefined);
    const before = visualEvents;
    h.edited.fire({ document: h.doc, contentChanges: [{}] });
    h.flush();
    assert.equal(visualEvents, before, 'Sources without comments cause no refresh');
    h.loadErrors.push('corrupt.json: invalid JSON');
    await reviews.refresh();
    assert.equal(h.warnings.length, 1, 'Unchanged loads still report errors');
    context.diagnostic(JSON.stringify(reviews.diagnostics()));
  } finally { reviews.dispose(); }
});

test('scoped indexes keep duplicate UUIDs independent and folder removal invalidates the bare-id index', async () => {
  const h = reviewHarness(reviewFixture(1));
  const root = h.workspace.workspaceFolders[0];
  const second = { ...root, name: 'Second', index: 1,
    uri: { ...root.uri, fsPath: 'file:///second', toString: () => 'file:///second' } };
  h.workspace.workspaceFolders.push(second);
  try {
    await h.reviews.initialize();
    const refs = h.reviews.all();
    assert.equal(refs.length, 2);
    assert.equal(refs[0].data.id, refs[1].data.id);
    assert.notEqual(h.reviews.key(refs[0]), h.reviews.key(refs[1]));
    assert.notEqual(h.reviews.uri(refs[0]).toString(), h.reviews.uri(refs[1]).toString());
    assert.throws(() => h.reviews.find(refs[0].data.id), /Ambiguous/);
    for (const ref of refs) assert.equal(h.reviews.find(h.reviews.key(ref)), ref);
    h.workspace.workspaceFolders.pop();
    await h.reset();
    assert.equal(h.reviews.find(refs[0].data.id), refs[0]);
    assert.equal(h.reviews.find(h.reviews.key(refs[1])), undefined);
  } finally { h.reviews.dispose(); }
});

test('saved anchors batch once, unrelated concurrent writes emit, and failed anchors do not drop remaining updates', async () => {
  const h = reviewHarness(reviewFixture(3));
  const { reviews } = h;
  try {
    await reviews.initialize();
    const refs = reviews.all();
    let events = 0;
    reviews.onDidChangeData(() => { events++; });
    h.changeText('new\nhead\nitem\ntail');
    await h.save();
    assert.equal(events, 1);
    for (const ref of refs) assert.equal(reviews.require(ref.data.id).data.revision, 1);
    await h.save();
    assert.equal(events, 1, 'Unchanged anchor save emits nothing');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    h.beforeSave(async () => { if (first) { first = false; entered(); await gate; } });
    h.changeText('another\nnew\nhead\nitem\ntail');
    const saved = h.save();
    await started;
    const reply = reviews.reply(refs[2].data.id, 'Concurrent reply');
    release();
    await Promise.all([saved, reply]);
    assert.equal(events, 3, 'One anchor batch plus the unrelated reply event');
    assert.equal(reviews.require(refs[2].data.id).data.comments.length, 2);
    h.beforeSave(async thread => { if (thread.id === refs[1].data.id) throw new Error('simulated save failure'); });
    h.changeText('latest\nanother\nnew\nhead\nitem\ntail');
    await assert.rejects(h.save(), /simulated save failure/);
    assert.equal(events, 4, 'Partial successful save still emits one batch');
    for (const ref of [refs[0], refs[2]]) {
      const anchor = reviews.require(ref.data.id).data.anchor;
      assert.equal(anchor.kind === 'text' && anchor.range.start.line, 4);
    }
    h.beforeSave();
    await assert.rejects(reviews.remove(refs[0].data.id, false, { revision: 0 }), /revision conflict/);
    assert.ok(reviews.find(refs[0].data.id));
    await reviews.remove(refs[0].data.id, false);
    assert.equal(reviews.find(refs[0].data.id), undefined);
    h.workspace.workspaceFolders = [];
    await h.reset();
    assert.equal(reviews.all().length, 0);
    assert.equal(reviews.diagnostics().documentCaches, 0);
  } finally { reviews.dispose(); }
});

test('many comments share one source line index and repeated-snapshot scans (timing is informational)', context => {
  const sourceLines = Array.from({ length: 8_000 }, (_, index) =>
    `section ${index.toString().padStart(5, '0')}: selected excerpt with stable context and explanatory text.`);
  const source = sourceLines.join('\n');
  const seeds = Array.from({ length: 40 }, (_, index) => {
    const line = index * 179 + 10;
    return createTextAnchor(source, range(line, 0, sourceLines[line].length));
  });
  const anchors = Array.from({ length: 600 }, (_, index) => ({ ...seeds[index % seeds.length] }));
  const text = `inserted introduction\n${source}`;
  const baselineStart = performance.now();
  const baseline = anchors.map(anchor => relocateAnchor(anchor, text));
  const baselineMs = performance.now() - baselineStart;
  const sharedStart = performance.now();
  const resolve = createAnchorResolver(text);
  const shared = anchors.map(resolve);
  const sharedMs = performance.now() - sharedStart;
  assert.deepEqual(shared, baseline);
  assert.ok(shared.every(anchor => !anchor.stale));
  const stats = resolve.diagnostics();
  assert.equal(stats.lineIndexBuilds, 1);
  assert.equal(stats.occurrenceScans, 40);
  assert.equal(stats.occurrenceCacheHits, 560);
  assert.equal(stats.cachedSnapshots, 40);
  assert.equal(stats.cachedOccurrences, 40);
  context.diagnostic(JSON.stringify({ comments: anchors.length, lines: sourceLines.length + 1,
    utf16Characters: text.length, baselineMs: Number(baselineMs.toFixed(2)), sharedMs: Number(sharedMs.toFixed(2)),
    observedSpeedup: Number((baselineMs / sharedMs).toFixed(2)), baselineLineIndexBuilds: anchors.length, ...stats }));
});
