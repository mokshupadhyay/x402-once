import { createPaidFetch, MemoryPaymentStore, type PaidFetchEvent, type PaidFetchOptions, type PaymentStore } from '../src/index.js';
import { createFakeClient, createSimulatedMerchant, type SimulatedMerchantOptions } from '../src/testing/index.js';

export const URL_A = 'https://seller.test/api/report';

/** A clock the test moves by hand, shared by the seller, the signer and the wrapper. */
export function createClock(start = 1_800_000_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

export function setup(
  merchantOptions: SimulatedMerchantOptions = {},
  paidOptions: Partial<PaidFetchOptions> = {},
  store: PaymentStore = new MemoryPaymentStore(),
  /** Called with every request just before the seller sees it. */
  onRequest?: (request: Request) => void | Promise<void>,
  /** Reuse another setup's clock, seller and signer, to model a second process talking to the same seller. */
  shared?: { clock: ReturnType<typeof createClock>; merchant: ReturnType<typeof createSimulatedMerchant>; client: ReturnType<typeof createFakeClient> },
) {
  const clock = shared?.clock ?? createClock();
  const merchant = shared?.merchant ?? createSimulatedMerchant({ now: clock.now, ...merchantOptions });
  const client = shared?.client ?? createFakeClient('eip155:84532', { now: clock.now });
  const events: PaidFetchEvent[] = [];
  const spying = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    await onRequest?.(request.clone());
    return merchant.fetch(request);
  };
  const build = () =>
    createPaidFetch({
      client,
      fetch: spying,
      store,
      now: clock.now,
      onEvent: (e) => events.push(e),
      ...paidOptions,
    });
  return { clock, merchant, client, events, store, paidFetch: build(), build };
}

/** Calls fetch and reports a thrown network error as `'network-error'`, so tests can retry like an app would. */
export async function attempt(fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, url = URL_A, init?: RequestInit) {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    if (error instanceof TypeError) return 'network-error' as const;
    throw error;
  }
}
