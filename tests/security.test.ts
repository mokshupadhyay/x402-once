import { mkdtemp, rm, symlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x402HTTPClient } from '@x402/core/client';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPaidFetch, InsecureTransportError, InvalidRecordError, MemoryPaymentStore, PaymentMismatchError } from '../src/index.js';
import { deriveIntent } from '../src/intent.js';
import { FilePaymentStore } from '../src/node.js';
import { createFakeClient, createSimulatedMerchant, scriptedFaults } from '../src/testing/index.js';
import { validateRecord } from '../src/validate.js';
import { attempt, createClock, setup, URL_A } from './helpers.js';

/** A signer that hands back whatever `tamper` makes of the honest payment: a stand-in for a buggy or hostile dependency. */
function hostile(tamper: (payload: any) => void, options: { httpHeaders?: (honest: Record<string, string>) => Record<string, string>; maxTimeoutSeconds?: number; url?: string } = {}) {
  const clock = createClock(Date.now());
  const merchant = createSimulatedMerchant({ now: clock.now, ...(options.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: options.maxTimeoutSeconds } : {}) });
  const real = createFakeClient('eip155:84532', { now: clock.now });
  const client = {
    createPaymentPayload: async (required: any) => {
      const payload = await real.createPaymentPayload(required);
      tamper(payload);
      return payload;
    },
  };
  const http = new x402HTTPClient(real as never);
  const httpClient = options.httpHeaders
    ? {
        getPaymentRequiredResponse: http.getPaymentRequiredResponse.bind(http),
        getPaymentSettleResponse: http.getPaymentSettleResponse.bind(http),
        encodePaymentSignatureHeader: (payload: any) => options.httpHeaders!(http.encodePaymentSignatureHeader(payload)),
      }
    : undefined;
  const store = new MemoryPaymentStore();
  const seen: Request[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone());
    return merchant.fetch(request);
  };
  const paid = createPaidFetch({ client: client as never, ...(httpClient ? { httpClient } : {}), fetch: fetchImpl as typeof fetch, store, now: clock.now });
  return { paid, merchant, store, seen };
}

