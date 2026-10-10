import assert = require('node:assert/strict');
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createThread, parseThread, Thread } from '../src/core/model';
import { ThreadRepository } from '../src/core/storage';
import { createTextAnchor, relocateAnchor } from '../src/core/anchoring';
import { formatJson, formatMarkdown } from '../src/core/export';

const range = (startLine: number, startCharacter: number, endLine: number, endCharacter: number) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

const sample = (): Thread => createThread('src/example.ts', { kind: 'file' }, 'Please review this value.', 'Reviewer');

async function fixture(run: (repository: ThreadRepository, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-comments-'));
  try {
    await run(new ThreadRepository(root), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('thread records roundtrip Unicode and unknown extension properties without mutation', () => {
  const thread = createThread('Tài liệu/日本語 source.ts', { kind: 'file' }, 'Kiểm tra nội dung 日本語 🌍', 'Nguyễn');
  thread.metadata = { nested: { enabled: true, values: [null, 3, 'é'] } };
  thread.extra = { version: 2 };
  thread.comments[0]!.extension = ['preserved'];
  const parsed = parseThread(JSON.parse(JSON.stringify(thread)) as unknown);
  assert.deepEqual(parsed, thread);
  assert.notEqual(parsed, thread);
  assert.notEqual(parsed.metadata, thread.metadata);
  assert.equal(parsed.revision, 0);
  assert.notEqual(parsed.id, parsed.comments[0]!.id);
  assert.deepEqual(parseThread({ ...thread, resource: { ...thread.resource, label: 'keep' } }).resource,
    { path: thread.resource.path, label: 'keep' });
});

test('validation rejects unsupported versions and unsafe resource paths', () => {
  const thread = sample();
  for (const schemaVersion of [0, 2, '1', null, undefined]) {
    assert.throws(() => parseThread({ ...thread, schemaVersion }), /schemaVersion/);
  }
  for (const resourcePath of ['', ' ', '/tmp/file', '../file', 'x/../file', './file', 'x/./file',
    'C:/file', 'c:relative', '\\server\\file', 'dir\\file', 'a//b', 'a/', 'a\u0000b', 'a\nb']) {
    assert.throws(() => parseThread({ ...thread, resource: { path: resourcePath } }), /resource.path/);
  }
  for (const resourcePath of ['folder/file name.ts', '日本語/é.ts', '.config/file', 'dir/.../file']) {
    assert.equal(parseThread({ ...thread, resource: { path: resourcePath } }).resource.path, resourcePath);
  }
});

test('validation rejects unsafe IDs, invalid positions, malformed fields, and lossy JSON', () => {
  const thread = sample();
  for (const id of ['../../x', 'not-a-uuid', `${thread.id}\n`, thread.id.replace(/.$/, '/'), null]) {
    assert.throws(() => parseThread({ ...thread, id }), /UUID/);
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => parseThread({ ...thread, revision }));
  }
  for (const anchorRange of [range(-1, 0, 0, 1), range(0, -1, 0, 1), range(1, 0, 0, 0), range(0, 2, 0, 1), range(0, 0, 0, 0.5)]) {
    assert.throws(() => parseThread({ ...thread, anchor: { kind: 'text', range: anchorRange, snapshot: 'x', before: '', after: '', stale: false } }), /anchor.range/);
  }
  assert.throws(() => parseThread({ ...thread, comments: [] }), /nonempty/);
  assert.throws(() => parseThread({ ...thread, comments: [{ ...thread.comments[0], body: ' \n' }] }), /body/);
  assert.throws(() => parseThread({ ...thread, comments: [thread.comments[0], thread.comments[0]] }), /unique/);
  assert.throws(() => parseThread({ ...thread, tags: [3] }), /tags/);
  assert.throws(() => parseThread({ ...thread, metadata: [] }), /metadata/);
  assert.throws(() => parseThread({ ...thread, metadata: { absent: undefined } }), /JSON/);
  assert.throws(() => parseThread({ ...thread, metadata: { large: BigInt(2) } }), /JSON/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => parseThread({ ...thread, metadata: cycle }), /cycles/);
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('Accessor executed'); } });
  assert.throws(() => parseThread({ ...thread, metadata: accessor }), /accessor/);
  assert.throws(() => parseThread({ ...thread, createdAt: '2025-02-29T00:00:00Z' }), /timestamp/);
  assert.throws(() => parseThread({ ...thread, updatedAt: `${thread.updatedAt}\n` }), /timestamp/);
  assert.equal(parseThread({ ...thread, createdAt: '2024-02-29T23:59:59+07:00' }).createdAt, '2024-02-29T23:59:59+07:00');
  assert.equal(createThread('a', { kind: 'file' }, 'x'.repeat(1_000_000), 'Reviewer').comments[0]!.body.length, 1_000_000);
});

