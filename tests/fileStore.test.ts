import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPaymentStore, SettledWithoutDeliveryError, type PaymentRecord, type PaymentStore } from '../src/index.js';
import { FilePaymentStore } from '../src/node.js';
import { scriptedFaults } from '../src/testing/index.js';
import { attempt, setup, URL_A } from './helpers.js';

const record = (intent: string, version: number, patch: Partial<PaymentRecord> = {}): PaymentRecord => ({
  version,
  intent,
  explicit: false,
  status: 'presented',
  createdAt: 1,
  updatedAt: 1,
  presentations: 1,
  paymentRequired: { x402Version: 2, resource: { url: 'https://seller.test/x' }, accepts: [] },
  payload: { x402Version: 2, payload: { authorization: { nonce: '0x01' } }, accepted: {} as never },
  headers: { 'PAYMENT-SIGNATURE': 'abc' },
  expiresAt: 100,
  ...patch,
});

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'x402-once-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// The same promises from both stores: the file store must behave exactly like the in-memory one.
describe.each<[string, () => PaymentStore]>([
  ['MemoryPaymentStore', () => new MemoryPaymentStore()],
  ['FilePaymentStore', () => new FilePaymentStore({ directory })],
])('%s contract', (_name, make) => {
  it('creates only when nothing exists, and returns copies', async () => {
    const store = make();
    expect(await store.get('a')).toBeUndefined();
    expect(await store.compareAndSet('a', 0, record('a', 1))).toEqual({ ok: true });
    const second = await store.compareAndSet('a', 0, record('a', 1, { presentations: 9 }));
    expect(second.ok).toBe(false);
    expect((await store.get('a'))?.presentations).toBe(1);
    const copy = (await store.get('a'))!;
    copy.presentations = 99;
    expect((await store.get('a'))?.presentations).toBe(1);
  });

  it('replaces only when the version matches, and hands back the current record when it does not', async () => {
    const store = make();
    await store.compareAndSet('a', 0, record('a', 1));
    expect(await store.compareAndSet('a', 1, record('a', 2, { status: 'settled' }))).toEqual({ ok: true });
    const stale = await store.compareAndSet('a', 1, record('a', 2, { status: 'expired' }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.current?.status).toBe('settled');
  });

  it('keeps purchases apart and deletes', async () => {
    const store = make();
    await store.compareAndSet('a', 0, record('a', 1));
    await store.compareAndSet('b', 0, record('b', 1));
    await store.delete?.('a');
    expect(await store.get('a')).toBeUndefined();
    expect((await store.get('b'))?.intent).toBe('b');
  });
});

describe('FilePaymentStore', () => {
  it('a new instance on the same directory sees what an earlier one saved (a restart)', async () => {
    await new FilePaymentStore({ directory }).compareAndSet('a', 0, record('a', 1, { headers: { 'PAYMENT-SIGNATURE': 'sig' } }));
    const after = await new FilePaymentStore({ directory }).get('a');
    expect(after?.headers['PAYMENT-SIGNATURE']).toBe('sig');
  });

  it('many writers racing to create the same purchase: exactly one wins', async () => {
    const stores = Array.from({ length: 12 }, () => new FilePaymentStore({ directory }));
    const results = await Promise.all(stores.map((store, i) => store.compareAndSet('race', 0, record('race', 1, { presentations: i + 1 }))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = await stores[0]!.get('race');
    expect(winner?.version).toBe(1);
  });

  it('racing updates from the same version: exactly one wins, and versions never skip or repeat', async () => {
    const seed = new FilePaymentStore({ directory });
    await seed.compareAndSet('race', 0, record('race', 1));
    const stores = Array.from({ length: 8 }, () => new FilePaymentStore({ directory }));
    const results = await Promise.all(stores.map((store) => store.compareAndSet('race', 1, record('race', 2))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await seed.get('race'))?.version).toBe(2);
  });

  it('leaves no temporary or lock files behind', async () => {
    const store = new FilePaymentStore({ directory });
    await store.compareAndSet('a', 0, record('a', 1));
    await store.compareAndSet('a', 1, record('a', 2));
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('stores files private to the user', async () => {
    if (process.platform === 'win32') return;
    const { statSync } = await import('node:fs');
    await new FilePaymentStore({ directory }).compareAndSet('a', 0, record('a', 1));
    const [file] = await readdir(directory);
    expect(statSync(join(directory, file!)).mode & 0o077).toBe(0);
  });

  it('breaks a lock left by a process that died', async () => {
    const store = new FilePaymentStore({ directory, staleLockMs: 1000 });
    await store.get('a'); // creates the directory
    const { createHash } = await import('node:crypto');
    const lock = join(directory, createHash('sha256').update('a').digest('hex') + '.lock');
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await store.compareAndSet('a', 0, record('a', 1))).toEqual({ ok: true });
  });

  it('a writer that stalled past the stale-lock window does not write after its lock was broken', async () => {
    const store = new FilePaymentStore({ directory, staleLockMs: 30, lockTimeoutMs: 2000 });
    await store.compareAndSet('a', 0, record('a', 1));
    const original = store['read'].bind(store) as (intent: string) => Promise<PaymentRecord | undefined>;
    let stalled = false;
    store['read'] = async (intent: string) => {
      const found = await original(intent);
      if (found && !stalled) { stalled = true; await new Promise((resolve) => setTimeout(resolve, 150)); } // "laptop suspended" after reading
      return found;
    };
    const slow = store.compareAndSet('a', 1, record('a', 2, { status: 'expired' }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const other = new FilePaymentStore({ directory, staleLockMs: 30 });
    expect(await other.compareAndSet('a', 1, record('a', 2, { status: 'settled' }))).toEqual({ ok: true }); // breaks the stale lock
    await expect(slow).rejects.toThrow(/Lost the lock/);
    expect((await other.get('a'))?.status).toBe('settled'); // the stalled writer did not overwrite it
  });

  it('waits for a live lock and gives up with an error rather than writing without it', async () => {
    const store = new FilePaymentStore({ directory, lockTimeoutMs: 150, staleLockMs: 60_000 });
    await store.get('a');
    const { createHash } = await import('node:crypto');
    await mkdir(join(directory, createHash('sha256').update('a').digest('hex') + '.lock'));
    await expect(store.compareAndSet('a', 0, record('a', 1))).rejects.toThrow(/Timed out waiting for the lock/);
    expect(await store.get('a')).toBeUndefined();
  });

  it('fails closed on a corrupt file instead of treating it as "never paid"', async () => {
    const store = new FilePaymentStore({ directory });
    await store.compareAndSet('a', 0, record('a', 1));
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), '{"version": 1, "intent": "a", "stat');
    await expect(store.get('a')).rejects.toThrow(/unreadable/);
    await expect(store.compareAndSet('a', 0, record('a', 1))).rejects.toThrow(/unreadable/);
  });

  it('refuses a file that belongs to a different purchase', async () => {
    const store = new FilePaymentStore({ directory });
    await store.compareAndSet('a', 0, record('a', 1));
    const { createHash } = await import('node:crypto');
    const [file] = await readdir(directory);
    const wrong = join(directory, createHash('sha256').update('b').digest('hex') + '.json');
    await writeFile(wrong, await (await import('node:fs/promises')).readFile(join(directory, file!)));
    await expect(store.get('b')).rejects.toThrow(/different purchase/);
  });
});

describe('end to end with the file store', () => {
  it('a restarted process reuses the payment it saved, and a lost response is not paid twice', async () => {
    const first = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true }, {}, new FilePaymentStore({ directory }));
    expect(await attempt(first.paidFetch)).toBe('network-error'); // "crash" here

    const restarted = setup({}, {}, new FilePaymentStore({ directory }), undefined, { clock: first.clock, merchant: first.merchant, client: first.client });
    const retry = (await attempt(restarted.paidFetch)) as Response;
    expect(retry.status).toBe(200);
    expect(first.merchant.settlementCount).toBe(1);
  });

  it('remembers across a restart that a payment settled without delivery', async () => {
    const resolver = async () => ({ verdict: 'settled' as const, transaction: '0x' + 'ee'.repeat(32) });
    const first = setup({ faults: scriptedFaults('drop-after-settle') }, { resolver }, new FilePaymentStore({ directory }));
    await attempt(first.paidFetch);
    await expect(first.paidFetch(URL_A)).rejects.toBeInstanceOf(SettledWithoutDeliveryError);

    const restarted = setup({}, {}, new FilePaymentStore({ directory }), undefined, { clock: first.clock, merchant: first.merchant, client: first.client });
    const before = first.merchant.paymentRequests;
    await expect(restarted.paidFetch(URL_A)).rejects.toBeInstanceOf(SettledWithoutDeliveryError);
    expect(first.merchant.paymentRequests).toBe(before);
    expect(first.merchant.settlementCount).toBe(1);
  });
});
