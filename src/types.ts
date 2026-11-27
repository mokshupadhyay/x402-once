import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';

/**
 * Where a purchase stands.
 *
 * - `presented`: a signed payment was saved and sent at least once. Whether the seller settled it is not known.
 * - `settled`: the seller answered 2xx, so the payment settled and the resource was delivered.
 * - `undelivered`: the payment settled on chain but this client never received the resource. Calls for this purchase
 *   keep failing until the caller decides what to do (`forget`), because paying again would be a second charge.
 * - `expired`: the signed payment can no longer settle (it passed its deadline and the chain says it was never used).
 * - `abandoned`: the caller declared the purchase dead with `forget`.
 */
export type PaymentStatus = 'presented' | 'settled' | 'undelivered' | 'expired' | 'abandoned';

/** What we saved about one purchase. The payload is a signed authorization, so keep the store as private as a session token. */
export interface PaymentRecord {
  /** Format of this record, so a newer version never misreads an older store or the reverse. */
  schema?: number;
  /** Starts at 1 and goes up by one on every write. Stores use it for compare-and-set. */
  version: number;
  intent: string;
  /** True when the caller chose the key (an `Idempotency-Key` header or `intentKey`), false when we derived it from the request. */
  explicit: boolean;
  status: PaymentStatus;
  createdAt: number;
  updatedAt: number;
  /** How many times the same signed payment has been sent. */
  presentations: number;
  paymentRequired: PaymentRequired;
  payload: PaymentPayload;
  /** The encoded payment headers, ready to send again unchanged. */
  headers: Record<string, string>;
  /** When the signed payment stops being valid, in ms since the epoch. */
  expiresAt: number;
  settle?: Pick<SettleResponse, 'transaction' | 'network' | 'payer'>;
}

export type CompareAndSetResult = { ok: true } | { ok: false; current: PaymentRecord | undefined };

/**
 * Persistent memory of signed payments. Writes must happen before the payment is sent, so a crash or a lost
 * response never leaves a payment in flight that nobody remembers.
 *
 * `compareAndSet(intent, 0, record)` creates a record only if none exists. Any other `expectedVersion` replaces
 * the record only if the stored version still equals it. A store shared between processes must make this atomic.
 */
export interface PaymentStore {
  get(intent: string): Promise<PaymentRecord | undefined>;
  compareAndSet(intent: string, expectedVersion: number, next: PaymentRecord): Promise<CompareAndSetResult>;
  delete?(intent: string): Promise<void>;
}

/**
 * Answers one question about a payment whose outcome is unknown: did it settle?
 * Return `unknown` when you cannot tell. The wrapper then refuses to sign a new payment.
 */
export type SettlementVerdict = 'settled' | 'unsettled' | 'unknown';

/** A verdict, with the transaction that moved the money when the resolver could find it. */
export interface SettlementFinding {
  verdict: SettlementVerdict;
  transaction?: string;
}

export type SettlementResolver = (record: PaymentRecord) => Promise<SettlementVerdict | SettlementFinding>;

/** The part of `x402Client` that this package uses. */
export interface X402ClientLike {
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;
}

/** The part of `x402HTTPClient` that this package uses. */
export interface X402HttpClientLike {
  getPaymentRequiredResponse(getHeader: (name: string) => string | null | undefined, body?: unknown): PaymentRequired;
  encodePaymentSignatureHeader(paymentPayload: PaymentPayload): Record<string, string>;
  getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponse;
}

export type PaidFetchEvent =
  | { type: 'signed'; intent: string }
  | { type: 'presented'; intent: string; presentation: number; reused: boolean }
  | { type: 'settled'; intent: string }
  | { type: 'resolved'; intent: string; verdict: SettlementVerdict }
  | { type: 'conflict'; intent: string };

export interface PaidFetchOptions {
  /** Your configured `x402Client`. It does the signing; this package never sees a key. */
  client: X402ClientLike;
  /** Defaults to `new x402HTTPClient(client)` from `@x402/core/client`. */
  httpClient?: X402HttpClientLike;
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to an in-memory store, which only protects retries inside one process. Use a durable store for crashes and restarts. */
  store?: PaymentStore;
  /** Choose the purchase key yourself. Return `undefined` to fall back to the request's `Idempotency-Key` header, then to a key derived from method, URL and body. */
  intentKey?: (request: Request) => string | undefined | Promise<string | undefined>;
  /** Decides what to do with a payment that passed its deadline without an answer. Without one, the wrapper fails closed. */
  resolver?: SettlementResolver;
  /** Longest to wait for the resolver before treating it as "cannot tell". Default 15000 ms. */
  resolverTimeoutMs?: number;
  /** Refuse a signed payment that stays valid longer than this (the seller picks it), in ms. Default 3600000 (1 hour). */
  maxValidityMs?: number;
  /** Give up on one request to the seller after this long, in ms, so a hung seller cannot hold a purchase forever. Default 60000. 0 turns it off. */
  requestTimeoutMs?: number;
  /** Most times one signed payment may be sent. Default 5. */
  maxPresentations?: number;
  /** Extra wait after the deadline before the resolver is asked, for clock differences. Default 30000 ms. */
  expirySkewMs?: number;
  now?: () => number;
  onEvent?: (event: PaidFetchEvent) => void;
}

/** A `fetch` that pays once per purchase. */
export interface PaidFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Gives up on a purchase so the next call starts a new one. Pass the `intent` from an error's `record`. */
  forget(intent: string): Promise<void>;
  /** Resolves when the bookkeeping that runs after a response was handed over (marking a delivered body complete) has finished. Await it before a clean exit. */
  idle(): Promise<void>;
  /** The store in use, for inspecting saved payments. */
  readonly store: PaymentStore;
}
