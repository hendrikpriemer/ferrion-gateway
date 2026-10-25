import { loadJsonConfig } from "./load-json-config.js";
import { fleetConfigSchema, type FleetConfig, type FleetEntry } from "./schema.js";

export interface ResolvedFleetInstance extends FleetEntry {
  apiKey: string;
}

export type ResolvedFleetConfig = Omit<FleetConfig, "instances"> & {
  instances: ResolvedFleetInstance[];
};

// `env` is injectable so tests don't have to mutate process.env.
export function loadFleetConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): ResolvedFleetConfig {
  const fleet = loadJsonConfig(filePath, fleetConfigSchema, "fleet");

  const missingEnvVars: string[] = [];
  const instances: ResolvedFleetInstance[] = fleet.instances.map((entry) => {
    const apiKey = env[entry.apiKeyEnvVar];
    if (!apiKey) {
      missingEnvVars.push(entry.apiKeyEnvVar);
    }
    return { ...entry, apiKey: apiKey ?? "" };
  });

  if (missingEnvVars.length > 0) {
    throw new Error(`Fleet config file "${filePath}" references env vars that are not set: ${missingEnvVars.join(", ")}`);
  }

  return { ...fleet, instances };
}