test('repository saves, reloads, resolves, replies, and deletes only its thread', async () => {
  await fixture(async (repository, root) => {
    assert.deepEqual(await repository.loadAll(), { threads: [], errors: [] });
    const original = sample();
    const first = await repository.save(original, 0);
    assert.equal(first.revision, 1);
    assert.equal(original.revision, 0);
    const unrelated = path.join(root, 'source.txt');
    await fs.writeFile(unrelated, 'keep');
    const note = path.join(repository.directory, 'keep.txt');
    await fs.writeFile(note, 'keep');
    const resolved = await repository.save({ ...first, status: 'resolved', comments: [
      ...first.comments,
      { id: randomUUID(), body: 'Updated.', author: 'Second reviewer', createdAt: first.createdAt, updatedAt: first.updatedAt },
    ] }, 1);
    assert.equal(resolved.revision, 2);
    assert.deepEqual(await repository.loadAll(), { threads: [resolved], errors: [] });
    await assert.rejects(repository.delete(resolved.id, 1), /revision conflict/);
    assert.deepEqual((await repository.loadAll()).threads, [resolved]);
    await repository.delete(resolved.id, 2);
    assert.equal((await repository.loadAll()).threads.length, 0);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
    assert.equal(await fs.readFile(note, 'utf8'), 'keep');
    assert.deepEqual(await fs.readdir(repository.directory), ['keep.txt']);
  });
});

