import { InvalidRecordError } from './errors.js';
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
  }
  return value as unknown as PaymentRecord;
}
