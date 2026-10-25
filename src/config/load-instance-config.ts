import { loadJsonConfig } from "./load-json-config.js";
import { instanceConfigSchema, type InstanceConfig } from "./schema.js";

export function loadInstanceConfig(filePath: string): InstanceConfig {
  return loadJsonConfig(filePath, instanceConfigSchema, "instance");
}
