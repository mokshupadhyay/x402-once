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

/** A mock JSON-RPC node for resolver tests. Answers per method, like a real one. */
export function chainFetch(options: {
  chainId?: string;
  call?: unknown;
  timestamp?: string | undefined;
  number?: string;
  logs?: unknown;
  httpStatus?: number;
  bodyPrefix?: string;
  calls?: { method: string; params: unknown[]; init?: RequestInit }[];
} = {}) {
  const json = (result: unknown) => new Response((options.bodyPrefix ?? '') + JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: options.httpStatus ?? 200 });
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    options.calls?.push({ ...body, ...(init ? { init } : {}) });
    switch (body.method) {
      case 'eth_chainId':
        return json(options.chainId ?? '0x14a34');
      case 'eth_getBlockByNumber':
        return json(options.timestamp === undefined ? null : { number: options.number ?? '0x10', timestamp: options.timestamp });
      case 'eth_call':
        return json(options.call ?? '0x' + '0'.repeat(64));
      case 'eth_blockNumber':
        return json(options.number ?? '0x10');
      case 'eth_getLogs':
        return options.logs === 'fail' ? new Response(JSON.stringify({ error: { code: -32005 } })) : json(options.logs ?? []);
      default:
        return json(null);
    }
  }) as typeof fetch;
}
