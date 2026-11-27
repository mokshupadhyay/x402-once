import { mkdtemp, rm, symlink, mkdir, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPaidFetch,
  InvalidRecordError,
  MemoryPaymentStore,
  SettledWithoutDeliveryError,
  UnsafeRedirectError,
  ValidityTooLongError,
  type PaymentRecord,
} from '../src/index.js';
import { FilePaymentStore } from '../src/node.js';
import { createFakeClient, createSimulatedMerchant, scriptedFaults } from '../src/testing/index.js';
import { attempt, createClock, setup, URL_A } from './helpers.js';

const recordsOf = (store: unknown) => (store as { records: Map<string, PaymentRecord> }).records;
const only = (store: unknown) => [...recordsOf(store).entries()][0]!;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'x402-once-h-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('redirects never carry the signed payment to another origin', () => {
  function redirecting(location: string, status = 302) {
    const clock = createClock();
    const merchant = createSimulatedMerchant({ now: clock.now });
    const seen: { url: string; hasPayment: boolean }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, hasPayment: request.headers.has('PAYMENT-SIGNATURE') });
      if (request.headers.has('PAYMENT-SIGNATURE') && new URL(request.url).pathname === '/report') {
        return new Response(null, { status, headers: { location } });
      }
      return merchant.fetch(request);
    };
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: fetchImpl, now: clock.now });
    return { paid, seen, merchant };
  }

  it('a cross-origin redirect after payment is refused and the header never reaches the other origin', async () => {
    const { paid, seen } = redirecting('https://evil.test/steal');
    await expect(paid('https://seller.test/report')).rejects.toBeInstanceOf(UnsafeRedirectError);
    expect(seen.some((s) => s.url.startsWith('https://evil.test'))).toBe(false);
  });

  it('a same-origin GET redirect is followed with the payment re-attached', async () => {
    const { paid, seen } = redirecting('https://seller.test/report/final');
    const response = await paid('https://seller.test/report');
    expect(response.status).toBe(200);
    expect(seen.filter((s) => s.url.endsWith('/report/final') && s.hasPayment)).toHaveLength(1);
  });

  it('a redirect on a POST is refused even on the same origin', async () => {
    const { paid } = redirecting('https://seller.test/elsewhere', 307);
    await expect(paid('https://seller.test/report', { method: 'POST', body: 'x' })).rejects.toBeInstanceOf(UnsafeRedirectError);
  });

  it('the payment stays saved after a refused redirect, so a retry does not sign again', async () => {
    const { paid, merchant } = redirecting('https://evil.test/steal');
    await paid('https://seller.test/report').catch(() => {});
    await paid('https://seller.test/report').catch(() => {});
    expect(merchant.settlementCount).toBe(0);
    expect(recordsOf(paid.store).size).toBe(1);
    expect([...recordsOf(paid.store).values()][0]?.presentations).toBe(2); // sent twice, signed once
  });
});

describe('a damaged or edited record stops the call instead of causing a second payment', () => {
  async function withRecord(edit: (record: Record<string, unknown>) => void) {
    const { paidFetch, store, merchant } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    await attempt(paidFetch);
    const [intent, record] = only(store);
    const edited = structuredClone(record) as unknown as Record<string, unknown>;
    edit(edited);
    (recordsOf(store) as unknown as Map<string, unknown>).set(intent, edited);
    return { paidFetch, merchant };
  }

  it.each<[string, (r: Record<string, unknown>) => void]>([
    ['status deleted', (r) => delete r['status']],
    ['unknown status', (r) => (r['status'] = 'PRESENTED')],
    ['headers missing', (r) => delete r['headers']],
    ['an injected Authorization header', (r) => ((r['headers'] as Record<string, string>)['Authorization'] = 'Bearer stolen')],
    ['expiresAt not a number', (r) => (r['expiresAt'] = 'soon')],
    ['written by a newer schema', (r) => (r['schema'] = 99)],
    ['belongs to another purchase', (r) => (r['intent'] = 'someone-else')],
  ])('%s', async (_name, edit) => {
    const { paidFetch, merchant } = await withRecord(edit);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(InvalidRecordError);
    expect(merchant.settlementCount).toBe(1); // nothing new was signed or sent
  });

  it('a store that answers compareAndSet with junk is an error, not a success', async () => {
    const store = new MemoryPaymentStore();
    store.compareAndSet = (async () => ({ ok: 'false' })) as never;
    const { paidFetch, merchant } = setup({}, {}, store);
    await expect(paidFetch(URL_A)).rejects.toThrow(/compareAndSet/);
    expect(merchant.settlementCount).toBe(0);
  });
});

