export type Prng = () => number;

// mulberry32 - small, fast, seedable, good enough statistical quality for
// simulated sensor noise (not cryptographic use). Deterministic for a given
// seed, so device value generators stay unit-testable.
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return function mulberry32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ValueRange {
  min: number;
  max: number;
}

// A value that drifts by small random steps within [min, max] rather than
// jumping randomly on every tick - more realistic-looking sensor noise, and
// clamped so it never leaves the configured range.
export function createRandomWalk(prng: Prng, range: ValueRange, stepFraction = 0.02): () => number {
  const span = range.max - range.min;
  const maxStep = span * stepFraction;
  let value = range.min + prng() * span;
  return function next(): number {
    const delta = (prng() * 2 - 1) * maxStep;
    value = Math.min(range.max, Math.max(range.min, value + delta));
    return value;
  };
}