test('independent repository instances cannot commit concurrent revisions', async () => {
  await fixture(async (repository, root) => {
    const thread = await repository.save(sample(), 0);
    const other = new ThreadRepository(root);
    const attempts = await Promise.allSettled([
      repository.save({ ...thread, tags: ['first'] }, 1),
      other.save({ ...thread, tags: ['second'] }, 1),
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    const rejected = attempts.find(attempt => attempt.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.match(String(rejected.reason), /busy|revision conflict/);
    const loaded = await repository.loadAll();
    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.threads[0]!.revision, 2);
    await assert.rejects(other.save(thread, 1), /revision conflict/);
    assert.deepEqual(await fs.readdir(repository.directory), [`${thread.id}.json`]);
  });
});

test('concurrent creation commits once and an existing lock is never stolen', async () => {
  await fixture(async (repository, root) => {
    const thread = sample();
    const attempts = await Promise.allSettled([
      repository.save(thread, 0), new ThreadRepository(root).save(thread, 0),
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    const lockPath = path.join(repository.directory, `${thread.id}.lock`);
    const lockContent = '{"pid":123,"createdAt":"2000-01-01T00:00:00.000Z"}';
    await fs.writeFile(lockPath, lockContent);
    const persisted = (await repository.loadAll()).threads[0]!;
    await assert.rejects(repository.save(persisted, 1), /busy.*never automatically stolen/);
    await assert.rejects(repository.delete(thread.id, 1), /busy/);
    assert.equal(await fs.readFile(lockPath, 'utf8'), lockContent);
  });
});

test('corrupt and mismatched files are reported and preserved by save and delete', async () => {
  await fixture(async (repository) => {
    const thread = await repository.save(sample(), 0);
    const file = path.join(repository.directory, `${thread.id}.json`);
    const corrupt = '{ broken source';
    await fs.writeFile(file, corrupt);
    const loaded = await repository.loadAll();
    assert.equal(loaded.threads.length, 0);
    assert.equal(loaded.errors.length, 1);
    await assert.rejects(repository.save(thread, 1), /preserved/);
    await assert.rejects(repository.delete(thread.id, 1), /preserved/);
    assert.equal(await fs.readFile(file, 'utf8'), corrupt);
    const mismatch = JSON.stringify({ ...thread, id: randomUUID() });
    await fs.writeFile(file, mismatch);
    assert.match((await repository.loadAll()).errors[0]!, /does not match/);
    await assert.rejects(repository.save(thread, 1), /does not match/);
    await assert.rejects(repository.delete(thread.id, 1), /does not match/);
    assert.equal(await fs.readFile(file, 'utf8'), mismatch);
    await fs.writeFile(path.join(repository.directory, 'unknown.json'), '{}');
    assert.equal((await repository.loadAll()).errors.length, 2);
    assert.deepEqual((await fs.readdir(repository.directory)).sort(), [`${thread.id}.json`, 'unknown.json'].sort());
  });
});

test('saving a deleted revision cannot recreate a thread and invalid IDs cannot target other files', async () => {
  await fixture(async (repository, root) => {
    const thread = await repository.save(sample(), 0);
    await repository.delete(thread.id, 1);
    await assert.rejects(repository.save(thread, 1), /revision conflict/);
    await assert.rejects(repository.save({ ...thread, revision: 0 }, 1), /revision conflict/);
    await assert.rejects(repository.delete('../source', 0), /UUID/);
    assert.deepEqual((await repository.loadAll()).threads, []);
    assert.equal(repository.directory, path.join(root, '.review-comments', 'threads'));
  });
});

test('storage failures are nonfatal and never replace obstructing entries', async () => {
  await fixture(async (repository, root) => {
    const obstruction = path.join(root, '.review-comments');
    await fs.writeFile(obstruction, 'not a directory');
    const loaded = await repository.loadAll();
    assert.equal(loaded.threads.length, 0);
    assert.match(loaded.errors[0]!, /directory/);
    await assert.rejects(repository.save(sample(), 0), /directory/);
    assert.equal(await fs.readFile(obstruction, 'utf8'), 'not a directory');
  });
});

test('atomic replacement failure preserves the old thread and removes its temporary file and lock', async () => {
  await fixture(async (repository) => {
    const thread = await repository.save(sample(), 0);
    const file = path.join(repository.directory, `${thread.id}.json`);
    const original = await fs.readFile(file, 'utf8');
    const mutableFs = require('node:fs/promises') as typeof fs;
    const rename = mutableFs.rename;
    mutableFs.rename = async () => { throw Object.assign(new Error('Replacement permission denied'), { code: 'EACCES' }); };
    try {
      await assert.rejects(repository.save({ ...thread, tags: ['changed'] }, 1), /permission denied/);
    } finally {
      mutableFs.rename = rename;
    }
    assert.equal(await fs.readFile(file, 'utf8'), original);
    assert.deepEqual(await fs.readdir(repository.directory), [`${thread.id}.json`]);
  });
});

test('transient Windows replacement locks retry without deleting stored data', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (repository) => {
    const thread = await repository.save(sample(), 0);
    const mutableFs = require('node:fs/promises') as typeof fs;
    const rename = mutableFs.rename;
    let calls = 0;
    mutableFs.rename = async (...args: Parameters<typeof fs.rename>) => {
      calls++;
      if (calls < 3) { throw Object.assign(new Error('Temporary sharing violation'), { code: 'EPERM' }); }
      return rename(...args);
    };
    try {
      const saved = await repository.save({ ...thread, tags: ['retry'] }, thread.revision);
      assert.equal(saved.revision, 2);
      assert.equal(calls, 3);
      assert.deepEqual((await repository.loadAll()).threads[0].tags, ['retry']);
    } finally { mutableFs.rename = rename; }
  });
});

test('directory permission failures are returned as load errors and reject writes without escaping the API', async () => {
  await fixture(async (repository) => {
    const thread = await repository.save(sample(), 0);
    const mutableFs = require('node:fs/promises') as typeof fs;
    const readdir = mutableFs.readdir;
    mutableFs.readdir = (async () => { throw Object.assign(new Error('Directory permission denied'), { code: 'EACCES' }); }) as typeof fs.readdir;
    try {
      assert.match((await repository.loadAll()).errors[0]!, /permission denied/);
    } finally {
      mutableFs.readdir = readdir;
    }
    const open = mutableFs.open;
    mutableFs.open = async () => { throw Object.assign(new Error('Write permission denied'), { code: 'EACCES' }); };
    try {
      await assert.rejects(repository.save(thread, 1), /Cannot lock.*permission denied/);
    } finally {
      mutableFs.open = open;
    }
    assert.deepEqual((await repository.loadAll()).threads, [thread]);
  });
});

test('repository rejects symlinked storage instead of following it', async (context) => {
  await fixture(async (repository, root) => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'review-comments-external-'));
    try {
      try {
        await fs.symlink(external, path.join(root, '.review-comments'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) {
          context.skip('Creating a test link requires additional operating system privileges.');
          return;
        }
        throw error;
      }
      assert.match((await repository.loadAll()).errors[0]!, /not a link/);
      await assert.rejects(repository.save(sample(), 0), /not a link/);
      assert.deepEqual(await fs.readdir(external), []);
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });
});

test('anchors use UTF-16 offsets, support line endings, and reject invalid ranges', () => {
  const text = '🌍value\r\nnext\n';
  const anchor = createTextAnchor(text, range(0, 2, 1, 4));
  assert.equal(anchor.snapshot, 'value\r\nnext');
  assert.deepEqual(relocateAnchor(anchor, text), anchor);
  assert.throws(() => createTextAnchor(text, range(0, 100, 1, 0)), /outside/);
  assert.throws(() => createTextAnchor(text, range(1, 2, 0, 1)), /precede/);
  assert.equal(createTextAnchor('one\rtwo', range(1, 0, 1, 3)).snapshot, 'two');
});

test('anchors relocate after edits before the source and preserve original snapshot and context', () => {
  const text = 'header\nconst value = 1;\nfooter';
  const anchor = createTextAnchor(text, range(1, 0, 1, 16));
  const relocated = relocateAnchor(anchor, `inserted\n${text}`);
  assert.equal(relocated.stale, false);
  assert.deepEqual(relocated.range, range(2, 0, 2, 16));
  assert.equal(relocated.snapshot, anchor.snapshot);
  assert.equal(relocated.before, anchor.before);
  assert.equal(relocated.after, anchor.after);
  assert.deepEqual(anchor.range, range(1, 0, 1, 16));
  const editedPrefix = relocateAnchor(anchor, text.replace('header', 'new heading'));
  assert.equal(editedPrefix.stale, false);
});

test('changed and deleted source becomes stale without replacing the original snapshot', () => {
  const text = 'header\nconst value = 1;\nfooter';
  const anchor = createTextAnchor(text, range(1, 0, 1, 16));
  for (const changed of [text.replace('value = 1', 'value = 2'), 'header\nfooter']) {
    const relocated = relocateAnchor(anchor, changed);
    assert.equal(relocated.stale, true);
    assert.equal(relocated.snapshot, anchor.snapshot);
    assert.deepEqual(relocated.range, anchor.range);
  }
  assert.equal(relocateAnchor({ ...anchor, stale: true }, text).stale, false);
});

test('repeated snippets relocate by context, not by the old coordinates', () => {
  const text = 'first\nitem\nfirst-end\nsecond\nitem\nsecond-end';
  const anchor = createTextAnchor(text, range(1, 0, 1, 4));
  const moved = 'second\nitem\nsecond-end\nfirst\nitem\nfirst-end';
  const relocated = relocateAnchor(anchor, moved);
  assert.equal(relocated.stale, false);
  assert.deepEqual(relocated.range, range(4, 0, 4, 4));
  const ambiguous = { ...anchor, before: 'prefix\n', after: '\nsuffix' };
  const duplicated = 'prefix\nitem\nsuffix\nprefix\nitem\nsuffix';
  assert.equal(relocateAnchor(ambiguous, duplicated).stale, true);
  assert.equal(relocateAnchor({ ...anchor, before: 'gone', after: 'gone' }, moved).stale, true);
  const firstLine = createTextAnchor('item\noriginal-context', range(0, 0, 0, 4));
  assert.equal(relocateAnchor(firstLine, 'item\nreplacement\nitem\nother').stale, true);
});

test('empty line anchors remain conservative and empty documents work gracefully', () => {
  const text = 'first\n\nlast';
  const anchor = createTextAnchor(text, range(1, 0, 1, 0));
  assert.equal(anchor.snapshot, '');
  assert.deepEqual(relocateAnchor(anchor, `new\n${text}`).range, range(2, 0, 2, 0));
  assert.equal(relocateAnchor(anchor, 'first\nchanged\nlast').stale, true);
  const empty = createTextAnchor('', range(0, 0, 0, 0));
  assert.equal(relocateAnchor(empty, '').stale, false);
  assert.equal(relocateAnchor(empty, 'new content').stale, true);
});

test('exports include all replies, original source, tags, status, and safe fences', () => {
  const source = '`````\n<script>value</script>\n```';
  const anchor = createTextAnchor(source, range(0, 0, 2, 3));
  const thread = createThread('notes/[x] <tag>.ts', { ...anchor, stale: true }, 'Original ``` note', 'A <reviewer>');
  thread.status = 'resolved';
  thread.tags = ['important', '**literal**'];
  thread.comments.push({ id: randomUUID(), body: 'Reply ``````` text', author: 'B', createdAt: thread.createdAt, updatedAt: thread.updatedAt });
  const markdown = formatMarkdown([thread], '<workspace>', { scope: 'All comments' });
  assert.match(markdown, /^# Review comments\n\nAll comments: 1 thread · 0 open · 1 resolved · 1 with unverified source locations/);
  assert.ok(markdown.includes('Workspace: `<workspace>`'));
  assert.ok(markdown.includes('## File `notes/[x] <tag>.ts` (1 thread, 0 open)'));
  assert.ok(markdown.includes('### R1 · RESOLVED · LOCATION UNVERIFIED · Lines 1–3 (line 1 column 1 to line 3 column 3)'));
  assert.match(markdown, /OPEN threads have not been marked resolved/);
  assert.doesNotMatch(markdown, /SOURCE CHANGED|source changed after|original excerpt/);
  assert.match(markdown, /Saved source selection:/);
  assert.match(markdown, /created or explicitly reattached/);
  assert.match(markdown, /saved source could not be matched or verified/);
  assert.ok(markdown.includes('``````typescript\n' + source + '\n``````'), 'source fence uses the file language and outlasts embedded backticks');
  assert.ok(markdown.includes('> Reply ``````` text'), 'comment bodies are quoted, not reinterpreted as code fences');
  assert.ok(markdown.includes('> Original ``` note'));
  assert.ok(markdown.includes('**Comment — A <reviewer> ('));
  assert.ok(markdown.includes('**Reply 1 — B ('));
  assert.ok(markdown.includes('Tags: `important`, `**literal**`'));
  assert.ok(markdown.includes(`Thread \`${thread.id}\``));
  assert.ok(markdown.indexOf('Original ``` note') < markdown.indexOf('Reply ``````` text'), 'replies stay in order');

  const paragraph = 'We introduce a method.\nThe proposed method always wins.\nFurther text.';
  const selected = createTextAnchor(paragraph, range(1, 4, 1, 19));
  const located = createThread('paper/main.tex', selected, 'Explain this term.\n\nKeep the claim scoped.', 'Reviewer');
  const latex = formatMarkdown([located]);
  assert.ok(latex.includes('Line 2, columns 5–19'));
  assert.ok(latex.includes('```latex\nproposed method\n```'));
  assert.ok(latex.includes('The ⟦proposed method⟧ always wins.'), 'surrounding context marks the selection inline');
  assert.ok(latex.includes('> Explain this term.\n>\n> Keep the claim scoped.'), 'multi-paragraph comments stay quoted');
  assert.ok(latex.includes('Saved surrounding context:'));
  assert.ok(!latex.includes('RESOLVED threads are included'), 'no resolved legend when nothing is resolved');
  assert.ok(formatMarkdown([createThread('figure.pdf', { kind: 'file' }, 'Check page 2.', 'R')]).includes('Whole file (file-level comment, no text position)'));
  const exported = JSON.parse(formatJson([thread], 'Example')) as { schemaVersion: number; kind: string; workspace: string; conventions: { snapshot: string; stale: string }; threads: Thread[] };
  assert.match(exported.conventions.snapshot, /created or explicitly reattached/);
  assert.match(exported.conventions.stale, /could not be matched or verified/);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.kind, 'review-comments-export');
  assert.equal(exported.workspace, 'Example');
  assert.deepEqual(exported.threads, [thread]);
  assert.deepEqual((exported as unknown as { summary: unknown }).summary, { total: 1, open: 0, resolved: 1 });
  assert.equal(JSON.parse(formatJson([])).workspace, null);
});

test('exports sort deterministically by path, range, time, and ID without changing inputs', () => {
  const make = (resourcePath: string, line: number, time: string): Thread => ({
    ...sample(), resource: { path: resourcePath }, createdAt: time,
    anchor: { kind: 'text', range: range(line, 0, line, 1), snapshot: 'x', before: '', after: '', stale: false },
  });
  const a = make('a.ts', 1, '2026-01-01T00:00:00Z');
  const b = make('a.ts', 1, '2026-01-02T00:00:00Z');
  const c = make('a.ts', 2, '2025-01-01T00:00:00Z');
  const d = make('b.ts', 0, '2025-01-01T00:00:00Z');
  const input = [d, c, b, a];
  const exported = JSON.parse(formatJson(input)) as { threads: Thread[] };
  assert.deepEqual(exported.threads.map(thread => thread.id), [a.id, b.id, c.id, d.id]);
  assert.deepEqual(input, [d, c, b, a]);
  assert.equal(formatJson(input), formatJson([...input].reverse()));
  assert.equal(formatMarkdown(input), formatMarkdown([...input].reverse()));
});
