import type { PaymentRequired } from '@x402/core/types';
import {
  AlreadySettledError,
  SettledWithoutDeliveryError,
  StoreConflictError,
  TooManyPresentationsError,
  UnresolvedPaymentError,
} from './errors.js';
import { deriveIntent } from './intent.js';
import { expiryOf } from './resolve.js';
import { MemoryPaymentStore } from './store.js';
import type { PaidFetch, PaidFetchOptions, PaymentRecord, PaymentStore, X402HttpClientLike } from './types.js';

const MAX_PAYMENT_REQUIRED_BYTES = 64 * 1024;

/** Either a finished response, or the instruction to start a new purchase after this (now dead) record. */
type Existing = Response | { fresh: PaymentRecord | undefined };

/**
 * Wraps `fetch` so a purchase is paid at most once, however many times it is retried.
 *
 * The first time a request gets a 402, the signed payment is saved and then sent. A retry of the same purchase
 * (a timeout, a lost response, a 5xx, a restart) sends the saved payment again instead of signing a new one. A new
 * payment is signed only when the old one has provably expired without settling.
 */
export function createPaidFetch(options: PaidFetchOptions): PaidFetch {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const store: PaymentStore = options.store ?? new MemoryPaymentStore();
  const now = options.now ?? Date.now;
  const maxPresentations = options.maxPresentations ?? 5;
  const skew = options.expirySkewMs ?? 30_000;
  const emit = options.onEvent ?? (() => {});
  const inFlight = new Map<string, Promise<Response>>();
  let httpClientPromise: Promise<X402HttpClientLike> | undefined;

  const httpClient = (): Promise<X402HttpClientLike> => {
    if (options.httpClient) return Promise.resolve(options.httpClient);
    httpClientPromise ??= import('@x402/core/client').then(
      (mod) => new mod.x402HTTPClient(options.client as ConstructorParameters<typeof mod.x402HTTPClient>[0]),
    );
    return httpClientPromise;
  };

  async function send(request: Request, headers: Record<string, string>): Promise<Response> {
    const outgoing = request.clone();
    for (const [name, value] of Object.entries(headers)) outgoing.headers.set(name, value);
    return doFetch(outgoing);
  }

  async function update(record: PaymentRecord, patch: Partial<PaymentRecord>): Promise<PaymentRecord> {
    let base = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next: PaymentRecord = { ...base, ...patch, version: base.version + 1, updatedAt: now() };
      const result = await store.compareAndSet(record.intent, base.version, next);
      if (result.ok) return next;
      emit({ type: 'conflict', intent: record.intent });
      if (!result.current) break;
      base = result.current;
    }
    throw new StoreConflictError(record.intent);
  }

  async function present(request: Request, record: PaymentRecord, reused: boolean): Promise<Response> {
    emit({ type: 'presented', intent: record.intent, presentation: record.presentations, reused });
    const response = await send(request, record.headers);
    if (response.ok) {
      const settle = await readSettle(response);
      await update(record, { status: 'settled', ...(settle ? { settle } : {}) });
      emit({ type: 'settled', intent: record.intent });
    }
    return response;
  }

  async function readSettle(response: Response): Promise<PaymentRecord['settle'] | undefined> {
    try {
      const settled = (await httpClient()).getPaymentSettleResponse((name) => response.headers.get(name));
      return { transaction: settled.transaction, network: settled.network, ...(settled.payer ? { payer: settled.payer } : {}) };
    } catch {
      return undefined;
    }
  }

  async function handleExisting(request: Request, record: PaymentRecord): Promise<Existing> {
    if (record.status === 'settled') {
      if (record.explicit) throw new AlreadySettledError(record);
      return { fresh: record };
    }
    if (record.status === 'undelivered') throw new SettledWithoutDeliveryError(record);
    if (record.status !== 'presented') return { fresh: record };

    const time = now();
    if (time <= record.expiresAt) {
      if (record.presentations >= maxPresentations) throw new TooManyPresentationsError(record, maxPresentations);
      const next = await update(record, { presentations: record.presentations + 1 });
      return present(request, next, true);
    }

    if (time <= record.expiresAt + skew) {
      throw new UnresolvedPaymentError(record, 'the deadline just passed and the chain cannot be trusted yet');
    }
    const verdict = (await options.resolver?.(record)) ?? 'unknown';
    emit({ type: 'resolved', intent: record.intent, verdict });
    if (verdict === 'settled') {
      const undelivered = await update(record, { status: 'undelivered' });
      throw new SettledWithoutDeliveryError(undelivered);
    }
    if (verdict === 'unsettled') {
      return { fresh: await update(record, { status: 'expired' }) };
    }
    throw new UnresolvedPaymentError(
      record,
      options.resolver ? 'the resolver could not tell whether it settled' : 'no resolver is configured to check whether it settled',
    );
  }

  async function createAndPresent(
    request: Request,
    intent: string,
    explicit: boolean,
    previous: PaymentRecord | undefined,
  ): Promise<Response | 'conflict'> {
    const first = await send(request, {});
    if (first.status !== 402) return first;

    const text = await readCapped(first);
    const http = await httpClient();
    let paymentRequired: PaymentRequired;
    try {
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      paymentRequired = http.getPaymentRequiredResponse((name) => first.headers.get(name), body);
    } catch (error) {
      throw new Error(`Failed to parse payment requirements: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    const payload = await options.client.createPaymentPayload(paymentRequired);
    emit({ type: 'signed', intent });
    const time = now();
    const record: PaymentRecord = {
      version: (previous?.version ?? 0) + 1,
      intent,
      explicit,
      status: 'presented',
      createdAt: time,
      updatedAt: time,
      presentations: 1,
      paymentRequired,
      payload,
      headers: {
        ...http.encodePaymentSignatureHeader(payload),
        'Access-Control-Expose-Headers': 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE',
      },
      expiresAt: expiryOf(payload.payload, payload.accepted.maxTimeoutSeconds, time),
    };

    // The rule that makes everything else work: the signed payment is saved before it is sent.
    const saved = await store.compareAndSet(intent, previous?.version ?? 0, record);
    if (!saved.ok) {
      emit({ type: 'conflict', intent });
      return 'conflict'; // Someone else signed first. The unsent payment is dropped; nothing was charged.
    }
    return present(request, record, false);
  }

  async function run(request: Request, intent: string, explicit: boolean): Promise<Response> {
    for (let round = 0; round < 3; round++) {
      let previous = await store.get(intent);
      if (previous) {
        const existing = await handleExisting(request, previous);
        if (existing instanceof Response) return existing;
        previous = existing.fresh;
      }
      const outcome = await createAndPresent(request, intent, explicit, previous);
      if (outcome !== 'conflict') return outcome;
    }
    throw new StoreConflictError(intent);
  }

  const paidFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const headerKey = request.headers.get('Idempotency-Key') ?? undefined;
    const chosen = (await options.intentKey?.(request)) ?? headerKey;
    const intent = chosen ?? (await deriveIntent(request));
    const explicit = chosen !== undefined;

    // Calls for the same purchase that overlap in time share one run. Every caller gets its own copy of the response.
    let running = inFlight.get(intent);
    const owner = running === undefined;
    if (!running) {
      running = run(request, intent, explicit);
      inFlight.set(intent, running);
    }
    try {
      return (await running).clone();
    } finally {
      if (owner) inFlight.delete(intent);
    }
  };

  /**
   * Gives up on a purchase, so the next call for it starts a new one. Use it after you have dealt with an
   * `UnresolvedPaymentError` or `SettledWithoutDeliveryError` (for example, got a refund) and want to buy again.
   */
  async function forget(intent: string): Promise<void> {
    const record = await store.get(intent);
    if (record && record.status !== 'abandoned') await update(record, { status: 'abandoned' });
  }

  return Object.assign(paidFetch, { forget, store });
}

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_PAYMENT_REQUIRED_BYTES) throw new Error('Payment requirements response is too large');
  return text;
}
