import { describe, expect, it } from "vitest";
import { getDeviceTemplate } from "../../../device-catalog/known-device-templates.js";
import { createPrng } from "../prng.js";
import {
  JANITZA_UMG801_GROUP_QUANTITIES,
  createJanitzaUmg801ValueGenerator,
  janitzaUmg801GroupPrefixes,
} from "./janitza-umg801-values.js";

const TEMPLATES = ["janitza-umg801-opcua", "janitza-umg801-modbus-tcp"] as const;
const metricKeys = getDeviceTemplate("janitza-umg801-opcua").metrics.map((metric) => metric.metricKey);
const TICK_SECONDS = 2;

function generator(seed = 1) {
  return createJanitzaUmg801ValueGenerator(createPrng(seed), { metricKeys, tickSeconds: TICK_SECONDS });
}

function key(prefix: string, quantity: string): string {
  return prefix === "" ? quantity : `${prefix}${quantity.charAt(0).toUpperCase()}${quantity.slice(1)}`;
}

describe("createJanitzaUmg801ValueGenerator", () => {
  it.each(TEMPLATES)("produces a number for every metric of %s", (templateId) => {
    // The catalog renamed its groups once and the simulator kept the old
    // keys - every group but the first then sat at 0 without anyone noticing.
    const keys = getDeviceTemplate(templateId).metrics.map((metric) => metric.metricKey);
    const values = createJanitzaUmg801ValueGenerator(createPrng(3), { metricKeys: keys, tickSeconds: 2 })();
    const missing = keys.filter((metricKey) => typeof values[metricKey] !== "number");
    expect(missing).toEqual([]);
  });

  it("finds the base group, the base device's extra groups and the module groups", () => {
    const prefixes = janitzaUmg801GroupPrefixes(metricKeys);
    expect(prefixes).toContain("");
    expect(prefixes).toContain("group2");
    expect(prefixes).toContain("module1Group1");
    expect(prefixes.length).toBeGreaterThan(3);
    for (const prefix of prefixes) {
      for (const quantity of JANITZA_UMG801_GROUP_QUANTITIES) {
        expect(metricKeys).toContain(key(prefix, quantity));
      }
    }
  });

  it("keeps apparent, active and reactive power of every group physically consistent", () => {
    const next = generator(7);
    const prefixes = janitzaUmg801GroupPrefixes(metricKeys);
    for (let tick = 0; tick < 200; tick++) {
      const values = next();
      for (const prefix of prefixes) {
        const apparent = values[key(prefix, "apparentPowerSum")]!;
        const active = values[key(prefix, "activePowerSum")]!;
        const reactive = values[key(prefix, "reactivePowerSum")]!;
        // Phase sums of S are at least the vector sum of P and Q, and P
        // never exceeds S - the 3.9 kVA next to 12.9 kW case is excluded.
        expect(active).toBeGreaterThanOrEqual(0);
        expect(active).toBeLessThanOrEqual(apparent + 1e-9);
        expect(Math.hypot(active, reactive)).toBeLessThanOrEqual(apparent + 1e-6);
        // S is what the voltages and currents say it is.
        const fromPhases =
          values.voltageL1N! * values[key(prefix, "currentL1")]! +
          values.voltageL2N! * values[key(prefix, "currentL2")]! +
          values.voltageL3N! * values[key(prefix, "currentL3")]!;
        expect(apparent).toBeCloseTo(fromPhases, 6);
      }
    }
  });

  it("publishes the base group's power factors as P/S per phase", () => {
    const values = generator(11)();
    const phaseApparent = [1, 2, 3].map((phase) => values[`voltageL${phase}N`]! * values[`currentL${phase}`]!);
    const activeFromFactors = phaseApparent.reduce(
      (sum, apparent, index) => sum + apparent * values[`powerFactorL${index + 1}`]!,
      0,
    );
    expect(values.activePowerSum).toBeCloseTo(activeFromFactors, 6);
  });

  it("advances every energy counter by exactly the active power over the tick", () => {
    // ferrion compares the meter against the integrated power; on the old
    // simulator that check reported -26 %.
    const next = generator(5);
    const prefixes = janitzaUmg801GroupPrefixes(metricKeys);
    let previous = next();
    for (let tick = 0; tick < 100; tick++) {
      const values = next();
      for (const prefix of prefixes) {
        const step = values[key(prefix, "activeEnergySum")]! - previous[key(prefix, "activeEnergySum")]!;
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeCloseTo((values[key(prefix, "activePowerSum")]! * TICK_SECONDS) / 3600, 9);
      }
      previous = values;
    }
  });

  it("keeps currents, voltages, power factors and frequency in their ranges", () => {
    const next = generator(13);
    for (let tick = 0; tick < 300; tick++) {
      const values = next();
      for (const phase of [1, 2, 3]) {
        expect(values[`voltageL${phase}N`]).toBeGreaterThanOrEqual(220);
        expect(values[`voltageL${phase}N`]).toBeLessThanOrEqual(240);
        expect(values[`currentL${phase}`]).toBeGreaterThanOrEqual(0);
        expect(values[`currentL${phase}`]).toBeLessThanOrEqual(32);
        expect(values[`module1Group1CurrentL${phase}`]).toBeLessThanOrEqual(10);
        expect(values[`powerFactorL${phase}`]).toBeGreaterThanOrEqual(0.75);
        expect(values[`powerFactorL${phase}`]).toBeLessThanOrEqual(1);
      }
      expect(values.frequency).toBeGreaterThanOrEqual(49.9);
      expect(values.frequency).toBeLessThanOrEqual(50.1);
    }
  });

  it("is deterministic for a given seed", () => {
    const nextA = generator(55);
    const nextB = generator(55);
    for (let tick = 0; tick < 10; tick++) {
      expect(nextA()).toEqual(nextB());
    }
  });
});
