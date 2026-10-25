import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATMOSPHERIC_PRESSURE_HPA,
  absoluteHumidityGramsPerM3,
  atmosphericDewPointC,
  dewPointFromVapourPressure,
  moistureContentGramsPerKg,
  relativeHumidityPercent,
  saturationVapourPressureHpa,
  vapourRatioPpm,
} from "./psychrometrics.js";

const LINE_PRESSURE_HPA = 8000; // ~7 bar(g)

describe("saturationVapourPressureHpa", () => {
  it("matches the textbook value at 0 degC", () => {
    expect(saturationVapourPressureHpa(0)).toBeCloseTo(6.11, 2);
  });

  it("matches the textbook value at 20 degC", () => {
    // Tables give 23.37-23.39 depending on the formulation; Magnus-Sonntag
    // lands at 23.33. Asserted to 0.5 % rather than two decimals, because a
    // tighter bound would be asserting the choice of coefficients rather
    // than that the physics is right.
    expect(saturationVapourPressureHpa(20)).toBeCloseTo(23.37, 0);
    expect(Math.abs(saturationVapourPressureHpa(20) - 23.37) / 23.37).toBeLessThan(0.005);
  });

  it("rises monotonically", () => {
    expect(saturationVapourPressureHpa(-40)).toBeLessThan(saturationVapourPressureHpa(-20));
    expect(saturationVapourPressureHpa(-20)).toBeLessThan(saturationVapourPressureHpa(0));
  });
});

describe("dewPointFromVapourPressure", () => {
  it("inverts the saturation curve", () => {
    for (const celsius of [-70, -40, -20, 0, 15, 40]) {
      expect(dewPointFromVapourPressure(saturationVapourPressureHpa(celsius))).toBeCloseTo(celsius, 6);
    }
  });
});

describe("relativeHumidityPercent", () => {
  it("is 100 % when the dew point equals the temperature", () => {
    // Saturated air, by definition - the one anchor the whole relation hangs on.
    expect(relativeHumidityPercent(25, 25)).toBeCloseTo(100, 6);
  });

  it("reproduces the figure the old simulation contradicted", () => {
    // Live-observed simulated triple: 54.78 degC with a -27.29 degCtd dew
    // point. It reported 3.56 % relative humidity; the physics says 0.42 %.
    // The three used to be independent random walks.
    expect(relativeHumidityPercent(54.78, -27.29)).toBeCloseTo(0.42, 2);
  });

  it("falls as the air gets drier at a fixed temperature", () => {
    expect(relativeHumidityPercent(30, -20)).toBeLessThan(relativeHumidityPercent(30, 0));
  });
});

describe("moistureContentGramsPerKg", () => {
  it("does not change with pressure for the same AIR", () => {
    // The property the whole network-comparison idea rests on: expanding the
    // gas lowers its dew point but carries the same water per kg of dry air.
    const atSevenBar = moistureContentGramsPerKg(-20, LINE_PRESSURE_HPA);
    const expandedDewPoint = atmosphericDewPointC(-20, LINE_PRESSURE_HPA);
    const atAtmospheric = moistureContentGramsPerKg(expandedDewPoint, ATMOSPHERIC_PRESSURE_HPA);

    expect(atAtmospheric).toBeCloseTo(atSevenBar, 6);
  });

  it("rises with the dew point", () => {
    expect(moistureContentGramsPerKg(-40, LINE_PRESSURE_HPA)).toBeLessThan(
      moistureContentGramsPerKg(-20, LINE_PRESSURE_HPA)
    );
  });
});

describe("atmosphericDewPointC", () => {
  it("is lower than the pressure dew point", () => {
    // Expanding the gas spreads the same water over more volume.
    expect(atmosphericDewPointC(-20, LINE_PRESSURE_HPA)).toBeLessThan(-20);
  });

  it("equals the pressure dew point at atmospheric pressure", () => {
    expect(atmosphericDewPointC(-20, ATMOSPHERIC_PRESSURE_HPA)).toBeCloseTo(-20, 6);
  });
});

describe("vapourRatioPpm and absoluteHumidityGramsPerM3", () => {
  it("relate ppm to the pressure ratio", () => {
    expect(vapourRatioPpm(-20, LINE_PRESSURE_HPA)).toBeCloseTo(
      (saturationVapourPressureHpa(-20) / LINE_PRESSURE_HPA) * 1e6,
      6
    );
  });

  it("gives a plausible absolute humidity for saturated room air", () => {
    // Saturated air at 20 degC holds ~17.3 g/m³ - a value any HVAC table
    // lists. Same 0.5 % bound and same reason as the vapour-pressure test.
    expect(Math.abs(absoluteHumidityGramsPerM3(20, 20) - 17.3) / 17.3).toBeLessThan(0.005);
  });
});

// The four functions ferrion's own psychrometrics.ts also implements
// (a deliberate copy, see its header) - checked here and there against the
// same psychrometrics.gold.json, so the two copies cannot drift apart
// without one of the tests saying so (review 2026-09, N-20).
describe("psychrometrics gold values shared with ferrion", () => {
  interface GoldPoint {
    temperatureC: number;
    dewPointC: number;
    pressureHpa: number;
    saturationVapourPressureHpa: number;
    dewPointFromVapourPressure: number;
    moistureContentGramsPerKg: number;
    relativeHumidityPercent: number;
  }
  const gold = JSON.parse(readFileSync(new URL("./psychrometrics.gold.json", import.meta.url), "utf-8")) as GoldPoint[];

  it("reproduces every gold point to 1e-9", () => {
    expect(gold.length).toBeGreaterThanOrEqual(5);
    for (const point of gold) {
      expect(saturationVapourPressureHpa(point.temperatureC)).toBeCloseTo(point.saturationVapourPressureHpa, 9);
      expect(dewPointFromVapourPressure(point.saturationVapourPressureHpa)).toBeCloseTo(point.dewPointFromVapourPressure, 9);
      expect(moistureContentGramsPerKg(point.dewPointC, point.pressureHpa)).toBeCloseTo(point.moistureContentGramsPerKg, 9);
      expect(relativeHumidityPercent(point.temperatureC, point.dewPointC)).toBeCloseTo(point.relativeHumidityPercent, 9);
    }
  });
});
