import { createRandomWalk, type Prng, type ValueRange } from "../prng.js";

// One value per metricKey of the Janitza UMG 801 catalog entry
// (known-device-templates.ts). The current groups are taken from the
// catalog's own metric keys rather than listed here: the catalog renamed
// them once (module N -> current groups, 2026-10-09) and this generator kept
// producing the old keys, so every group but the base device's first one
// sat at 0 in the simulator.
export type JanitzaUmg801Values = Record<string, number>;

// Representative ranges, not device-specified limits - the UMG 801 itself
// has no intrinsic current range: that depends on which CT (current
// transformer) an installer wires to each channel. These look like a
// plausible industrial sub-panel: the base device's first group as the
// feed, the other groups as smaller outgoing circuits.
const VOLTAGE_RANGE: ValueRange = { min: 220, max: 240 };
const FEED_CURRENT_RANGE: ValueRange = { min: 0, max: 32 };
const CIRCUIT_CURRENT_RANGE: ValueRange = { min: 0, max: 10 };
// Inductive load throughout, so reactive power is positive. The manual
// allows either sign; a simulated panel does not need to switch.
const POWER_FACTOR_RANGE: ValueRange = { min: 0.75, max: 1.0 };
const FREQUENCY_RANGE: ValueRange = { min: 49.9, max: 50.1 };

const PHASES = [1, 2, 3] as const;
const GROUP_QUANTITIES = [
  "currentL1",
  "currentL2",
  "currentL3",
  "activePowerSum",
  "apparentPowerSum",
  "reactivePowerSum",
  "activeEnergySum",
] as const;

/**
 * The key prefix of every current group in `metricKeys`: "" for the base
 * device's first group (plain keys), "group2", "module1Group1", ... for the
 * rest - read off the keys that end in ActivePowerSum.
 */
export function janitzaUmg801GroupPrefixes(metricKeys: readonly string[]): string[] {
  return metricKeys.flatMap((key) => {
    if (key === "activePowerSum") return [""];
    const match = /^(.+)ActivePowerSum$/.exec(key);
    return match ? [match[1]!] : [];
  });
}

function groupKey(prefix: string, quantity: string): string {
  return prefix === "" ? quantity : `${prefix}${quantity.charAt(0).toUpperCase()}${quantity.slice(1)}`;
}

/**
 * Every power figure follows from voltage, current and power factor, the
 * way a meter measures them: per phase S = U * I, P = S * cos(phi),
 * Q = S * sin(phi), and the sums add the phases. Only current and power
 * factor wander at random. Before, apparent and active power were two
 * unrelated random walks (3.9 kVA next to 12.9 kW - impossible), and the
 * energy counter ran on its own as well (rising at about 21.6 kW against
 * 13.5 kW of mean power, which ferrion's meter-vs-power check then reported
 * as -26 %). The counter now integrates the active power over the tick.
 */
export function createJanitzaUmg801ValueGenerator(
  prng: Prng,
  { metricKeys, tickSeconds }: { metricKeys: readonly string[]; tickSeconds: number },
): () => JanitzaUmg801Values {
  const nextVoltage = PHASES.map(() => createRandomWalk(prng, VOLTAGE_RANGE));
  const nextFrequency = createRandomWalk(prng, FREQUENCY_RANGE);

  const groups = janitzaUmg801GroupPrefixes(metricKeys).map((prefix) => {
    const currentRange = prefix === "" ? FEED_CURRENT_RANGE : CIRCUIT_CURRENT_RANGE;
    return {
      prefix,
      nextCurrent: PHASES.map(() => createRandomWalk(prng, currentRange)),
      nextPowerFactor: PHASES.map(() => createRandomWalk(prng, POWER_FACTOR_RANGE)),
      // A lifetime meter reading, so it starts somewhere past zero.
      energyWh: prng() * 50_000,
    };
  });

  return function next(): JanitzaUmg801Values {
    const voltages = nextVoltage.map((walk) => walk());
    const values: JanitzaUmg801Values = {
      voltageL1N: voltages[0]!,
      voltageL2N: voltages[1]!,
      voltageL3N: voltages[2]!,
      frequency: nextFrequency(),
    };

    for (const group of groups) {
      let apparent = 0;
      let active = 0;
      let reactive = 0;
      PHASES.forEach((phase, index) => {
        const current = group.nextCurrent[index]!();
        const powerFactor = group.nextPowerFactor[index]!();
        const phaseApparent = voltages[index]! * current;
        apparent += phaseApparent;
        active += phaseApparent * powerFactor;
        reactive += phaseApparent * Math.sqrt(1 - powerFactor * powerFactor);
        values[groupKey(group.prefix, `currentL${phase}`)] = current;
        // Only the base device's first group publishes per-phase power
        // factors; for the others they stay internal.
        if (group.prefix === "") values[`powerFactorL${phase}`] = powerFactor;
      });
      group.energyWh += (active * tickSeconds) / 3600;
      values[groupKey(group.prefix, "apparentPowerSum")] = apparent;
      values[groupKey(group.prefix, "activePowerSum")] = active;
      values[groupKey(group.prefix, "reactivePowerSum")] = reactive;
      values[groupKey(group.prefix, "activeEnergySum")] = group.energyWh;
    }
    return values;
  };
}

/** Exported for the test: the quantities every current group carries. */
export const JANITZA_UMG801_GROUP_QUANTITIES = GROUP_QUANTITIES;
