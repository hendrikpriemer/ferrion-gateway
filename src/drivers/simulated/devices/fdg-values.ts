import { createRandomWalk, type Prng, type ValueRange } from "../prng.js";

export interface FdgValues {
  volumetricFlowRate: number;
}

// Real "8-1 Spezifikationen" measuring range for the FD-G50 (Durchflussbereich
// (typisch) für die momentane Durchflussrate, m³/h column) - see the plan's
// device-catalog entry comment. The FD-G family's other sizes (FD-G25/80/
// 125/200) range up to 1800 m³/h depending on pipe size, but this catalog
// entry isn't split per model size (like DS1/AF2 aren't either), so FD-G50 -
// a common mid-size installation - stands in as the representative range.
const VOLUMETRIC_FLOW_RATE_RANGE: ValueRange = { min: 0, max: 32 };

export function createFdgValueGenerator(prng: Prng): () => FdgValues {
  const nextVolumetricFlowRate = createRandomWalk(prng, VOLUMETRIC_FLOW_RATE_RANGE);

  return function next(): FdgValues {
    return {
      volumetricFlowRate: nextVolumetricFlowRate(),
    };
  };
}
