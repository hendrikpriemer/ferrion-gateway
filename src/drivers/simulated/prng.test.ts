import { describe, expect, it } from "vitest";
import { createPrng, createRandomWalk } from "./prng.js";

describe("createPrng", () => {
  it("is deterministic for a given seed", () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const sequenceA = Array.from({ length: 20 }, () => a());
    const sequenceB = Array.from({ length: 20 }, () => b());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createPrng(1);
    const b = createPrng(2);
    expect(a()).not.toBe(b());
  });

  it("always returns a value in [0, 1)", () => {
    const prng = createPrng(7);
    for (let i = 0; i < 1000; i++) {
      const value = prng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("createRandomWalk", () => {
  it("never leaves the configured range", () => {
    const prng = createPrng(123);
    const next = createRandomWalk(prng, { min: -20, max: 60 });
    for (let i = 0; i < 1000; i++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(-20);
      expect(value).toBeLessThanOrEqual(60);
    }
  });

  it("is deterministic for a given seed", () => {
    const nextA = createRandomWalk(createPrng(99), { min: 0, max: 100 });
    const nextB = createRandomWalk(createPrng(99), { min: 0, max: 100 });
    const sequenceA = Array.from({ length: 30 }, () => nextA());
    const sequenceB = Array.from({ length: 30 }, () => nextB());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("drifts gradually rather than jumping across the whole range each tick", () => {
    const prng = createPrng(5);
    const next = createRandomWalk(prng, { min: 0, max: 100 }, 0.02);
    let previous = next();
    let maxJump = 0;
    for (let i = 0; i < 500; i++) {
      const value = next();
      maxJump = Math.max(maxJump, Math.abs(value - previous));
      previous = value;
    }
    expect(maxJump).toBeLessThanOrEqual(2);
  });
});
