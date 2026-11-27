import type { PaymentRecord } from './types.js';

/** A saved payment may or may not have settled, and nothing available can tell. No new payment was signed. */
export class UnresolvedPaymentError extends Error {
  readonly record: PaymentRecord;
  constructor(record: PaymentRecord, reason: string) {
    super(`Payment for "${record.intent}" is unresolved: ${reason}. No new payment was signed.`);
    this.name = 'UnresolvedPaymentError';
    this.record = record;
  }
}

/** The payment settled, but this client never received the resource. Ask the seller to deliver it or refund; do not pay again. */
export class SettledWithoutDeliveryError extends Error {
  readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(
      `Payment for "${record.intent}" settled${record.settle ? ` (${record.settle.transaction})` : ''} but the resource was not delivered to this client.`,
    );
    this.name = 'SettledWithoutDeliveryError';
    this.record = record;
  }
}

/** The caller used an explicit key that already has a settled payment. */
export class AlreadySettledError extends Error {
  readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(`"${record.intent}" was already paid. Use a new key for a new purchase.`);
    this.name = 'AlreadySettledError';
    this.record = record;
  }
}

export class TooManyPresentationsError extends Error {
  readonly record: PaymentRecord;
  constructor(record: PaymentRecord, max: number) {
    super(`The signed payment for "${record.intent}" was already sent ${max} times.`);
    this.name = 'TooManyPresentationsError';
    this.record = record;
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
  readonly record: PaymentRecord;
  constructor(record: PaymentRecord) {
    super(`"${record.intent}" was paid and delivered by another process while this call was waiting. No new payment was signed.`);
    this.name = 'PurchaseSettledElsewhereError';
    this.record = record;
  }
}
