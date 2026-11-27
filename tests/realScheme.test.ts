import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createPaidFetch, evmAuthorizationResolver, expiryOf, MemoryPaymentStore, type PaymentRecord } from '../src/index.js';
import { createSimulatedMerchant, scriptedFaults } from '../src/testing/index.js';
import { attempt, createClock, URL_A } from './helpers.js';

/**
 * The same scenarios with the official EVM scheme from @x402/evm, signing real EIP-3009 authorizations with a
 * throwaway key generated for this test. Nothing leaves the machine: the seller is simulated, and no chain is touched.
 */
function realClient(now: () => number) {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    client: x402Client.fromConfig({
      schemes: [{ network: 'eip155:84532', client: new ExactEvmScheme(account) }],
      spendControls: false,
    }),
    now,
  };
}

describe('with the official EVM scheme', () => {
  it('the stock wrapper signs a second authorization after a lost response, and the seller settles both', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('drop-after-settle') });
    const { client } = realClient(clock.now);
    const stock = wrapFetchWithPayment(merchant.fetch, client);

    expect(await attempt(stock)).toBe('network-error');
    await attempt(stock);

    expect(merchant.settlementCount).toBe(2);
    expect(new Set(merchant.settlements.map((s) => s.nonce)).size).toBe(2); // two different nonces for one purchase
  });

  it('x402-once reuses the first signed authorization: same nonce, one settlement', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    const { client, account } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });

    expect(await attempt(paid)).toBe('network-error');
    const retry = (await attempt(paid)) as Response;

    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
    expect(merchant.settlements[0]?.payer.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('reads the real deadline from the signed authorization', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('error-before-settle'), maxTimeoutSeconds: 120 });
    const { client } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });
    await attempt(paid);

    const key = [...store['records'].keys()][0]!;
    const record = (await store.get(key)) as PaymentRecord;
    const validBefore = Number((record.payload.payload['authorization'] as { validBefore: string }).validBefore);
    expect(record.expiresAt).toBe(validBefore * 1000);
    expect(record.expiresAt).toBeGreaterThan(clock.now());
    expect(expiryOf(record.payload.payload, 120, 0)).toBe(validBefore * 1000);
  });

  it('builds the right authorizationState call from a real payload', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('error-before-settle') });
    const { client, account } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });
    await attempt(paid);
    const record = (await store.get([...store['records'].keys()][0]!)) as PaymentRecord;
    const nonce = (record.payload.payload['authorization'] as { nonce: string }).nonce;

    const calls: { to: string; data: string }[] = [];
    const rpc = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ to: string; data: string }] };
      if (body.method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: { number: '0x10', timestamp: '0x1' } }));
      if (body.method === 'eth_call') calls.push(body.params[0]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_call' ? '0x' + '0'.repeat(63) + '1' : [] }));
    };
    const resolve = evmAuthorizationResolver({ rpcUrls: { 'eip155:84532': 'https://rpc.test' }, fetch: rpc as typeof fetch });

    expect((await resolve(record)).verdict).toBe('settled');
    expect(calls[0]?.to).toBe(record.payload.accepted.asset);
    expect(calls[0]?.data).toBe('0xe94a0102' + '0'.repeat(24) + account.address.slice(2).toLowerCase() + nonce.slice(2).toLowerCase());
    expect(URL_A).toBeTruthy();
  });

  it('the resolver says unsettled for a zero result and unknown for anything it cannot read', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('error-before-settle') });
    const { client } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });
    await attempt(paid);
    const record = (await store.get([...store['records'].keys()][0]!)) as PaymentRecord;
    const auth = record.payload.payload['authorization'] as { validBefore: string };
    const pastDeadline = '0x' + (Number(auth.validBefore) + 5).toString(16);
    const answer = (callResult: unknown, ok = true, blockTime: string = pastDeadline) =>
      evmAuthorizationResolver({
        rpcUrls: { 'eip155:84532': 'https://rpc.test' },
        fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          const method = (JSON.parse(String(init?.body)) as { method: string }).method;
          if (method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: { timestamp: blockTime } }));
          return new Response(JSON.stringify(callResult), { status: ok ? 200 : 500 });
        }) as typeof fetch,
      });

    expect(await answer({ result: '0x' + '0'.repeat(64) })(record)).toEqual({ verdict: 'unsettled' });
    expect(await answer({ error: { code: -32000 } })(record)).toEqual({ verdict: 'unknown' });
    expect(await answer({ result: '0x2' })(record)).toEqual({ verdict: 'unknown' });
    expect(await answer({}, false)(record)).toEqual({ verdict: 'unknown' });
    expect(await evmAuthorizationResolver({ rpcUrls: {} })(record)).toEqual({ verdict: 'unknown' }); // no RPC for this network
  });

  it('never says "unsettled" while the chain\'s own clock is before the deadline (fast buyer clock, lagging node)', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('error-before-settle') });
    const { client } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });
    await attempt(paid);
    const record = (await store.get([...store['records'].keys()][0]!)) as PaymentRecord;
    const validBefore = Number((record.payload.payload['authorization'] as { validBefore: string }).validBefore);
    const chain = (timestamp: unknown) =>
      evmAuthorizationResolver({
        rpcUrls: { 'eip155:84532': 'https://rpc.test' },
        fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
          const method = (JSON.parse(String(init?.body)) as { method: string }).method;
          if (method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: timestamp === undefined ? null : { timestamp } }));
          return new Response(JSON.stringify({ result: '0x' + '0'.repeat(64) }));
        }) as typeof fetch,
      });
    expect(await chain('0x' + (validBefore - 1).toString(16))(record)).toEqual({ verdict: 'unknown' });
    expect(await chain(undefined)(record)).toEqual({ verdict: 'unknown' });
    expect(await chain('0x' + validBefore.toString(16))(record)).toEqual({ verdict: 'unsettled' });
  });

  it('names the transaction when the chain can show it, and still answers when it cannot', async () => {
    const clock = createClock(Date.now());
    const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults('error-before-settle') });
    const { client, account } = realClient(clock.now);
    const store = new MemoryPaymentStore();
    const paid = createPaidFetch({ client, fetch: merchant.fetch, store, now: clock.now });
    await attempt(paid);
    const record = (await store.get([...store['records'].keys()][0]!)) as PaymentRecord;
    const nonce = (record.payload.payload['authorization'] as { nonce: string }).nonce;
    const txHash = '0x' + 'ab'.repeat(32);

    const requests: { method: string; params: unknown[] }[] = [];
    const chain = (logsFail: boolean) =>
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        requests.push(body);
        if (body.method === 'eth_call') return new Response(JSON.stringify({ result: '0x' + '0'.repeat(63) + '1' }));
        if (body.method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ result: { number: '0x2710', timestamp: '0x1' } }));
        if (logsFail) return new Response(JSON.stringify({ error: { code: -32005, message: 'range too large' } }));
        return new Response(JSON.stringify({ result: [{ transactionHash: txHash }] }));
      }) as typeof fetch;
    const rpcUrls = { 'eip155:84532': 'https://rpc.test' };

    expect(await evmAuthorizationResolver({ rpcUrls, fetch: chain(false), lookbackBlocks: 100 })(record)).toEqual({ verdict: 'settled', transaction: txHash });
    const query = requests.find((r) => r.method === 'eth_getLogs')!.params[0] as { fromBlock: string; topics: string[]; address: string };
    expect(query.fromBlock).toBe('0x' + (10_000 - 100).toString(16));
    expect((query as unknown as { toBlock: string }).toBlock).toBe('0x2710'); // the same block the state was read at
    expect(query.address).toBe(record.payload.accepted.asset);
    expect(query.topics[0]).toBe('0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5');
    expect(query.topics[1]).toBe('0x' + '0'.repeat(24) + account.address.slice(2).toLowerCase());
    expect(query.topics[2]).toBe(nonce.toLowerCase());

    expect(await evmAuthorizationResolver({ rpcUrls, fetch: chain(true) })(record)).toEqual({ verdict: 'settled' });
  });
});
