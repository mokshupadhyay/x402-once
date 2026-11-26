import { wrapFetchWithPayment } from '@x402/fetch';
import { describe, expect, it } from 'vitest';
import { createFakeClient, createSimulatedMerchant, scriptedFaults } from '../src/testing/index.js';
import { attempt, setup, URL_A } from './helpers.js';

/**
 * The bug, shown with the real `@x402/fetch` wrapper from the x402 repository.
 * A response is lost after the seller settled. The app retries. The stock client signs a second authorization
 * with a new nonce, and the seller settles it too: the buyer paid twice for one purchase.
 */
describe('stock @x402/fetch', () => {
  it('pays twice when a response is lost after settlement and the app retries', async () => {
    const merchant = createSimulatedMerchant({ faults: scriptedFaults('drop-after-settle') });
    const client = createFakeClient();
    const stockFetch = wrapFetchWithPayment(merchant.fetch, client);

    expect(await attempt(stockFetch)).toBe('network-error'); // settled, then the response was lost
    const retry = await attempt(stockFetch); // the app retries the same purchase
    expect(retry).not.toBe('network-error');

    expect(merchant.settlementCount).toBe(2); // two payments for one purchase
    expect(merchant.totalSettled).toBe(20000n);
  });
});

describe('x402-once on the same scenario', () => {
  it('pays once', async () => {
    const { merchant, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });

    expect(await attempt(paidFetch)).toBe('network-error');
    const retry = await attempt(paidFetch);

    expect(retry).not.toBe('network-error');
    expect((retry as Response).status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
    expect(merchant.totalSettled).toBe(10000n);
    expect(URL_A).toContain('seller.test');
  });
});
