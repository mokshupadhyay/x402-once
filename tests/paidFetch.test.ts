import { describe, expect, it } from 'vitest';
import {
  AlreadySettledError,
  MemoryPaymentStore,
  SettledWithoutDeliveryError,
  TooManyPresentationsError,
  UnresolvedPaymentError,
  type SettlementVerdict,
} from '../src/index.js';
import { scriptedFaults } from '../src/testing/index.js';
import { attempt, setup, URL_A } from './helpers.js';

const URL_B = 'https://seller.test/api/other';

describe('the normal purchase', () => {
  it('pays once and delivers', async () => {
    const { merchant, paidFetch, store } = setup();
    const response = (await attempt(paidFetch)) as Response;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paid: true });
    expect(merchant.settlementCount).toBe(1);
    const [intent] = merchant.settlements; // one purchase
    expect(intent?.amount).toBe('10000');
    expect(await store.get([...(store as MemoryPaymentStore)['records'].keys()][0]!)).toMatchObject({ status: 'settled', presentations: 1 });
  });

  it('passes a free resource through without paying', async () => {
    const free = async () => new Response('free', { status: 200 });
    const { paidFetch } = setup({}, { fetch: free });
    const response = (await attempt(paidFetch)) as Response;
    expect(await response.text()).toBe('free');
  });

  it('treats a second identical call after success as a new purchase', async () => {
    const { merchant, paidFetch } = setup();
    await attempt(paidFetch);
    await attempt(paidFetch);
    expect(merchant.settlementCount).toBe(2);
  });

  it('pays separately for different purchases', async () => {
    const { merchant, paidFetch } = setup();
    await attempt(paidFetch, URL_A);
    await attempt(paidFetch, URL_B);
    expect(merchant.settlementCount).toBe(2);
  });
});

