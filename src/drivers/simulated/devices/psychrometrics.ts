/**
 * The humidity relations a dew-point sensor's readings actually obey.
 *
 * A DS1 reports eight quantities, but it does not measure eight independent
 * things: temperature and dew point are the measurement, everything else
 * follows from them and the line pressure. Simulating the rest as separate
 * random walks would emit combinations no real sensor can produce - and the
 * three values simulated so far already did. Measured on live simulated data:
 * 54.8 degC with a dew point of -27.3 degCtd implies 0.42 % relative
 * humidity, while the simulation was reporting 3.56 %.
 *
 * Magnus-Tetens with the Sonntag coefficients over water. Good to a few
 * hundredths of a percent across this sensor's range, which is far beyond
 * what a simulation needs, and it inverts in closed form - handy for the
 * atmospheric dew point below.
 */

const MAGNUS_A = 6.112; // hPa
const MAGNUS_B = 17.62;
const MAGNUS_C = 243.12; // degC

/** Specific gas constant of water vapour, J/(kg*K). */
const R_VAPOUR = 461.5;

const KELVIN_OFFSET = 273.15;

/** Standard atmosphere, the reference the "atmospheric dew point" expands to. */
export const ATMOSPHERIC_PRESSURE_HPA = 1013.25;

/** Saturation vapour pressure over water at `celsius`, in hPa. */
export function saturationVapourPressureHpa(celsius: number): number {
  return MAGNUS_A * Math.exp((MAGNUS_B * celsius) / (MAGNUS_C + celsius));
}

/** The temperature at which `hpa` would be the saturation pressure - the inverse of the above. */
export function dewPointFromVapourPressure(hpa: number): number {
  const ratio = Math.log(hpa / MAGNUS_A);
  return (MAGNUS_C * ratio) / (MAGNUS_B - ratio);
}

/**
 * Relative humidity in percent.
 *
 * Note this is the humidity of the compressed air AT LINE PRESSURE, which is
 * what the sensor sits in - no pressure term appears because both vapour
 * pressures are taken in the same gas.
 */
export function relativeHumidityPercent(temperatureC: number, dewPointC: number): number {
  return (
    (saturationVapourPressureHpa(dewPointC) / saturationVapourPressureHpa(temperatureC)) * 100
  );
}

/** Water vapour per cubic metre of gas, g/m³. */
export function absoluteHumidityGramsPerM3(temperatureC: number, dewPointC: number): number {
  const vapourPressurePa = saturationVapourPressureHpa(dewPointC) * 100;
  return (vapourPressurePa / (R_VAPOUR * (temperatureC + KELVIN_OFFSET))) * 1000;
}

/**
 * Water vapour per kilogram of DRY air, g/kg - the mixing ratio.
 *
 * This is the pressure-invariant one: compressing or expanding the gas moves
 * every other humidity figure but not this, which is why comparing two
 * measuring points along a network has to use it. 0.622 is the ratio of the
 * molar masses of water and dry air.
 */
export function moistureContentGramsPerKg(dewPointC: number, pressureHpa: number): number {
  const e = saturationVapourPressureHpa(dewPointC);
  return (622 * e) / (pressureHpa - e);
}

/** Water vapour as a volume fraction, in ppm. */
export function vapourRatioPpm(dewPointC: number, pressureHpa: number): number {
  return (saturationVapourPressureHpa(dewPointC) / pressureHpa) * 1e6;
}

/**
 * The dew point the same air would show after expanding to atmospheric
 * pressure - always lower than the pressure dew point.
 *
 * Worth keeping distinct: ISO 8573-1's water classes are defined against the
 * PRESSURE dew point, so this figure must never be classified against them.
 */
export function atmosphericDewPointC(dewPointC: number, pressureHpa: number): number {
  const expanded =
    saturationVapourPressureHpa(dewPointC) * (ATMOSPHERIC_PRESSURE_HPA / pressureHpa);
  return dewPointFromVapourPressure(expanded);
}
