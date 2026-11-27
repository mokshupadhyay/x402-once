import type { PaymentRecord } from './types.js';

/**
 * The record holds a signed payment, which is a bearer instrument until it expires. Keep it off the enumerable
 * surface so logging an error (JSON.stringify, util.inspect, Sentry) never prints it. It is still `error.record`.
 */
function attachRecord(error: Error, record: PaymentRecord): void {
  Object.defineProperty(error, 'record', { value: record, enumerable: false, writable: false });
}

/** A saved payment may or may not have settled, and nothing available can tell. No new payment was signed. */
export class UnresolvedPaymentError extends Error {
  declare readonly record: PaymentRecord;
  constructor(record: PaymentRecord, reason: string) {
    super(`Payment for "${record.intent}" is unresolved: ${reason}. No new payment was signed.`);
    this.name = 'UnresolvedPaymentError';
    attachRecord(this, record);
  }
}

/** The payment settled, but this client never received the resource. Ask the seller to deliver it or refund; do not pay again. */
export class SettledWithoutDeliveryError extends Error {
  declare readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(
      `Payment for "${record.intent}" settled${record.settle ? ` (${record.settle.transaction})` : ''} but the resource was not delivered to this client.`,
    );
    this.name = 'SettledWithoutDeliveryError';
    attachRecord(this, record);
  }
}

/** The caller used an explicit key that already has a settled payment. */
export class AlreadySettledError extends Error {
  declare readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(`"${record.intent}" was already paid. Use a new key for a new purchase.`);
    this.name = 'AlreadySettledError';
    attachRecord(this, record);
  }
}

export class TooManyPresentationsError extends Error {
  declare readonly record: PaymentRecord;
  constructor(record: PaymentRecord, max: number) {
    super(`The signed payment for "${record.intent}" was already sent ${max} times.`);
    this.name = 'TooManyPresentationsError';
    attachRecord(this, record);
  }
}

export class StoreConflictError extends Error {
  constructor(intent: string) {
    super(`Could not save the payment for "${intent}": the store kept changing under us.`);
    this.name = 'StoreConflictError';
  }
}

/** Internal: the stored record changed since we read it. Never reaches the caller. */
export class StaleRecordError extends Error {
  constructor(intent: string) {
    super(`The saved payment for "${intent}" changed while we were working on it.`);
    this.name = 'StaleRecordError';
  }
}

/**
 * Another process finished this same purchase while this call was waiting. The resource went to that process, not this
 * one, and signing a new payment here would pay twice. Nothing was charged by this call.
 */
export class PurchaseSettledElsewhereError extends Error {
  declare readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(`"${record.intent}" was paid and delivered by another process while this call was waiting. No new payment was signed.`);
    this.name = 'PurchaseSettledElsewhereError';
    attachRecord(this, record);
  }
}

/** A saved record is damaged or was edited. Nothing was sent and no new payment was signed: fix or remove the record. */
export class InvalidRecordError extends Error {
  constructor(intent: string, reason: string) {
    super(`The saved payment for "${intent}" is not valid (${reason}). Nothing was sent and no new payment was signed.`);
    this.name = 'InvalidRecordError';
  }
}

/** The seller asked for a payment that stays valid longer than `maxValidityMs`. It was not saved or sent. */
export class ValidityTooLongError extends Error {
  constructor(seconds: number, limitMs: number) {
    super(`The seller's payment would stay valid for ${seconds} s, longer than the allowed ${Math.round(limitMs / 1000)} s. It was not sent.`);
    this.name = 'ValidityTooLongError';
  }
}

/** The paid request was redirected somewhere the signed payment must not follow. The payment stays saved; nothing leaked. */
export class UnsafeRedirectError extends Error {
  constructor(from: string, to: string) {
    super(`After payment, ${from} redirected to ${to}. The signed payment was not sent there.`);
    this.name = 'UnsafeRedirectError';
  }
}
