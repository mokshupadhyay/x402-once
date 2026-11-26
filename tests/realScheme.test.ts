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
      const body = JSON.parse(String(init?.body)) as { params: [{ to: string; data: string }] };
      calls.push(body.params[0]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(63) + '1' }));
    };
    const resolve = evmAuthorizationResolver({ rpcUrls: { 'eip155:84532': 'https://rpc.test' }, fetch: rpc as typeof fetch });

    expect(await resolve(record)).toBe('settled');
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
    const answer = (result: unknown, ok = true) =>
      evmAuthorizationResolver({
        rpcUrls: { 'eip155:84532': 'https://rpc.test' },
        fetch: (async () => new Response(JSON.stringify(result), { status: ok ? 200 : 500 })) as typeof fetch,
      });

    expect(await answer({ result: '0x' + '0'.repeat(64) })(record)).toBe('unsettled');
    expect(await answer({ error: { code: -32000 } })(record)).toBe('unknown');
    expect(await answer({ result: '0x2' })(record)).toBe('unknown');
    expect(await answer({}, false)(record)).toBe('unknown');
    expect(await evmAuthorizationResolver({ rpcUrls: {} })(record)).toBe('unknown'); // no RPC for this network
  });
});