describe('errors and logs never print the signed payment', () => {
  it('JSON.stringify and util.inspect of an error do not contain the payment, but error.record still works', async () => {
    const { paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') }, { resolver: async () => ({ verdict: 'settled' as const }) });
    await attempt(paidFetch);
    const error = (await paidFetch(URL_A).catch((e) => e)) as SettledWithoutDeliveryError;
    expect(error).toBeInstanceOf(SettledWithoutDeliveryError);
    expect(error.record.intent).toBeTruthy();
    expect(JSON.stringify(error)).not.toMatch(/PAYMENT-SIGNATURE|signature/i);
    expect(inspect(error, { depth: 6 })).not.toMatch(/PAYMENT-SIGNATURE|"?signature"?:/i);
  });
});

describe('what the seller can make us do', () => {
  it('refuses a payment that stays valid for years, before saving or sending it', async () => {
    const { paidFetch, merchant, store } = setup({ maxTimeoutSeconds: 315_360_000 });
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(ValidityTooLongError);
    expect(merchant.paymentRequests).toBe(0);
    expect(recordsOf(store).size).toBe(0);
  });

  it('stops reading a huge payment-required body at the cap instead of buffering it', async () => {
    let produced = 0;
    const huge = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            produced += 65_536;
            controller.enqueue(new Uint8Array(65_536));
            if (produced > 500_000_000) controller.close();
          },
        }),
        { status: 402 },
      );
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532'), fetch: huge as typeof fetch });
    await expect(paid(URL_A)).rejects.toThrow(/too large/);
    expect(produced).toBeLessThan(1_000_000);
  });

  it('gives up on a seller that never answers, and a retry still reuses the same payment', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, serveOnReplay: true });
    let hang = true;
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (hang && request.headers.has('PAYMENT-SIGNATURE')) {
        return new Promise<Response>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
      }
      return merchant.fetch(request);
    };
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: fetchImpl as typeof fetch, now: clock.now, requestTimeoutMs: 50 });
    await expect(paid(URL_A)).rejects.toBeTruthy();
    hang = false;
    expect((await paid(URL_A)).status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('requests that used to slip through', () => {
  it('the same FormData sent again is the same purchase', async () => {
    const { paidFetch, merchant } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    const form = () => {
      const f = new FormData();
      f.set('prompt', 'hello');
      return f;
    };
    await attempt(paidFetch, URL_A, { method: 'POST', body: form() });
    const retry = (await attempt(paidFetch, URL_A, { method: 'POST', body: form() })) as Response;
    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });

  it('a body that dies after a 200 is not a finished purchase: the retry re-sends the same payment', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, serveOnReplay: true });
    let cut = true;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await merchant.fetch(new Request(input, init));
      if (cut && response.status === 200) {
        cut = false;
        return new Response(new ReadableStream({ pull: (c) => c.error(new TypeError('terminated')) }), { status: 200, headers: response.headers });
      }
      return response;
    };
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: fetchImpl as typeof fetch, now: clock.now });
    const headers = { 'Idempotency-Key': 'order-1' };
    const first = await paid(URL_A, { headers });
    await expect(first.text()).rejects.toThrow();
    await paid.idle();
    const retry = await paid(URL_A, { headers }); // would be AlreadySettledError if the record said "settled"
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ paid: true });
    expect(merchant.settlementCount).toBe(1);
  });

  it('a delivered purchase keeps no signed payment in the store', async () => {
    const { paidFetch, store } = setup();
    const response = await paidFetch(URL_A);
    await response.text();
    await paidFetch.idle();
    const [, record] = only(store);
    expect(record.status).toBe('settled');
    expect(record.headers).toEqual({});
    expect(record.payload.payload).toEqual({});
  });

  it('a call that was already cancelled does not use up a send of the saved payment', async () => {
    const { paidFetch, store } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    await attempt(paidFetch);
    const aborted = AbortSignal.abort();
    for (let i = 0; i < 6; i++) await expect(paidFetch(URL_A, { signal: aborted })).rejects.toBeTruthy();
    expect(only(store)[1].presentations).toBe(1);
    expect(((await attempt(paidFetch)) as Response).status).toBe(200);
  });

  it('a clock that returns NaN is refused instead of skipping the deadline checks', async () => {
    const { paidFetch } = setup({}, { now: () => Number.NaN });
    await expect(paidFetch(URL_A)).rejects.toThrow(/finite number/);
  });

  it('a caller cancelling a large download releases it and does not hang', async () => {
    let cancelled = false;
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now });
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await merchant.fetch(new Request(input, init));
      if (response.status !== 200) return response;
      return new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(65_536)), cancel: () => void (cancelled = true) }), {
        status: 200,
        headers: response.headers,
      });
    };
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: fetchImpl as typeof fetch, now: clock.now });
    const response = await paid(URL_A);
    const reader = response.body!.getReader();
    await reader.read();
    await Promise.race([reader.cancel(), new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung')), 1000))]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
  });
});

