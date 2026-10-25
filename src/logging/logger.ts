import pino from "pino";

export type Logger = pino.Logger;

// Pretty-printing only where a person is reading: a TTY outside production.
// In the container (NODE_ENV=production, no TTY) that transport used to run
// anyway - one pino-pretty worker thread per instance process and ANSI
// colour codes in `docker logs` (review 2026-09, M-5). Plain JSON lines
// there, which is also what a log shipper wants.
export function isPrettyLoggingWanted(env: NodeJS.ProcessEnv = process.env, isTTY: boolean = Boolean(process.stdout.isTTY)): boolean {
  return isTTY && env.NODE_ENV !== "production";
}

// One named child logger per instance - running a dozen instances in one
// terminal only stays readable if every line says which instance it came
// from.
export function createLogger(instanceName: string, level = "info"): Logger {
  return pino({
    level,
    ...(isPrettyLoggingWanted()
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
      : {}),
  }).child({ instance: instanceName });
}
