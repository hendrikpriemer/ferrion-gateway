import { createRandomWalk, type Prng, type ValueRange } from "../prng.js";
import {
  absoluteHumidityGramsPerM3,
  atmosphericDewPointC,
  moistureContentGramsPerKg,
  relativeHumidityPercent,
  saturationVapourPressureHpa,
  vapourRatioPpm,
} from "./psychrometrics.js";

export interface Ds1Values {
  temperature: number;
  relativeHumidity: number;
  dewPoint: number;
  absoluteHumidity: number;
  moistureContent: number;
  vaporRatio: number;
  waterVaporPartialPressure: number;
  atmosphericDewPoint: number;
}

// Real "Technische Daten"/"Technical data" measuring ranges, Chapter 14 of
// the DS1 operating instructions - dewPoint uses the R412029133 variant's
// wider range (see the plan's "Reale Wertebereiche für die Simulation").
const TEMPERATURE_RANGE: ValueRange = { min: -20, max: 70 };
const DEW_POINT_RANGE: ValueRange = { min: -80, max: 20 };

/**
 * Line pressure the derived quantities are computed at, in hPa absolute
 * (~7 bar gauge).
 *
 * The DS1 does not measure pressure, so this cannot come from the device -
 * but moisture content and ppm are meaningless without it, and picking a
 * typical compressed-air working pressure is more honest than quietly
 * computing them at 1013 hPa, which no compressed-air line ever sits at.
 */
const LINE_PRESSURE_HPA = 8000;

/**
 * Simulated DS1 readings.
 *
 * Only TWO quantities are walked - the temperature of the gas and its dew
 * point. Everything else the device reports is derived from those two and
 * the line pressure, because that is what the real instrument does: it
 * measures, then computes. Walking them independently produced combinations
 * no sensor could ever output; measured on the live simulation, 54.8 degC
 * with a -27.3 degCtd dew point was being reported alongside 3.56 % relative
 * humidity, where the physics gives 0.42 %.
 *
 * The dew point is additionally capped at the gas temperature. Air cannot
 * hold a dew point above its own temperature - it would already have
 * condensed - and two independent walks crossed that line regularly.
 */
export function createDs1ValueGenerator(prng: Prng): () => Ds1Values {
  const nextTemperature = createRandomWalk(prng, TEMPERATURE_RANGE);
  const nextDewPoint = createRandomWalk(prng, DEW_POINT_RANGE);

  return function next(): Ds1Values {
    const temperature = nextTemperature();
    const dewPoint = Math.min(nextDewPoint(), temperature);

    return {
      temperature,
      dewPoint,
      relativeHumidity: relativeHumidityPercent(temperature, dewPoint),
      absoluteHumidity: absoluteHumidityGramsPerM3(temperature, dewPoint),
      moistureContent: moistureContentGramsPerKg(dewPoint, LINE_PRESSURE_HPA),
      vaporRatio: vapourRatioPpm(dewPoint, LINE_PRESSURE_HPA),
      waterVaporPartialPressure: saturationVapourPressureHpa(dewPoint),
      atmosphericDewPoint: atmosphericDewPointC(dewPoint, LINE_PRESSURE_HPA),
    };
  };
}
