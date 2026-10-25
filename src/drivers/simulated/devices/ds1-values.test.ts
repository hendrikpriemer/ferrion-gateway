import { describe, expect, it } from "vitest";
import { createPrng } from "../prng.js";
import { createDs1ValueGenerator } from "./ds1-values.js";
import { relativeHumidityPercent } from "./psychrometrics.js";

describe("createDs1ValueGenerator", () => {
  it("keeps every metric within its documented range", () => {
    const next = createDs1ValueGenerator(createPrng(1));
    for (let i = 0; i < 500; i++) {
      const values = next();
      expect(values.temperature).toBeGreaterThanOrEqual(-20);
      expect(values.temperature).toBeLessThanOrEqual(70);
      expect(values.relativeHumidity).toBeGreaterThanOrEqual(0);
      expect(values.relativeHumidity).toBeLessThanOrEqual(100);
      expect(values.dewPoint).toBeGreaterThanOrEqual(-80);
      expect(values.dewPoint).toBeLessThanOrEqual(20);
    }
  });

  it("is deterministic for a given seed", () => {
    const nextA = createDs1ValueGenerator(createPrng(55));
    const nextB = createDs1ValueGenerator(createPrng(55));
    for (let i = 0; i < 10; i++) {
      expect(nextA()).toEqual(nextB());
    }
  });

  it("reports a physically consistent set, not eight independent walks", () => {
    // The defect this replaced: temperature, humidity and dew point were
    // walked separately, so the device emitted triples no real sensor can
    // produce. Every derived figure now follows from the two measured ones.
    const next = createDs1ValueGenerator(createPrng(7));

    for (let i = 0; i < 200; i++) {
      const v = next();
      expect(v.relativeHumidity).toBeCloseTo(
        relativeHumidityPercent(v.temperature, v.dewPoint),
        6
      );
    }
  });

  it("never lets the dew point exceed the gas temperature", () => {
    // Air at a dew point above its own temperature has already condensed -
    // two independent walks crossed that line regularly.
    //
    // Seed 9 on purpose: measured, the unclamped walks cross on 735 of 2000
    // steps with it, while seed 3 never crosses at all. The first version of
    // this test used 3 and stayed green with the cap removed - it asserted
    // nothing.
    const next = createDs1ValueGenerator(createPrng(9));

    for (let i = 0; i < 500; i++) {
      const v = next();
      expect(v.dewPoint).toBeLessThanOrEqual(v.temperature);
    }
  });

  it("reports every metric the device catalog lists for a DS1", () => {
    // Five of them had no simulated source at all, so a data source created
    // for them in the platform would simply never receive a reading.
    const v = createDs1ValueGenerator(createPrng(9))();

    for (const key of [
      "temperature",
      "relativeHumidity",
      "dewPoint",
      "absoluteHumidity",
      "moistureContent",
      "vaporRatio",
      "waterVaporPartialPressure",
      "atmosphericDewPoint",
    ] as const) {
      expect(Number.isFinite(v[key])).toBe(true);
    }
  });

  it("keeps the pressure-invariant moisture content positive and ordered", () => {
    const next = createDs1ValueGenerator(createPrng(11));
    let previous: { dewPoint: number; moistureContent: number } | null = null;

    for (let i = 0; i < 200; i++) {
      const v = next();
      expect(v.moistureContent).toBeGreaterThan(0);
      if (previous && v.dewPoint > previous.dewPoint) {
        expect(v.moistureContent).toBeGreaterThan(previous.moistureContent);
      }
      previous = v;
    }
  });
});
