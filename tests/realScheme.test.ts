import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createPaidFetch, expiryOf, MemoryPaymentStore, type PaymentRecord } from '../src/index.js';
import { createSimulatedMerchant, scriptedFaults } from '../src/testing/index.js';
import { attempt, createClock } from './helpers.js';

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
});