describe('stores', () => {
  it('the memory store keeps open purchases and drops the oldest finished ones past its limit', async () => {
    const store = new MemoryPaymentStore({ maxFinishedRecords: 3 });
    const open = setup({ faults: scriptedFaults('drop-after-settle') }, {}, store);
    await attempt(open.paidFetch, 'https://seller.test/open'); // the OLDEST record, and still open
    const { paidFetch } = setup({}, {}, store);
    for (let i = 0; i < 10; i++) await (await paidFetch(`https://seller.test/item/${i}`)).text();
    await paidFetch.idle();
    const records = [...recordsOf(store).values()];
    expect(records.filter((r) => r.status === 'settled')).toHaveLength(3);
    expect(records.filter((r) => r.status === 'presented')).toHaveLength(1);
  });

  it('the file store refuses a symlinked directory and a group-writable one', async () => {
    const real = join(dir, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(dir, 'link'));
    await expect(new FilePaymentStore({ directory: join(dir, 'link') }).get('a')).rejects.toThrow(/symbolic link/);

    const loose = join(dir, 'loose');
    await mkdir(loose);
    await chmod(loose, 0o777);
    await expect(new FilePaymentStore({ directory: loose }).get('a')).rejects.toThrow(/writable by group or others/);
  });

  it('a failed write leaves no half-written file behind', async () => {
    const store = new FilePaymentStore({ directory: join(dir, 's') });
    const bad = { version: 1, intent: 'a', big: 1n } as unknown as PaymentRecord; // JSON.stringify throws on a BigInt
    await expect(store.compareAndSet('a', 0, bad)).rejects.toBeTruthy();
    expect((await readdir(join(dir, 's'))).filter((f) => f.endsWith('.tmp') || f.endsWith('.json'))).toEqual([]);
  });

  it('prune removes old finished purchases and keeps open ones', async () => {
    const store = new FilePaymentStore({ directory: join(dir, 'p') });
    const base = { version: 1, explicit: false, createdAt: 1, presentations: 1, paymentRequired: {}, payload: {}, headers: {}, expiresAt: 1 } as unknown as PaymentRecord;
    await store.compareAndSet('old-settled', 0, { ...base, intent: 'old-settled', status: 'settled', updatedAt: 1 });
    await store.compareAndSet('old-open', 0, { ...base, intent: 'old-open', status: 'presented', updatedAt: 1 });
    await store.compareAndSet('new-settled', 0, { ...base, intent: 'new-settled', status: 'settled', updatedAt: Date.now() });
    expect(await store.prune({ olderThanMs: 60_000 })).toBe(1);
    expect(await store.get('old-settled')).toBeUndefined();
    expect((await store.get('old-open'))?.status).toBe('presented');
    expect((await store.get('new-settled'))?.status).toBe('settled');
  });
});

describe('scope: two buyers, the same request', () => {
  it('without a scope they share one purchase (the documented limit)', async () => {
    const { merchant, paidFetch } = setup({ latencyMs: 5 });
    await Promise.all([paidFetch(URL_A, { headers: { Authorization: 'Bearer tenant-a' } }), paidFetch(URL_A, { headers: { Authorization: 'Bearer tenant-b' } })]);
    expect(merchant.settlementCount).toBe(1);
  });

  it('with a scope per buyer they are two purchases, and each buyer still pays once on retries', async () => {
    const { merchant, paidFetch } = setup({ latencyMs: 5 }, { scope: (request) => request.headers.get('Authorization') ?? undefined });
    const a = { headers: { Authorization: 'Bearer tenant-a' } };
    const b = { headers: { Authorization: 'Bearer tenant-b' } };
    await Promise.all([paidFetch(URL_A, a), paidFetch(URL_A, b), paidFetch(URL_A, a), paidFetch(URL_A, b)]);
    expect(merchant.settlementCount).toBe(2);
  });

  it('a fixed scope keeps keys equal across calls', async () => {
    const { merchant, paidFetch } = setup({ latencyMs: 5 }, { scope: 'tenant-a' });
    await Promise.all(Array.from({ length: 20 }, () => paidFetch(URL_A)));
    expect(merchant.settlementCount).toBe(1);
  });
});
