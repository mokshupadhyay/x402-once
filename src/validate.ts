import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import type { PaymentLimits } from './types.js';
import { InvalidRecordError, PaymentMismatchError } from './errors.js';
import type { PaymentRecord, PaymentStatus } from './types.js';

const STATUSES: readonly PaymentStatus[] = ['presented', 'settled', 'undelivered', 'expired', 'abandoned'];
/** The only headers a saved payment may carry. Anything else in a store would be sent to the seller verbatim. */
const ALLOWED_HEADERS = new Set(['payment-signature', 'x-payment', 'access-control-expose-headers']);

export const RECORD_SCHEMA = 1;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a record read back from a store before anything is done with it. A damaged, edited or half-written record
 * must stop the call, never be treated as "no payment on record", because that is how a second payment gets signed.
 */
export function validateRecord(intent: string, value: unknown): PaymentRecord {
  const fail = (reason: string): never => {
    throw new InvalidRecordError(intent, reason);
  };
  if (!isObject(value)) return fail('not an object');
  if (value['intent'] !== intent) fail('belongs to a different purchase');
  if (value['schema'] !== undefined && value['schema'] !== RECORD_SCHEMA) fail(`written by a newer version (schema ${String(value['schema'])})`);
  if (!STATUSES.includes(value['status'] as PaymentStatus)) fail(`unknown status ${JSON.stringify(value['status'])}`);
  for (const key of ['version', 'createdAt', 'updatedAt', 'presentations', 'expiresAt']) {
    if (!isFiniteNumber(value[key])) fail(`${key} is not a number`);
  }
  if (typeof value['explicit'] !== 'boolean') fail('explicit is not a boolean');
  if (!isObject(value['payload']) || !isObject(value['paymentRequired'])) fail('payload is missing');
  const payload = value['payload'] as Record<string, unknown>;
  if (!isObject(payload['accepted']) && value['status'] === 'presented') fail('payload.accepted is missing');
  const headers = value['headers'];
  if (!isObject(headers)) return fail('headers are missing');
  for (const [name, header] of Object.entries(headers as Record<string, unknown>)) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase())) fail(`unexpected saved header "${name}"`);
    if (typeof header !== 'string') fail(`header "${name}" is not text`);
    if ((header as string).length > 65_536 || /[\r\n\0]/.test(header as string)) fail(`header "${name}" is too long or contains control characters`);
  }
  return value as unknown as PaymentRecord;
}

const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isAtomic = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,78}$/.test(value);

/**
 * Defence in depth against a signer, hook or extension that produces something other than what was asked for. Before a
 * payment is saved or sent: what it claims to accept must be one of the seller's offers, and for an EVM authorization
 * the signed payee, amount and deadline must match what it claims. Anything else is refused.
 */
export function checkPayment(payload: PaymentPayload, required: PaymentRequired, limits?: PaymentLimits): void {
  const accepted = payload.accepted as unknown as Record<string, unknown> | undefined;
  if (!isObject(accepted)) throw new PaymentMismatchError('the payment names no accepted offer');
  const offers = Array.isArray(required.accepts) ? (required.accepts as unknown as Record<string, unknown>[]) : [];
  const offered = offers.some(
    (offer) =>
      offer?.['scheme'] === accepted['scheme'] &&
      offer?.['network'] === accepted['network'] &&
      sameText(offer?.['asset'], accepted['asset']) &&
      sameText(offer?.['payTo'], accepted['payTo']) &&
      String(offer?.['amount']) === String(accepted['amount']),
  );
  if (!offered) throw new PaymentMismatchError('the accepted offer is not one the seller made');

  if (limits?.networks && !limits.networks.includes(String(accepted['network']))) throw new PaymentMismatchError(`network ${String(accepted['network'])} is not in your limits`);
  if (limits?.assets && !limits.assets.some((a) => sameText(a, accepted['asset']))) throw new PaymentMismatchError(`asset ${String(accepted['asset'])} is not in your limits`);
  if (limits?.payTo && !limits.payTo.some((a) => sameText(a, accepted['payTo']))) throw new PaymentMismatchError(`payee ${String(accepted['payTo'])} is not in your limits`);
  if (limits?.maxAmount !== undefined) {
    if (!isAtomic(String(accepted['amount'])) || !isAtomic(limits.maxAmount) || BigInt(String(accepted['amount'])) > BigInt(limits.maxAmount)) {
      throw new PaymentMismatchError(`amount ${String(accepted['amount'])} is above your limit of ${limits.maxAmount}`);
    }
  }

  const inner = payload.payload as Record<string, unknown> | undefined;
  const authorization = isObject(inner) ? inner['authorization'] : undefined;
  if (authorization === undefined) return; // not an EIP-3009 payment: nothing more this package can check
  if (!isObject(authorization)) throw new PaymentMismatchError('the authorization is malformed');
  if (!sameText(authorization['to'], accepted['payTo'])) throw new PaymentMismatchError('the signed payee differs from the offer');
  if (!isAtomic(authorization['value']) || authorization['value'] !== String(accepted['amount'])) {
    throw new PaymentMismatchError('the signed amount differs from the offer');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(authorization['from']))) throw new PaymentMismatchError('the payer is not an address');
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorization['nonce']))) throw new PaymentMismatchError('the nonce is not 32 bytes');
  if (!isAtomic(authorization['validBefore']) || !isAtomic(authorization['validAfter'])) throw new PaymentMismatchError('the validity window is malformed');
}
