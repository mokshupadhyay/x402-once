import type { CompareAndSetResult, PaymentRecord, PaymentStore } from './types.js';

/** Keeps records in memory. Covers retries inside one process; a restart forgets everything. */
export class MemoryPaymentStore implements PaymentStore {
  private readonly records = new Map<string, PaymentRecord>();

  async get(intent: string): Promise<PaymentRecord | undefined> {
    const record = this.records.get(intent);
    return record ? structuredClone(record) : undefined;
  }

  async compareAndSet(intent: string, expectedVersion: number, next: PaymentRecord): Promise<CompareAndSetResult> {
    const current = this.records.get(intent);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) {
      return { ok: false, current: current ? structuredClone(current) : undefined };
    }
    this.records.set(intent, structuredClone(next));
    return { ok: true };
  }

  async delete(intent: string): Promise<void> {
    this.records.delete(intent);
  }
}
