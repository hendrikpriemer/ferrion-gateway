import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadFleetConfig } from "./load-fleet-config.js";

describe("loadFleetConfig", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-test-"));
    filePath = join(dir, "fleet.config.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        ferrion: { baseUrl: "https://localhost:3000" },
        instances: [
          {
            instanceName: "af2-opcua-1",
            apiKeyEnvVar: "FG_KEY_AF2_OPCUA_1",
            device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
          },
          {
            instanceName: "ds1-modbus-1",
            apiKeyEnvVar: "FG_KEY_DS1_MODBUS_1",
            device: { templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" },
          },
        ],
      }),
    );
  });

  it("resolves each instance's API key from its configured env var", () => {
    const config = loadFleetConfig(filePath, {
      FG_KEY_AF2_OPCUA_1: "gw_key_one",
      FG_KEY_DS1_MODBUS_1: "gw_key_two",
    });

    expect(config.instances.map((i) => i.apiKey)).toEqual(["gw_key_one", "gw_key_two"]);
  });

  it("throws listing every missing env var, not just the first", () => {
    expect(() => loadFleetConfig(filePath, {})).toThrow(/FG_KEY_AF2_OPCUA_1.*FG_KEY_DS1_MODBUS_1/s);
  });

  it("throws a descriptive error for a missing file", () => {
    expect(() => loadFleetConfig(join(dir, "does-not-exist.json"))).toThrow(/Could not read/);
  });
});
