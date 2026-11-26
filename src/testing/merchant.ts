import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { type Fault, type FaultPlan } from './faults.js';

export interface Settlement {
  /** The URL the buyer asked for. */
  resource: string;
  nonce: string;
  payer: string;
  amount: string;
  transaction: string;
  at: number;
}

export interface SimulatedMerchantOptions {
  /** Atomic units charged per purchase. Default 10000 (0.01 USDC with 6 decimals). */
  amount?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  faults?: FaultPlan;
  /**
   * What the seller does with a payment whose nonce already settled.
   * `false` (default) behaves like the token contract: the second settlement reverts, so the seller answers 402.
   * `true` models a seller that recognises the repeat and delivers the resource again.
   */
  serveOnReplay?: boolean;
  /** Real milliseconds each request takes, so calls started together overlap like they do over a network. Default 0. */
  latencyMs?: number;
  now?: () => number;
}

/**
 * A seller and its facilitator in one in-process `fetch`. It counts what matters for double charges: how many
 * distinct authorizations settled. No network, no clock waits, no wallet.
 */
export function createSimulatedMerchant(options: SimulatedMerchantOptions = {}) {
  const amount = options.amount ?? '10000';
  const network = options.network ?? 'eip155:84532';
  const asset = options.asset ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const payTo = options.payTo ?? '0x2222222222222222222222222222222222222222';
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? 60;
  const plan: FaultPlan = options.faults ?? (() => 'none');
  const now = options.now ?? Date.now;

  const settled = new Map<string, Settlement>();
  const settlements: Settlement[] = [];
  let paymentRequests = 0;
  let unpaidRequests = 0;

  const paymentRequired = (url: string): PaymentRequired => ({
    x402Version: 2,
    resource: { url },
    accepts: [
      { scheme: 'exact', network: network as `${string}:${string}`, asset, amount, payTo, maxTimeoutSeconds, extra: { name: 'USDC', version: '2' } },
    ],
  });

  const fresh402 = (url: string) =>
    new Response(JSON.stringify(paymentRequired(url)), {
      status: 402,
      headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired(url)) },
    });

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (!header) {
      unpaidRequests++;
      return fresh402(request.url);
    }

    const index = paymentRequests++;
    const fault: Fault = plan(index);
    if (fault === 'drop-before-settle') throw new TypeError('fetch failed');
    if (fault === 'error-before-settle') return new Response('upstream error', { status: 503 });

    let result: Response;
    try {
      const decoded = decodePaymentSignatureHeader(header);
      const auth = decoded.payload['authorization'] as { from: string; nonce: string; validBefore: string };
      if (now() > Number(auth.validBefore) * 1000) {
        result = new Response(JSON.stringify({ error: 'authorization_expired' }), { status: 402 });
      } else if (settled.has(auth.nonce)) {
        const earlier = settled.get(auth.nonce)!;
        result = options.serveOnReplay
          ? delivered(earlier)
          : new Response(JSON.stringify({ error: 'authorization_already_used' }), { status: 402 });
      } else {
        const settlement: Settlement = {
          resource: request.url,
          nonce: auth.nonce,
          payer: auth.from,
          amount,
          transaction: '0x' + (settlements.length + 1).toString(16).padStart(64, '0'),
          at: now(),
        };
        settled.set(auth.nonce, settlement);
        settlements.push(settlement);
        result = delivered(settlement);
      }
    } catch {
      return new Response('bad payment header', { status: 400 });
    }

    if (fault === 'drop-after-settle') throw new TypeError('fetch failed');
    if (fault === 'error-after-settle') return new Response('upstream error', { status: 503 });
    if (fault === 'fresh-402-after-settle') return fresh402(request.url);
    return result;
  };

  function delivered(settlement: Settlement): Response {
    return new Response(JSON.stringify({ paid: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true,
          transaction: settlement.transaction,
          network: network as `${string}:${string}`,
          payer: settlement.payer,
        }),
      },
    });
  }

  return {
    fetch: fetchImpl,
    /** Every payment that actually settled, in order. */
    settlements,
    /** True when this authorization nonce settled. Lets a test build a resolver that knows the truth. */
    hasSettled: (nonce: string) => settled.has(nonce),
    /** Distinct authorizations that settled. More than the number of purchases means someone was charged twice. */
    get settlementCount() {
      return settlements.length;
    },
    get paymentRequests() {
      return paymentRequests;
    },
    get unpaidRequests() {
      return unpaidRequests;
    },
    /** Total moved, in atomic units. */
    get totalSettled() {
      return settlements.reduce((sum, s) => sum + BigInt(s.amount), 0n);
    },
  };
}

export type SimulatedMerchant = ReturnType<typeof createSimulatedMerchant>;
