import { createRandomWalk, type Prng, type ValueRange } from "../prng.js";

export interface Af2Values {
  massFlowRate: number;
  volumetricFlowRate: number;
  temperature: number;
  pressure: number;
}

// Real EURange values from the AF2's own OPC UA NodeSet2 export (see the
// plan's "Reale Wertebereiche für die Simulation" and
// device-catalog/known-device-templates.ts).
const TEMPERATURE_RANGE: ValueRange = { min: -20, max: 60 };
const PRESSURE_RANGE: ValueRange = { min: 0, max: 16 };

// No real measuring-range datasheet was available for these two metrics -
// the only AF2 documents on hand are a parameter/menu-structure guide and
// an AASX with no Technical Data submodel, and the NodeSet2's own EURange
// nodes for these two are unpopulated (Low=0, High=0). This is a plausible
// but NOT manual-verified placeholder range - replace if a real AF2
// datasheet with flow-rate specs becomes available.
const MASS_FLOW_RATE_RANGE: ValueRange = { min: 0, max: 50 };
const VOLUMETRIC_FLOW_RATE_RANGE: ValueRange = { min: 0, max: 40 };

export function createAf2ValueGenerator(prng: Prng): () => Af2Values {
  const nextTemperature = createRandomWalk(prng, TEMPERATURE_RANGE);
  const nextPressure = createRandomWalk(prng, PRESSURE_RANGE);
  const nextMassFlowRate = createRandomWalk(prng, MASS_FLOW_RATE_RANGE);
  const nextVolumetricFlowRate = createRandomWalk(prng, VOLUMETRIC_FLOW_RATE_RANGE);

  return function next(): Af2Values {
    return {
      temperature: nextTemperature(),
      pressure: nextPressure(),
      massFlowRate: nextMassFlowRate(),
      volumetricFlowRate: nextVolumetricFlowRate(),
    };
  };
}
