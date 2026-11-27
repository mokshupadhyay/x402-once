import { describe, expect, it } from 'vitest';
import { createPaidFetch, evmAuthorizationResolver, expiryOf, MemoryPaymentStore, PaymentMismatchError, type PaymentRecord } from '../src/index.js';
import { createFakeClient, createSimulatedMerchant } from '../src/testing/index.js';
import { chainFetch, createClock, URL_A } from './helpers.js';

const PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PAYER = '0x1111111111111111111111111111111111111111';

/** A signer that produces Permit2 payments (the shape @x402/evm builds), or whatever else `shape` says. */
function setup(shape: (payload: any, required: any) => void, paidOptions: Record<string, unknown> = {}) {
  const clock = createClock(Date.now());
  const merchant = createSimulatedMerchant({ now: clock.now });
  const real = createFakeClient('eip155:84532', { now: clock.now });
  const client = {
    createPaymentPayload: async (required: any) => {
      const payload = await real.createPaymentPayload(required);
      shape(payload, required);
      return payload;
    },
  };
  let sent = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!request.headers.has('PAYMENT-SIGNATURE')) return merchant.fetch(request);
    sent++;
    return new Response('{"paid":true}', { status: 200 });
  };
  const store = new MemoryPaymentStore();
  const paid = createPaidFetch({ client: client as never, fetch: fetchImpl as typeof fetch, store, now: clock.now, ...paidOptions });
  return { paid, store, sent: () => sent, clock };
}

const toPermit2 = (overrides: Record<string, unknown> = {}, nonce = '123456789') => (payload: any) => {
  const a = payload.accepted;
  payload.payload = {
    signature: '0x' + '00'.repeat(65),
    permit2Authorization: {
      from: PAYER,
      permitted: { token: a.asset, amount: a.amount },
      spender: PROXY,
      nonce,
      deadline: String(Math.floor(Date.now() / 1000) + 60),
      witness: { to: a.payTo, validAfter: '0' },
      ...overrides,
    },
  };
};

describe('Permit2 payments are inspected before they are saved or sent', () => {
  it('an honest Permit2 payment goes through, and its deadline is the Permit2 deadline', async () => {
    const { paid, store, sent } = setup(toPermit2());
    expect((await paid(URL_A)).status).toBe(200);
    expect(sent()).toBe(1);
    const record = [...(store as unknown as { records: Map<string, PaymentRecord> }).records.values()][0]!;
    expect(expiryOf({ permit2Authorization: { deadline: '1800000000' } }, 60, 0)).toBe(1_800_000_000_000);
    expect(record.status).toBe('settled');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a spender that is not the x402 proxy (it could send the money anywhere)', { spender: '0x' + 'ab'.repeat(20) }],
    ['a different token', { permitted: { token: '0x' + 'cd'.repeat(20), amount: '10000' } }],
    ['a different amount', { permitted: { token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '99999999' } }],
    ['a different payee', { witness: { to: '0x' + 'ee'.repeat(20), validAfter: '0' } }],
    ['a payer that is not an address', { from: 'me' }],
    ['a nonce that is not a number', { nonce: 'abc' }],
  ])('refuses %s, and sends nothing', async (_name, overrides) => {
    const { paid, sent, store } = setup(toPermit2(overrides));
    await expect(paid(URL_A)).rejects.toBeInstanceOf(PaymentMismatchError);
    expect(sent()).toBe(0);
    expect((store as unknown as { records: Map<string, unknown> }).records.size).toBe(0);
  });

  it('another spender is accepted only when you list it', async () => {
    const other = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
    expect(await setup(toPermit2({ spender: other })).paid(URL_A).catch((e) => e)).toBeInstanceOf(PaymentMismatchError);
    const allowed = setup(toPermit2({ spender: other }), { limits: { permit2Spenders: [other] } });
    expect((await allowed.paid(URL_A)).status).toBe(200);
  });
});