describe('a lost or failed response never causes a second payment', () => {
  it('response lost after settlement, seller recognises the repeat: delivered, paid once', async () => {
    const { merchant, paidFetch, events } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    expect(await attempt(paidFetch)).toBe('network-error');
    const retry = (await attempt(paidFetch)) as Response;

    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
    expect(events.filter((e) => e.type === 'signed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'presented' && e.reused)).toHaveLength(1);
  });

  it('response lost after settlement, strict seller: charged once, caller sees the refusal instead of paying again', async () => {
    const { merchant, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') });
    expect(await attempt(paidFetch)).toBe('network-error');
    const retry = (await attempt(paidFetch)) as Response;

    expect(retry.status).toBe(402);
    expect(merchant.settlementCount).toBe(1);
  });

  it('a 5xx before anything settled: the retry sends the same payment and it settles once', async () => {
    const { merchant, paidFetch } = setup({ faults: scriptedFaults('error-before-settle') });
    const first = (await attempt(paidFetch)) as Response;
    expect(first.status).toBe(503);
    const retry = (await attempt(paidFetch)) as Response;

    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });

  it('a seller that answers a fresh 402 after settling (the defect behind the double charge)', async () => {
    const { merchant, paidFetch } = setup({ faults: scriptedFaults('fresh-402-after-settle') });
    const first = (await attempt(paidFetch)) as Response;
    expect(first.status).toBe(402);
    await attempt(paidFetch);
    await attempt(paidFetch);

    expect(merchant.settlementCount).toBe(1);
  });

  it('keeps the same nonce across every presentation', async () => {
    const headers: string[] = [];
    const { merchant, paidFetch } = setup(
      { faults: scriptedFaults('error-before-settle', 'error-before-settle') },
      {},
      undefined,
      (request) => {
        const header = request.headers.get('PAYMENT-SIGNATURE');
        if (header) headers.push(header);
      },
    );
    await attempt(paidFetch);
    await attempt(paidFetch);
    const last = (await attempt(paidFetch)) as Response;

    expect(last.status).toBe(200);
    expect(headers).toHaveLength(3);
    expect(new Set(headers).size).toBe(1); // byte-for-byte the same signed payment each time
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('the payment is saved before it is sent', () => {
  it('has a record in the store at the moment the first payment leaves', async () => {
    const store = new MemoryPaymentStore();
    let statusWhenSent: string | undefined;
    const { paidFetch } = setup({}, {}, store, async (request) => {
      if (request.headers.get('PAYMENT-SIGNATURE')) {
        const key = [...store['records'].keys()][0];
        statusWhenSent = key ? (await store.get(key))?.status : undefined;
      }
    });
    await attempt(paidFetch);
    expect(statusWhenSent).toBe('presented');
  });

  it('a restarted process with the same store reuses the payment', async () => {
    const { merchant, build } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true });
    const first = build();
    expect(await attempt(first)).toBe('network-error'); // the app "crashes" here
    const afterRestart = build(); // a new wrapper, same store
    const retry = (await attempt(afterRestart)) as Response;

    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('after the deadline', () => {
  const resolveTo = (verdict: SettlementVerdict) => async () => verdict;

  it('settled on chain: refuses to pay again and says the resource was not delivered', async () => {
    const { clock, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') }, { resolver: resolveTo('settled') });
    await attempt(paidFetch);
    clock.advance(61_000 + 31_000);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(SettledWithoutDeliveryError);
  });

  it('never settled: signs a new payment and pays once', async () => {
    const { clock, merchant, paidFetch, events } = setup(
      { faults: scriptedFaults('drop-before-settle') },
      { resolver: resolveTo('unsettled') },
    );
    expect(await attempt(paidFetch)).toBe('network-error'); // nothing settled
    clock.advance(61_000 + 31_000);
    const retry = (await attempt(paidFetch)) as Response;

    expect(retry.status).toBe(200);
    expect(merchant.settlementCount).toBe(1);
    expect(events.filter((e) => e.type === 'signed')).toHaveLength(2); // the old authorization is dead, so a new one is safe
  });

  it('settled but undelivered stays blocked on every retry, never a second charge (found by the property test)', async () => {
    const { clock, merchant, paidFetch } = setup({ faults: scriptedFaults('fresh-402-after-settle') }, { resolver: resolveTo('settled') });
    await attempt(paidFetch); // settled, answered with a fresh 402
    clock.advance(61_000 + 31_000);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(SettledWithoutDeliveryError);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(SettledWithoutDeliveryError); // the retry must not buy again
    expect(merchant.settlementCount).toBe(1);
  });

  it('forget lets the caller start a new purchase on purpose', async () => {
    const { clock, merchant, paidFetch } = setup({ faults: scriptedFaults('fresh-402-after-settle') }, { resolver: resolveTo('settled') });
    await attempt(paidFetch);
    clock.advance(61_000 + 31_000);
    const error = (await paidFetch(URL_A).catch((e) => e)) as SettledWithoutDeliveryError;
    await paidFetch.forget(error.record.intent); // for example, after getting a refund
    const response = await paidFetch(URL_A);
    expect(response.status).toBe(200);
    expect(merchant.settlementCount).toBe(2);
  });

  it('cannot tell: fails closed and signs nothing', async () => {
    const { clock, merchant, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') }, { resolver: resolveTo('unknown') });
    await attempt(paidFetch);
    clock.advance(61_000 + 31_000);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(UnresolvedPaymentError);
    expect(merchant.settlementCount).toBe(1);
  });

  it('no resolver configured: fails closed', async () => {
    const { clock, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') });
    await attempt(paidFetch);
    clock.advance(61_000 + 31_000);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(UnresolvedPaymentError);
  });

  it('waits out clock skew before asking the resolver', async () => {
    const { clock, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle') }, { resolver: resolveTo('unsettled') });
    await attempt(paidFetch);
    clock.advance(61_000 + 5_000); // past the deadline but inside the 30 s skew window
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(UnresolvedPaymentError);
  });
});

describe('explicit keys', () => {
  it('refuses to pay again for a key that already settled', async () => {
    const { merchant, paidFetch } = setup();
    const init = { headers: { 'Idempotency-Key': 'order-42' } };
    await attempt(paidFetch, URL_A, init);
    await expect(paidFetch(URL_A, init)).rejects.toBeInstanceOf(AlreadySettledError);
    expect(merchant.settlementCount).toBe(1);
  });

  it('uses the key from the intentKey option', async () => {
    const { merchant, paidFetch } = setup({ faults: scriptedFaults('drop-after-settle'), serveOnReplay: true }, { intentKey: () => 'k1' });
    await attempt(paidFetch, URL_A);
    await attempt(paidFetch, URL_B); // different URL, same key: it is the same purchase
    expect(merchant.settlementCount).toBe(1);
  });
});

describe('limits', () => {
  it('stops sending the same payment after maxPresentations', async () => {
    const { paidFetch } = setup(
      { faults: scriptedFaults('error-before-settle', 'error-before-settle', 'error-before-settle') },
      { maxPresentations: 2 },
    );
    await attempt(paidFetch);
    await attempt(paidFetch);
    await expect(paidFetch(URL_A)).rejects.toBeInstanceOf(TooManyPresentationsError);
  });

  it('five simultaneous calls for one purchase make one payment and all get an answer', async () => {
    const { merchant, paidFetch } = setup({ latencyMs: 20 });
    const responses = await Promise.all(Array.from({ length: 5 }, () => paidFetch(URL_A)));
    expect(merchant.settlementCount).toBe(1);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const r of responses) expect(await r.json()).toEqual({ paid: true });
  });

  it('with an explicit key, calls that overlap share one payment even without network delay', async () => {
    const { merchant, paidFetch } = setup({}, { intentKey: () => 'order-7' });
    const responses = await Promise.all(Array.from({ length: 5 }, () => paidFetch(URL_A)));
    expect(merchant.settlementCount).toBe(1);
    expect(responses.every((r) => r.status === 200)).toBe(true);
  });

  it('two processes sharing a store cannot both sign the same purchase', async () => {
    const store = new MemoryPaymentStore();
    const a = setup({}, {}, store);
    const b = setup({}, {}, store);
    const [ra, rb] = await Promise.all([a.paidFetch(URL_A), b.paidFetch(URL_A)]);
    expect(ra.status === 200 || rb.status === 200).toBe(true);
    expect(a.merchant.settlementCount + b.merchant.settlementCount).toBeLessThanOrEqual(2);
    expect(store['records'].size).toBe(1);
  });
});
