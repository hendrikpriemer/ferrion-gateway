import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadInstanceConfig } from "./load-instance-config.js";

describe("loadInstanceConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-test-"));
  });

  it("loads and validates a well-formed instance config file", () => {
    const filePath = join(dir, "instance.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        instanceName: "af2-opcua-1",
        ferrion: { baseUrl: "https://localhost:3000", apiKey: "gw_abc" },
        device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
      }),
    );

    const config = loadInstanceConfig(filePath);
    expect(config.instanceName).toBe("af2-opcua-1");
    expect(config.device?.templateId).toBe("aventics-af2-opcua");
  });

  it("loads a bridge-only config file with no device", () => {
    const filePath = join(dir, "bridge.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        instanceName: "bridge-1",
        ferrion: { baseUrl: "https://localhost:3000", apiKey: "gw_abc" },
      }),
    );

    const config = loadInstanceConfig(filePath);
    expect(config.device).toBeUndefined();
    expect(config.ports).toEqual({});
  });

  it("throws a descriptive error for a missing file", () => {
    expect(() => loadInstanceConfig(join(dir, "does-not-exist.json"))).toThrow(/Could not read/);
  });

  it("throws a descriptive error for invalid JSON", () => {
    const filePath = join(dir, "broken.json");
    writeFileSync(filePath, "{ not json");
    expect(() => loadInstanceConfig(filePath)).toThrow(/not valid JSON/);
  });

  it("throws a descriptive error when required fields are missing", () => {
    const filePath = join(dir, "incomplete.json");
    writeFileSync(filePath, JSON.stringify({ instanceName: "x" }));
    expect(() => loadInstanceConfig(filePath)).toThrow(/is invalid/);
  });
});
