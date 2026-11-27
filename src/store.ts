import type { CompareAndSetResult, PaymentRecord, PaymentStore } from './types.js';

export interface MemoryPaymentStoreOptions {
  /**
   * How many finished purchases (settled, expired, abandoned) to remember before the oldest are dropped. Open
   * purchases (`presented`, `undelivered`) are never dropped. Default 1000.
   */
  maxFinishedRecords?: number;
}

const FINISHED = new Set(['settled', 'expired', 'abandoned']);

/** Keeps records in memory. Covers retries inside one process; a restart forgets everything. */
export class MemoryPaymentStore implements PaymentStore {
  private readonly records = new Map<string, PaymentRecord>();
  private readonly maxFinished: number;

  constructor(options: MemoryPaymentStoreOptions = {}) {
    this.maxFinished = options.maxFinishedRecords ?? 1000;
  }

  /** Keeps a long-running process from growing without bound. Oldest finished records go first. */
  private prune(): void {
    let finished = 0;
    for (const record of this.records.values()) if (FINISHED.has(record.status)) finished++;
    for (const [intent, record] of this.records) {
      if (finished <= this.maxFinished) break;
      if (FINISHED.has(record.status)) {
        this.records.delete(intent);
        finished--;
      }
    }
  }

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
    this.records.delete(intent); // re-insert so iteration order follows last update: the oldest finished go first
    this.records.set(intent, structuredClone(next));
    this.prune();
    return { ok: true };
  }

  async delete(intent: string): Promise<void> {
    this.records.delete(intent);
  }
}
