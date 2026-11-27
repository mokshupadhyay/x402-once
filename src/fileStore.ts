import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompareAndSetResult, PaymentRecord, PaymentStore } from './types.js';

export interface FilePaymentStoreOptions {
  /** Where the records live. Created if missing (mode 0700). One small JSON file per purchase. */
  directory: string;
  /** How long a write waits for another process holding the same purchase's lock. Default 5000 ms. */
  lockTimeoutMs?: number;
  /** A lock older than this is assumed to belong to a process that died, and is broken. Default 15000 ms. */
  staleLockMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps records in a directory, so a restart or a second process on the same machine sees the same payments.
 *
 * Each record is written to a temporary file, flushed to disk, then renamed into place, so a crash leaves either the
 * old record or the new one, never half of one. A write takes a per-purchase lock (a directory, which the filesystem
 * creates atomically), so two processes cannot both win the same `compareAndSet`.
 *
 * It does not protect against two machines sharing a network drive. For that, implement `PaymentStore` over a
 * database with a conditional update.
 */
export class FilePaymentStore implements PaymentStore {
  private readonly directory: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private ready: Promise<void> | undefined;

  constructor(options: FilePaymentStoreOptions) {
    this.directory = options.directory;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 15_000;
  }

  private path(intent: string, suffix: string): string {
    return join(this.directory, createHash('sha256').update(intent).digest('hex') + suffix);
  }

  /** Creates the directory if needed, and refuses one that someone else could write into or redirect with a symlink. */
  private ensureDirectory(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (info.isSymbolicLink()) throw new Error(`The payment store directory ${this.directory} is a symbolic link. Refusing to use it.`);
      if (process.platform !== 'win32') {
        if (info.mode & 0o022) throw new Error(`The payment store directory ${this.directory} is writable by group or others. Run: chmod 700 "${this.directory}"`);
        if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error(`The payment store directory ${this.directory} belongs to another user.`);
      }
    })();
    return this.ready;
  }

  /** Reads one record. A missing file is "no record"; an unreadable one is an error, never "no record". */
  private async read(intent: string): Promise<PaymentRecord | undefined> {
    let text: string;
    try {
      const info = await lstat(this.path(intent, '.json'));
      if (!info.isFile()) throw new Error(`The saved payment for "${intent}" is not a regular file (${this.path(intent, '.json')}). Refusing to read it.`);
      text = await readFile(this.path(intent, '.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let record: PaymentRecord;
    try {
      record = JSON.parse(text) as PaymentRecord;
    } catch {
      throw new Error(`The saved payment for "${intent}" is unreadable (${this.path(intent, '.json')}). Not guessing: fix or remove the file.`);
    }
    if (record.intent !== intent) throw new Error(`The saved payment file for "${intent}" holds a different purchase.`);
    return record;
  }

  async get(intent: string): Promise<PaymentRecord | undefined> {
    await this.ensureDirectory();
    return this.read(intent);
  }

  async compareAndSet(intent: string, expectedVersion: number, next: PaymentRecord): Promise<CompareAndSetResult> {
    await this.ensureDirectory();
    return this.withLock(intent, async (owner) => {
      const current = await this.read(intent);
      if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current };
      // writeDurably re-checks that the lock is still ours at the last moment, in case we stalled long enough to lose it.
      await this.writeDurably(intent, next, owner.holds);
      return { ok: true };
    });
  }

  async delete(intent: string): Promise<void> {
    await this.ensureDirectory();
    await this.withLock(intent, () => rm(this.path(intent, '.json'), { force: true }));
  }

  /**
   * Deletes records of finished purchases (settled, expired, abandoned) not touched for `olderThanMs`, and any
   * leftover temporary files. Purchases with a key you chose are kept unless `includeExplicit` is set. Open purchases (`presented`, `undelivered`) are never deleted. Returns how many were removed.
   */
  async prune(options: { olderThanMs: number; includeExplicit?: boolean }): Promise<number> {
    await this.ensureDirectory();
    const cutoff = Date.now() - options.olderThanMs;
    let removed = 0;
    for (const name of await readdir(this.directory)) {
      const path = join(this.directory, name);
      if (name.endsWith('.tmp')) {
        const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > this.staleLockMs) await unlink(path).catch(() => {});
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(path, 'utf8')) as PaymentRecord;
        // A record for a key the caller chose is what makes "this exact purchase, ever" true, so it is kept unless asked.
        const prunable = !record.explicit || options.includeExplicit === true;
        if (prunable && ['settled', 'expired', 'abandoned'].includes(record.status) && record.updatedAt < cutoff) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        /* unreadable files are left for a human; prune never guesses */
      }
    }
    return removed;
  }

  private async writeDurably(intent: string, record: PaymentRecord, stillOwner: () => Promise<boolean>): Promise<void> {
    const target = this.path(intent, '.json');
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600); // 'wx': never reuse or follow something already at that path
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync(); // on disk before it is visible under the real name
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {}); // a full disk must not leave a half-written signed record behind
      throw error;
    }
    await handle.close();
    try {
      // The last moment to notice a broken lock: after this the new record is visible.
      if (!(await stillOwner())) throw new Error(`Lost the lock on "${intent}" while working; nothing was written.`);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    // Make the rename itself durable. Not every platform lets you open a directory; that is fine.
    try {
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      /* best effort */
    }
  }

  private async withLock<T>(intent: string, work: (owner: { holds(): Promise<boolean> }) => Promise<T>): Promise<T> {
    const lock = this.path(intent, '.lock');
    const tokenFile = join(lock, 'owner');
    const token = randomBytes(12).toString('hex');
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => undefined);
        if (age !== undefined && age > this.staleLockMs) {
          // Its owner died holding it. Move it aside (atomic: only one breaker can succeed) instead of deleting in place.
          const aside = `${lock}.broken.${randomBytes(4).toString('hex')}`;
          if (await rename(lock, aside).then(() => true, () => false)) await rm(aside, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on "${intent}" (${lock}).`);
        await sleep(5 + Math.random() * 20);
      }
    }
    const holds = async () => (await readFile(tokenFile, 'utf8').catch(() => undefined)) === token;
    try {
      await writeFile(tokenFile, token, { mode: 0o600 });
      return await work({ holds });
    } finally {
      // Only remove a lock that is still ours; after a stall it may belong to someone else by now.
      if (await holds()) await rm(lock, { recursive: true, force: true });
    }
  }
}
