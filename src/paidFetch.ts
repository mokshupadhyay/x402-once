import type { PaymentRequired } from '@x402/core/types';
import {
  AlreadySettledError,
  PurchaseSettledElsewhereError,
  SettledWithoutDeliveryError,
  StaleRecordError,
  StoreConflictError,
  TooManyPresentationsError,
  UnresolvedPaymentError,
  UnsafeRedirectError,
  ValidityTooLongError,
} from './errors.js';
import { deriveIntent } from './intent.js';
import { expiryOf } from './resolve.js';
import { MemoryPaymentStore } from './store.js';
import { RECORD_SCHEMA, validateRecord } from './validate.js';
import type { PaidFetch, PaidFetchOptions, PaymentRecord, PaymentStore, SettlementFinding, X402HttpClientLike } from './types.js';

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
  const rawNow = options.now ?? Date.now;
  // A clock that returns NaN would make every deadline comparison false and skip the safety waits. Refuse it.
  const now = (): number => {
    const time = rawNow();
    if (!Number.isFinite(time)) throw new Error('x402-once: now() did not return a finite number');
    return time;
  };
  const positiveInt = (value: number | undefined, fallback: number) => (Number.isInteger(value) && (value as number) >= 1 ? (value as number) : fallback);
  const nonNegative = (value: number | undefined, fallback: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  const maxPresentations = positiveInt(options.maxPresentations, 5);
  const skew = nonNegative(options.expirySkewMs, 30_000);
  const maxValidityMs = nonNegative(options.maxValidityMs, 3_600_000);
  const requestTimeoutMs = nonNegative(options.requestTimeoutMs, 60_000);
  // A throwing listener must never lose a response that was already paid for.
  const emit = (event: Parameters<NonNullable<PaidFetchOptions['onEvent']>>[0]): void => {
    try {
      options.onEvent?.(event);
    } catch {
      /* ignore */
    }
  };
  const inFlight = new Map<string, Promise<Response>>();
  const background = new Set<Promise<unknown>>();
  let httpClientPromise: Promise<X402HttpClientLike> | undefined;

  const httpClient = (): Promise<X402HttpClientLike> => {
    if (options.httpClient) return Promise.resolve(options.httpClient);
    httpClientPromise ??= import('@x402/core/client').then(
      (mod) => new mod.x402HTTPClient(options.client as ConstructorParameters<typeof mod.x402HTTPClient>[0]),
    );
    return httpClientPromise;
  };

  /** Adds the request timeout to whatever signal the caller supplied. */
  function limited(request: Request): Request {
    if (!requestTimeoutMs || typeof AbortSignal.timeout !== 'function' || typeof AbortSignal.any !== 'function') return request;
    return new Request(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]) });
  }

  /** The first, unpaid request. Nothing secret is in it, so ordinary redirect handling is fine. */
  async function sendUnpaid(request: Request): Promise<Response> {
    return doFetch(limited(request.clone()));
  }

  /**
   * The paid request carries the signed payment, a bearer instrument. A redirect must never carry it to another
   * origin (fetch only strips Authorization on cross-origin hops, not this header), so redirects are handled here:
   * same-origin GET/HEAD hops are followed with the header re-attached; anything else stops with an error.
   */
  async function sendPaid(request: Request, headers: Record<string, string>): Promise<Response> {
    const base = request.clone();
    for (const [name, value] of Object.entries(headers)) base.headers.set(name, value);
    let current = new Request(base, { redirect: 'manual' });
    for (let hop = 0; hop <= 3; hop++) {
      const response = await doFetch(limited(current));
      const redirected = response.status >= 300 && response.status < 400 && response.status !== 304;
      if (!redirected && response.type !== 'opaqueredirect') return response;

      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      const from = current.url;
      let target: URL | undefined;
      try {
        target = location ? new URL(location, from) : undefined;
      } catch {
        target = undefined;
      }
      const method = request.method.toUpperCase();
      if (!target || target.origin !== new URL(from).origin || (method !== 'GET' && method !== 'HEAD')) {
        throw new UnsafeRedirectError(from, target?.href ?? '(unreadable location)');
      }
      current = new Request(target.href, { method, headers: base.headers, redirect: 'manual', signal: request.signal });
    }
    throw new UnsafeRedirectError(current.url, '(too many redirects)');
  }

  /** `compareAndSet` must answer exactly `{ ok: true }` or `{ ok: false }`. Anything else is a broken store, not a success. */
  async function cas(intent: string, expectedVersion: number, next: PaymentRecord) {
    const result = await store.compareAndSet(intent, expectedVersion, next);
    if (!result || typeof result !== 'object' || (result.ok !== true && result.ok !== false)) {
      throw new Error('x402-once: the store answered compareAndSet with something other than { ok: true } or { ok: false }');
    }
    return result;
  }

  /** Reads a record and refuses anything damaged or edited, instead of treating it as "nothing on record". */
  async function load(intent: string): Promise<PaymentRecord | undefined> {
    const raw = await store.get(intent);
    return raw === undefined || raw === null ? undefined : validateRecord(intent, raw);
  }

  /**
   * Moves a record forward from exactly the version we read. If anyone changed it meanwhile we do NOT re-apply our
   * change on top of theirs (that could overwrite their newer payment): we stop, and the caller starts again from
   * what is stored now.
   */
  async function update(record: PaymentRecord, patch: Partial<PaymentRecord>): Promise<PaymentRecord> {
    const next: PaymentRecord = { ...record, ...patch, version: record.version + 1, updatedAt: now() };
    const result = await cas(record.intent, record.version, next);
    if (result.ok) return next;
    emit({ type: 'conflict', intent: record.intent });
    throw new StaleRecordError(record.intent);
  }

  /** Asks the resolver, if there is one. A resolver that throws, or says nothing useful, counts as "cannot tell". */
  async function resolve(record: PaymentRecord): Promise<SettlementFinding> {
    if (!options.resolver) return { verdict: 'unknown' };
    try {
      const answer = await Promise.race([
        options.resolver(record),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('resolver timed out')), options.resolverTimeoutMs ?? 15_000).unref?.()),
      ]);
      const given: SettlementFinding = typeof answer === 'string' ? { verdict: answer } : answer;
      const verdict = given?.verdict;
      if (verdict !== 'settled' && verdict !== 'unsettled') return { verdict: 'unknown' };
      return typeof given.transaction === 'string' && given.transaction ? { verdict, transaction: given.transaction } : { verdict };
    } catch {
      return { verdict: 'unknown' };
    }
  }

  /** What to remember about the settlement when only the chain told us. */
  function settleFrom(record: PaymentRecord, finding: SettlementFinding): Partial<PaymentRecord> {
    if (!finding.transaction) return {};
    const payer = (record.payload.payload['authorization'] as { from?: unknown } | undefined)?.from;
    return {
      settle: {
        transaction: finding.transaction,
        network: record.payload.accepted.network,
        ...(typeof payer === 'string' ? { payer } : {}),
      },
    };
  }

  /** Once a purchase is delivered the signed payment is dead weight and a liability: drop it from the record. */
  const stripped = (record: PaymentRecord): Partial<PaymentRecord> => ({ headers: {}, payload: { ...record.payload, payload: {} } });

  /**
   * Hands the body to the caller untouched, but tells us how it ended. A body that dies halfway means the caller did
   * not get what it paid for, so the record goes back to `presented` and a retry re-sends the same payment instead of
   * being treated as a finished purchase.
   */
  function watchBody(response: Response, onComplete: () => void, onFailure: () => void): Response {
    if (!response.body) {
      onComplete();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            onComplete();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          onFailure();
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  async function present(request: Request, record: PaymentRecord, reused: boolean): Promise<Response> {
    emit({ type: 'presented', intent: record.intent, presentation: record.presentations, reused });
    const response = await sendPaid(request, record.headers);
    if (response.ok) {
      let settled: PaymentRecord;
      try {
        const settle = await readSettle(response);
        settled = await update(record, { status: 'settled', ...(settle ? { settle } : {}) });
        emit({ type: 'settled', intent: record.intent });
      } catch {
        // The resource arrived and was paid for. Failing to write that down must not throw it away. The record stays
        // `presented`; a later retry re-sends the same payment and, if the seller refuses it, the chain check reports it.
        return response;
      }
      const quietly = (work: Promise<unknown>) => {
        const tracked = work.catch(() => {}).finally(() => background.delete(tracked));
        background.add(tracked);
      };
      return watchBody(
        response,
        () => quietly(update(settled, stripped(settled))),
        () => quietly(update(settled, { status: 'presented' })),
      );
    }
    if (reused && options.resolver) {
      // A payment that was sent before and is refused now has either never settled or has settled and will not be
      // served twice. The chain knows which. If it settled, say so instead of handing back a bare error.
      const finding = await resolve(record);
      if (finding.verdict === 'settled') {
        emit({ type: 'resolved', intent: record.intent, verdict: 'settled' });
        const undelivered = await update(record, { status: 'undelivered', ...settleFrom(record, finding) });
        throw new SettledWithoutDeliveryError(undelivered);
      }
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
    const finding = await resolve(record);
    const verdict = finding.verdict;
    emit({ type: 'resolved', intent: record.intent, verdict });
    if (verdict === 'settled') {
      const undelivered = await update(record, { status: 'undelivered', ...settleFrom(record, finding) });
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
    const first = await sendUnpaid(request);
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
      schema: RECORD_SCHEMA,
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

    // The seller chooses how long the signed payment lives. A stolen or lost one stays usable that long, so cap it.
    if (record.expiresAt - time > maxValidityMs) {
      throw new ValidityTooLongError(Math.round((record.expiresAt - time) / 1000), maxValidityMs);
    }

    // The rule that makes everything else work: the signed payment is saved before it is sent.
    const saved = await cas(intent, previous?.version ?? 0, record);
    if (!saved.ok) {
      emit({ type: 'conflict', intent });
      return 'conflict'; // Someone else signed first. The unsent payment is dropped; nothing was charged.
    }
    return present(request, record, false);
  }

  async function run(request: Request, intent: string, explicit: boolean): Promise<Response> {
    const startedAt = now();
    let sawConflict = false;
    for (let round = 0; round < 4; round++) {
      try {
        let previous = await load(intent);
        if (previous && sawConflict && previous.status === 'settled' && previous.updatedAt >= startedAt) {
          throw new PurchaseSettledElsewhereError(previous);
        }
        if (previous) {
          const existing = await handleExisting(request, previous);
          if (existing instanceof Response) return existing;
          previous = existing.fresh;
        }
        const outcome = await createAndPresent(request, intent, explicit, previous);
        if (outcome !== 'conflict') return outcome;
      } catch (error) {
        if (!(error instanceof StaleRecordError)) throw error;
        sawConflict = true;
        // Another process moved this purchase on while we were deciding. Look again; never act on the old picture.
      }
    }
    throw new StoreConflictError(intent);
  }

  const paidFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.signal.throwIfAborted(); // an already-cancelled call must not use up one of the saved payment's sends
    const headerKey = request.headers.get('Idempotency-Key') ?? undefined;
    const chosen = (await options.intentKey?.(request)) ?? headerKey;
    const derived = await deriveIntent(request);
    const explicit = chosen !== undefined && chosen !== '';
    // A key the caller chose means "this exact purchase": it is bound to the request, so reusing a key for a different
    // URL or body is a different purchase and can never send one request's payment to another resource.
    const intent = explicit ? `${chosen}:${derived}` : derived;

    // Calls for the same purchase that overlap in time share one run. Every caller gets its own copy of the response.
    let running = inFlight.get(intent);
    const owner = running === undefined;
    if (!running) {
      running = run(request, intent, explicit);
      inFlight.set(intent, running);
    }
    try {
      const response = await running;
      const copy = response.clone();
      // Every caller reads its own copy. Once they have all taken theirs (in this same turn), drop the retained
      // original: left unread it would make the stream buffer everything and block a caller's cancel().
      if (owner) setTimeout(() => void response.body?.cancel().catch(() => {}), 0);
      return copy;
    } finally {
      if (owner) inFlight.delete(intent);
    }
  };

  /**
   * Gives up on a purchase, so the next call for it starts a new one. Use it after you have dealt with an
   * `UnresolvedPaymentError` or `SettledWithoutDeliveryError` (for example, got a refund) and want to buy again.
   */
  async function forget(intent: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await load(intent);
      if (!record || record.status === 'abandoned') return;
      try {
        await update(record, { status: 'abandoned' });
        return;
      } catch (error) {
        if (!(error instanceof StaleRecordError)) throw error;
      }
    }
    throw new StoreConflictError(intent);
  }

  /** Resolves when the bookkeeping that runs after a response was handed over has finished. Await it before exiting. */
  async function idle(): Promise<void> {
    while (background.size) await Promise.all([...background]);
  }

  return Object.assign(paidFetch, { forget, idle, store });
}

async function readCapped(response: Response): Promise<string> {
  const tooLarge = () => new Error('Payment requirements response is too large');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PAYMENT_REQUIRED_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAYMENT_REQUIRED_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