describe('a buggy or hostile signer cannot get a wrong payment saved or sent', () => {
  it.each<[string, (payload: any) => void]>([
    ['a different payee in the signed authorization', (p) => (p.payload.authorization.to = '0x' + 'ab'.repeat(20))],
    ['a larger signed amount', (p) => (p.payload.authorization.value = '99999999')],
    ['an accepted offer the seller never made (different payee)', (p) => (p.accepted = { ...p.accepted, payTo: '0x' + 'cd'.repeat(20) })],
    ['an accepted offer on a different asset', (p) => (p.accepted = { ...p.accepted, asset: '0x' + 'ee'.repeat(20) })],
    ['an accepted offer with a different amount', (p) => (p.accepted = { ...p.accepted, amount: '1' })],
    ['a malformed nonce', (p) => (p.payload.authorization.nonce = '0x1234')],
    ['a payer that is not an address', (p) => (p.payload.authorization.from = 'me')],
    ['a validity window that is not numbers', (p) => (p.payload.authorization.validBefore = 'never')],
    ['no accepted offer at all', (p) => delete p.accepted],
  ])('%s', async (_name, tamper) => {
    const { paid, merchant, store } = hostile(tamper);
    await expect(paid(URL_A)).rejects.toBeInstanceOf(PaymentMismatchError);
    expect(merchant.paymentRequests).toBe(0); // never sent
    expect((store as unknown as { records: Map<string, unknown> }).records.size).toBe(0); // never saved
  });

  it('headers from the HTTP client are held to an allow-list: no Authorization, no Cookie, no control characters', async () => {
    const attacks: Record<string, string>[] = [{ Authorization: 'Bearer x' }, { Cookie: 'a=b' }, { 'PAYMENT-SIGNATURE': 'abc\r\nX-Evil: 1' }];
    for (const headers of attacks) {
      const { paid, merchant } = hostile(() => {}, { httpHeaders: (honest) => ({ ...honest, ...headers }) });
      await expect(paid(URL_A)).rejects.toBeInstanceOf(InvalidRecordError);
      expect(merchant.paymentRequests).toBe(0);
    }
  });

  it('a payment whose deadline cannot be computed is refused before it is sent', async () => {
    const { paid, merchant } = hostile((p) => delete p.payload.authorization.validBefore, { maxTimeoutSeconds: Number.NaN });
    await expect(paid(URL_A)).rejects.toBeTruthy();
    expect(merchant.paymentRequests).toBe(0);
  });

  it('an honest payment still goes through unchanged (control)', async () => {
    const { paid, merchant } = hostile(() => {});
    expect((await paid(URL_A)).status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('transport', () => {
  it('refuses to send the signed payment over plain http to a remote host, before sending it', async () => {
    const { paid, merchant } = hostile(() => {});
    await expect(paid('http://seller.test/report')).rejects.toBeInstanceOf(InsecureTransportError);
    expect(merchant.paymentRequests).toBe(0);
  });

  it('allows http for localhost, and anywhere when asked', async () => {
    expect((await hostile(() => {}).paid('http://localhost:3000/x')).status).toBe(200);
    expect((await hostile(() => {}).paid('http://127.0.0.1:3000/x')).status).toBe(200);
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now });
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: merchant.fetch, now: clock.now, allowInsecureHttp: true });
    expect((await paid('http://seller.test/x')).status).toBe(200);
  });

  it('the paid request tells caches not to keep it', async () => {
    const { paid, seen } = hostile(() => {});
    await paid(URL_A);
    const paidRequest = seen.find((r) => r.headers.has('PAYMENT-SIGNATURE'))!;
    expect(paidRequest.headers.get('cache-control')).toBe('no-store');
  });
});

describe('inputs from the network and from disk are fuzzed', () => {
  it('validateRecord only ever throws InvalidRecordError, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withBigInt: true, withObjectString: true }), fc.string(), (value, intent) => {
        try {
          validateRecord(intent, value);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidRecordError);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('validateRecord never accepts a record with a non-allowed header', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((name) => !['payment-signature', 'x-payment', 'access-control-expose-headers'].includes(name.toLowerCase())), (name) => {
        const record = { schema: 1, version: 1, intent: 'a', explicit: false, status: 'presented', createdAt: 1, updatedAt: 1, presentations: 1, expiresAt: 1, paymentRequired: {}, payload: { accepted: {} }, headers: { [name]: 'x' } };
        expect(() => validateRecord('a', record)).toThrow(InvalidRecordError);
      }),
      { numRuns: 500 },
    );
  });

  it('hashing a request never takes long, even for hostile content-type headers or bodies', async () => {
    const started = performance.now();
    for (const contentType of ['multipart/form-data; boundary=' + 'a'.repeat(100_000), 'multipart/form-data; boundary="' + '"'.repeat(5000), 'multipart/form-data; ' + 'boundary='.repeat(20_000)]) {
      const request = new Request('https://seller.test/x', { method: 'POST', headers: { 'content-type': contentType }, body: 'x'.repeat(100_000) });
      expect(await deriveIntent(request)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('a hostile 402 (deeply nested JSON, __proto__ keys) fails cleanly and does not pollute prototypes', async () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    for (const body of [deep, '{"__proto__":{"polluted":true},"accepts":[]}', '{"constructor":{"prototype":{"polluted":true}}}']) {
      const paid = createPaidFetch({ client: createFakeClient('eip155:84532'), fetch: (async () => new Response(body, { status: 402, headers: { 'content-type': 'application/json' } })) as typeof fetch });
      await expect(paid(URL_A)).rejects.toBeTruthy();
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('the file store and planted files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'x402-once-s-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a symlink planted in place of a record file is refused, not followed', async () => {
    const store = new FilePaymentStore({ directory: join(dir, 'store') });
    await store.get('a'); // creates the directory
    const secret = join(dir, 'outside.json');
    await writeFile(secret, JSON.stringify({ intent: 'a', status: 'presented' }));
    const { createHash } = await import('node:crypto');
    await symlink(secret, join(dir, 'store', createHash('sha256').update('a').digest('hex') + '.json'));
    await expect(store.get('a')).rejects.toThrow(/not a regular file/);
    expect((await readdir(join(dir, 'store'))).length).toBe(1);
  });
});

describe('your own limits', () => {
  const run = (limits: object) => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now });
    const paid = createPaidFetch({ client: createFakeClient('eip155:84532', { now: clock.now }), fetch: merchant.fetch, now: clock.now, limits: limits as never });
    return { paid, merchant };
  };
  it.each<[string, object]>([
    ['a network not on your list', { networks: ['eip155:8453'] }],
    ['an asset not on your list', { assets: ['0x' + '11'.repeat(20)] }],
    ['a payee not on your list', { payTo: ['0x' + '33'.repeat(20)] }],
    ['an amount above your maximum', { maxAmount: '9999' }],
  ])('refuses %s before anything is sent', async (_name, limits) => {
    const { paid, merchant } = run(limits);
    await expect(paid(URL_A)).rejects.toBeInstanceOf(PaymentMismatchError);
    expect(merchant.paymentRequests).toBe(0);
  });
  it('allows a purchase inside every limit (addresses compared without case)', async () => {
    const { paid, merchant } = run({
      networks: ['eip155:84532'],
      assets: ['0x036CbD53842c5426634e7929541eC2318f3dCF7e'.toLowerCase()],
      payTo: ['0x2222222222222222222222222222222222222222'],
      maxAmount: '10000',
    });
    expect((await paid(URL_A)).status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('a dead payment does not stay on disk', () => {
  it('forgetting a purchase removes the signed payment from its record', async () => {
    const { paidFetch, store } = setup({ faults: scriptedFaults('drop-after-settle') }, {});
    await attempt(paidFetch);
    const [intent] = [...(store as unknown as { records: Map<string, { status: string; headers: object; payload: { payload: object } }> }).records.keys()];
    await paidFetch.forget(intent!);
    const record = (await store.get(intent!))!;
    expect(record.status).toBe('abandoned');
    expect(record.headers).toEqual({});
    expect(record.payload.payload).toEqual({});
  });
});

describe('pruning keeps what makes an explicit key mean "this exact purchase, ever"', () => {
  it('prune removes old derived-key records and keeps explicit-key records unless asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x402-once-prune-'));
    try {
      const store = new FilePaymentStore({ directory: dir });
      const base = { version: 1, createdAt: 1, updatedAt: 1, presentations: 1, paymentRequired: {}, payload: {}, headers: {}, expiresAt: 1, status: 'settled' } as never;
      await store.compareAndSet('derived', 0, { ...(base as object), intent: 'derived', explicit: false } as never);
      await store.compareAndSet('chosen', 0, { ...(base as object), intent: 'chosen', explicit: true } as never);
      expect(await store.prune({ olderThanMs: 1000 })).toBe(1);
      expect(await store.get('chosen')).toBeDefined();
      expect(await store.prune({ olderThanMs: 1000, includeExplicit: true })).toBe(1);
      expect(await store.get('chosen')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
