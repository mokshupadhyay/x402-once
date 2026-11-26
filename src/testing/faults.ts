/**
 * What goes wrong at the seller when a payment arrives.
 *
 * - `none`: nothing.
 * - `drop-before-settle` / `error-before-settle`: the connection dies, or a 5xx comes back, before anything settles.
 * - `drop-after-settle` / `error-after-settle`: the payment settles, then the response is lost, or a 5xx replaces it.
 * - `fresh-402-after-settle`: the payment settles, then the seller answers a brand new 402 as if nothing was paid.
 *   This is the seller-side defect that makes a client sign a second payment.
 */
export type Fault =
  | 'none'
  | 'drop-before-settle'
  | 'error-before-settle'
  | 'drop-after-settle'
  | 'error-after-settle'
  | 'fresh-402-after-settle';

export const FAULTS: readonly Fault[] = [
  'none',
  'drop-before-settle',
  'error-before-settle',
  'drop-after-settle',
  'error-after-settle',
  'fresh-402-after-settle',
];

/** Picks the fault for the n-th payment request the seller receives (n starts at 0). */
export type FaultPlan = (paymentRequestIndex: number) => Fault;

/** A fixed list of faults, then `none` for every request after the list ends. */
export function scriptedFaults(...sequence: Fault[]): FaultPlan {
  return (index) => sequence[index] ?? 'none';
}

/** Small, fast, deterministic random numbers (mulberry32). The same seed always gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random faults with the given chances, the same every time for one seed.
 * Chances are weights, not percentages; whatever is left over becomes `none`.
 */
export function randomFaults(seed: number, weights: Partial<Record<Fault, number>>): FaultPlan {
  const random = seededRandom(seed);
  const entries = FAULTS.filter((f) => f !== 'none').map((f) => [f, weights[f] ?? 0] as const);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  const noneWeight = Math.max(0, 1 - total);
  const cache: Fault[] = [];
  return (index) => {
    while (cache.length <= index) {
      let roll = random() * (total + noneWeight);
      let picked: Fault = 'none';
      for (const [fault, weight] of entries) {
        if (roll < weight) {
          picked = fault;
          break;
        }
        roll -= weight;
      }
      cache.push(picked);
    }
    return cache[index] ?? 'none';
  };
}
