import { describe, expect, it } from "vitest";
import { createPrng } from "../prng.js";
import { createAf2ValueGenerator } from "./af2-values.js";

describe("createAf2ValueGenerator", () => {
  it("keeps every metric within its documented range", () => {
    const next = createAf2ValueGenerator(createPrng(1));
    for (let i = 0; i < 500; i++) {
      const values = next();
      expect(values.temperature).toBeGreaterThanOrEqual(-20);
      expect(values.temperature).toBeLessThanOrEqual(60);
      expect(values.pressure).toBeGreaterThanOrEqual(0);
      expect(values.pressure).toBeLessThanOrEqual(16);
      expect(values.massFlowRate).toBeGreaterThanOrEqual(0);
      expect(values.massFlowRate).toBeLessThanOrEqual(50);
      expect(values.volumetricFlowRate).toBeGreaterThanOrEqual(0);
      expect(values.volumetricFlowRate).toBeLessThanOrEqual(40);
    }
  });

  it("is deterministic for a given seed", () => {
    const nextA = createAf2ValueGenerator(createPrng(55));
    const nextB = createAf2ValueGenerator(createPrng(55));
    for (let i = 0; i < 10; i++) {
      expect(nextA()).toEqual(nextB());
    }
  });
});