describe('payment types that cannot be inspected', () => {
  const solanaLike = (payload: any) => {
    payload.payload = { transaction: 'AQAB...' };
  };
  it('are refused by default, before anything is sent', async () => {
    const { paid, sent } = setup(solanaLike);
    await expect(paid(URL_A)).rejects.toThrow(/cannot be inspected/);
    expect(sent()).toBe(0);
  });
  it('go through only when you opt in', async () => {
    const { paid, sent } = setup(solanaLike, { allowUninspected: true });
    expect((await paid(URL_A)).status).toBe(200);
    expect(sent()).toBe(1);
  });
});

describe('the resolver understands Permit2 nonces', () => {
  const NETWORK = 'eip155:84532';
  async function record(nonce: string) {
    const { paid, store } = setup(toPermit2({}, nonce));
    await paid(URL_A);
    const found = [...(store as unknown as { records: Map<string, PaymentRecord> }).records.values()][0]!;
    // pretend it was still open
    return { ...found, status: 'presented' as const, payload: { ...found.payload, payload: { permit2Authorization: { from: PAYER, nonce, deadline: String(Math.floor(Date.now() / 1000)) } } } } as PaymentRecord;
  }
  const deadline = () => Math.floor(Date.now() / 1000);
  const hex = (n: number) => '0x' + n.toString(16);
  const word = (bit: number) => '0x' + (1n << BigInt(bit)).toString(16).padStart(64, '0');

  it('reads the right word and bit of Permit2\'s nonce bitmap', async () => {
    const nonce = String(5n * 256n + 13n); // word 5, bit 13
    const calls: { method: string; params: unknown[] }[] = [];
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'https://rpc.test' }, fetch: chainFetch({ call: word(13), timestamp: hex(deadline()), calls }) });
    const found = await resolve(await record(nonce));
    expect(found.verdict).toBe('settled');
    const call = calls.find((c) => c.method === 'eth_call')!.params[0] as { to: string; data: string };
    expect(call.to.toLowerCase()).toBe(PERMIT2.toLowerCase());
    expect(call.data).toBe('0x4fe02b44' + '0'.repeat(24) + PAYER.slice(2).toLowerCase() + (5).toString(16).padStart(64, '0'));
  });

  it('a different bit in the same word is not this payment', async () => {
    const nonce = String(5n * 256n + 13n);
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'https://rpc.test' }, fetch: chainFetch({ call: word(14), timestamp: hex(deadline() + 999) }) });
    expect((await resolve(await record(nonce))).verdict).toBe('unsettled');
  });

  it('"never used" waits for the chain to pass the deadline plus the margin', async () => {
    const resolve = (offset: number) => evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'https://rpc.test' }, fetch: chainFetch({ call: '0x' + '0'.repeat(64), timestamp: hex(deadline() + offset) }) });
    const open = await record('77');
    expect((await resolve(5)(open)).verdict).toBe('unknown');
    expect((await resolve(120)(open)).verdict).toBe('unsettled');
  });

  it('a nonce at the top of the 256-bit range is handled', async () => {
    const nonce = ((1n << 255n) + 255n).toString();
    const resolve = evmAuthorizationResolver({ rpcUrls: { [NETWORK]: 'https://rpc.test' }, fetch: chainFetch({ call: word(255), timestamp: hex(deadline()) }) });
    expect((await resolve(await record(nonce))).verdict).toBe('settled');
  });
});

describe('minProviders', () => {
  it('refuses to be set up with fewer providers than you require', () => {
    expect(() => evmAuthorizationResolver({ rpcUrls: { 'eip155:8453': 'https://a.test' }, minProviders: 2 })).toThrow(/minProviders/);
    expect(() => evmAuthorizationResolver({ rpcUrls: { 'eip155:8453': ['https://a.test', 'https://b.test'] }, minProviders: 2 })).not.toThrow();
  });
});
