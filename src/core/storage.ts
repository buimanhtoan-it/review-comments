import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertRevision, assertThreadId, parseThread, Thread } from './model';

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code) : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filename(id: string): string {
  assertThreadId(id);
  return `${id.toLowerCase()}.json`;
}

/** Local workspace persistence with optimistic revisions and cross-process locks. */
export class ThreadRepository {
  readonly directory: string;
  private readonly parentDirectory: string;

  constructor(rootPath: string) {
    this.parentDirectory = path.join(path.resolve(rootPath), '.review-comments');
    this.directory = path.join(this.parentDirectory, 'threads');
  }

  private async checkDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Review storage must be a real directory, not a link: ${directory}`);
    }
  }

  private async prepareDirectory(): Promise<void> {
    for (const directory of [this.parentDirectory, this.directory]) {
      try {
        await fs.mkdir(directory);
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
      await this.checkDirectory(directory);
    }
  }

  private async readThread(file: string): Promise<Thread> {
    const original = await fs.lstat(file);
    if (original.isSymbolicLink() || !original.isFile()) {
      throw new Error('Thread storage entries must be regular files, not links.');
    }
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino) {
        throw new Error('Thread file changed while opening it. Reload and retry.');
      }
      const thread = parseThread(JSON.parse(await handle.readFile('utf8')) as unknown);
      if (path.basename(file) !== filename(thread.id)) {
        throw new Error('Thread id does not match its canonical UUID filename. Preserve the file and correct the mismatch before retrying.');
      }
      return thread;
    } finally {
      await handle.close();
    }
  }

  async loadAll(): Promise<{ threads: Thread[]; errors: string[] }> {
    const threads: Thread[] = [];
    const errors: string[] = [];
    let entries: string[];
    try {
      await this.checkDirectory(this.parentDirectory);
      await this.checkDirectory(this.directory);
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if (code(error) !== 'ENOENT') errors.push(`Cannot read review storage: ${message(error)}`);
      return { threads, errors };
    }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith('.json')) continue;
      try {
        assertThreadId(entry.slice(0, -5));
        threads.push(await this.readThread(path.join(this.directory, entry)));
      } catch (error) {
        errors.push(`${entry}: ${message(error)}`);
      }
    }
    return { threads, errors };
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    assertThreadId(id);
    await this.prepareDirectory();
    const lockPath = path.join(this.directory, `${id.toLowerCase()}.lock`);
    let lock: fs.FileHandle;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (code(error) === 'EEXIST') {
        throw new Error(`Review thread ${id} is busy. Retry after the other window finishes. If a previous writer exited unexpectedly, close all workspace windows and remove only ${path.basename(lockPath)} before retrying. Locks are never automatically stolen.`);
      }
      throw new Error(`Cannot lock review thread ${id}: ${message(error)}`);
    }
    let result!: T;
    let operationError: unknown;
    let operationFailed = false;
    const cleanupErrors: string[] = [];
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      await lock.sync();
      result = await operation();
    } catch (error) {
      operationError = error;
      operationFailed = true;
    } finally {
      try { await lock.close(); } catch (error) { cleanupErrors.push(message(error)); }
      try { await fs.unlink(lockPath); } catch (error) { cleanupErrors.push(message(error)); }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`${operationFailed ? message(operationError) : 'The operation committed, but lock cleanup did not finish. Reload before retrying.'} Lock cleanup: ${cleanupErrors.join('; ')}`);
    }
    if (operationFailed) throw operationError;
    return result;
  }

  private async current(id: string): Promise<Thread | undefined> {
    try {
      return await this.readThread(path.join(this.directory, filename(id)));
    } catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      throw new Error(`Cannot read existing review thread ${id}; its file was preserved: ${message(error)}`);
    }
  }

  private checkExpected(current: Thread | undefined, expectedRevision: number): void {
    const actual = current?.revision ?? 0;
    if (actual !== expectedRevision) {
      throw new Error(`Review thread revision conflict: expected ${expectedRevision}, found ${actual}. Reload the thread and retry.`);
    }
  }

  async save(thread: Thread, expectedRevision: number): Promise<Thread> {
    const validated = parseThread(thread);
    assertRevision(expectedRevision);
    if (validated.revision !== expectedRevision) {
      throw new Error('Review thread revision conflict: the supplied thread revision must equal expectedRevision. Reload before saving.');
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error('Review thread revision is exhausted.');
    return this.withLock(validated.id, async () => {
      const current = await this.current(validated.id);
      this.checkExpected(current, expectedRevision);
      if (current !== undefined && expectedRevision === 0) {
        throw new Error('A review thread file already exists at revision 0. Preserve it and reload before saving.');
      }
      const saved = parseThread({ ...validated, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
      const destination = path.join(this.directory, filename(saved.id));
      const temporary = path.join(this.directory, `.${saved.id.toLowerCase()}.${randomUUID()}.tmp`);
      let handle: fs.FileHandle | undefined;
      let temporaryOwned = false;
      let writeError: unknown;
      let writeFailed = false;
      const cleanupErrors: string[] = [];
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        temporaryOwned = true;
        await handle.writeFile(`${JSON.stringify(saved, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        // Windows watchers/virus scanners can briefly hold the target without delete sharing.
        // Keep the lock and atomic replacement; never unlink the destination to force a save.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temporary, destination); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code(error) ?? '') || attempt >= 4) { throw error; }
            await delay(25 * (attempt + 1));
          }
        }
        temporaryOwned = false;
      } catch (error) {
        writeFailed = true;
        writeError = error;
      } finally {
        if (handle !== undefined) {
          try { await handle.close(); } catch (error) { cleanupErrors.push(message(error)); }
        }
        if (temporaryOwned) {
          try { await fs.unlink(temporary); } catch (error) {
            if (code(error) !== 'ENOENT') cleanupErrors.push(message(error));
          }
        }
      }
      if (writeFailed || cleanupErrors.length > 0) {
        throw new Error(`Cannot save review thread ${saved.id}: ${writeFailed ? message(writeError) : 'Temporary file cleanup did not finish.'}${cleanupErrors.length > 0 ? ` Cleanup: ${cleanupErrors.join('; ')}` : ''}`);
      }
      return saved;
    });
  }

  async delete(id: string, expectedRevision: number): Promise<void> {
    assertThreadId(id);
    assertRevision(expectedRevision);
    await this.withLock(id, async () => {
      const current = await this.current(id);
      if (current === undefined) throw new Error(`Review thread ${id} no longer exists. Reload the thread list.`);
      this.checkExpected(current, expectedRevision);
      await fs.unlink(path.join(this.directory, filename(id)));
    });
  }
}
