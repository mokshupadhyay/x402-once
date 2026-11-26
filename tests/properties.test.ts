import { wrapFetchWithPayment } from '@x402/fetch';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPaidFetch, MemoryPaymentStore, type PaymentRecord, type SettlementResolver } from '../src/index.js';
import { createFakeClient, createSimulatedMerchant, FAULTS, scriptedFaults, type Fault } from '../src/testing/index.js';
import { createClock } from './helpers.js';

/**
 * A random "afternoon of an unreliable app": it asks for up to three purchases over and over, in any order, while
 * the clock moves and the seller misbehaves. The property is about money: no purchase is ever paid for twice.
 */
interface Program {
  faults: Fault[];
  serveOnReplay: boolean;
  steps: { purchase: number; advanceMs: number }[];
}

const programs: fc.Arbitrary<Program> = fc.record({
  faults: fc.array(fc.constantFrom(...FAULTS), { maxLength: 8 }),
  serveOnReplay: fc.boolean(),
  steps: fc.array(
    fc.record({
      purchase: fc.integer({ min: 0, max: 2 }),
      advanceMs: fc.constantFrom(0, 0, 500, 5_000, 30_000, 65_000, 100_000, 400_000),
    }),
    { minLength: 1, maxLength: 14 },
  ),
});

const urlOf = (purchase: number) => `https://seller.test/p/${purchase}`;

function nonceOf(record: PaymentRecord): string {
  return (record.payload.payload['authorization'] as { nonce: string }).nonce;
}

async function runProgram(program: Program, kind: 'once' | 'stock') {
  const clock = createClock();
  const merchant = createSimulatedMerchant({ now: clock.now, faults: scriptedFaults(...program.faults), serveOnReplay: program.serveOnReplay });
  const client = createFakeClient('eip155:84532', { now: clock.now });
  let signed = 0;

  // A resolver that knows the truth, like asking the token contract.
  const truthful: SettlementResolver = async (record) => (merchant.hasSettled(nonceOf(record)) ? 'settled' : 'unsettled');

  const fetchFn =
    kind === 'once'
      ? createPaidFetch({
          client,
          fetch: merchant.fetch,
          store: new MemoryPaymentStore(),
          now: clock.now,
          resolver: truthful,
          maxPresentations: 1000,
          onEvent: (e) => {
            if (e.type === 'signed') signed++;
          },
        })
      : wrapFetchWithPayment(merchant.fetch, client);

  // The app retries a purchase until it is delivered, then stops asking for that purchase.
  const delivered = new Set<number>();
  for (const step of program.steps) {
    clock.advance(step.advanceMs);
    if (delivered.has(step.purchase)) continue;
    try {
      const response = await fetchFn(urlOf(step.purchase));
      await response.arrayBuffer();
      if (response.status === 200) delivered.add(step.purchase);
    } catch {
      // network errors and refusals are exactly what the app has to live with
    }
  }
  return { merchant, signed };
}

/** The most any single purchase was paid. 1 is correct; 2 or more is a double charge. */
function worstCharge(merchant: ReturnType<typeof createSimulatedMerchant>): number {
  const counts = new Map<string, number>();
  for (const s of merchant.settlements) counts.set(s.resource, (counts.get(s.resource) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

describe('property: no purchase is ever paid for twice', () => {
  it('holds for x402-once under random faults, clock jumps and retries', async () => {
    await fc.assert(
      fc.asyncProperty(programs, async (program) => {
        const { merchant } = await runProgram(program, 'once');
        expect(worstCharge(merchant)).toBeLessThanOrEqual(1);
      }),
      { numRuns: Number(process.env['RUNS'] ?? 600) },
    );
  });

  it('does NOT hold for the stock @x402/fetch wrapper: fast-check finds a double charge', async () => {
    let doubleCharged: Program | undefined;
    const outcome = await fc.check(
      fc.asyncProperty(programs, async (program) => {
        const { merchant } = await runProgram(program, 'stock');
        if (worstCharge(merchant) > 1) doubleCharged = program;
        return worstCharge(merchant) <= 1;
      }),
      { numRuns: Number(process.env['RUNS'] ?? 600) },
    );
    expect(outcome.failed).toBe(true);
    expect(doubleCharged).toBeDefined();
  });
});

describe('property: a valid payment is never signed twice', () => {
  it('with no clock movement, each purchase is signed exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(programs, async (program) => {
        const still: Program = { ...program, steps: program.steps.map((s) => ({ ...s, advanceMs: 0 })) };
        const { signed, merchant } = await runProgram(still, 'once');
        const purchases = new Set(still.steps.map((s) => s.purchase)).size;
        // Every purchase starts with a 402 and is signed once. Every retry sends that same saved payment.
        expect(signed).toBe(purchases);
        expect(worstCharge(merchant)).toBeLessThanOrEqual(1);
      }),
      { numRuns: Number(process.env['RUNS'] ?? 400) },
    );
  });
});
