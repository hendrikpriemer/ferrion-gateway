import { describe, expect, it } from "vitest";
import { envLogLevel, fleetConfigSchema, instanceConfigSchema, pollingSchema, resilienceSchema } from "./schema.js";

describe("instanceConfigSchema", () => {
  const validInstance = {
    instanceName: "af2-opcua-1",
    ferrion: { baseUrl: "https://localhost:3000", apiKey: "gw_abc123", rejectUnauthorized: false },
    device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
  };

  it("accepts a minimal valid instance config and fills in defaults", () => {
    const result = instanceConfigSchema.parse(validInstance);
    expect(result.ports).toEqual({});
    expect(result.polling.commandsIntervalMs).toBe(3000);
    expect(result.polling.aggregation).toBe("last");
    expect(result.resilience.httpRequestTimeoutMs).toBe(10_000);
    expect(result.resilience.readingBufferMaxSize).toBe(10_000);
    expect(result.logLevel).toBe("info");
    expect(result.runReadingLoop).toBe(true);
  });

  it("accepts resilience overrides", () => {
    const result = instanceConfigSchema.parse({
      ...validInstance,
      resilience: { httpRequestTimeoutMs: 5000, readingBufferMaxSize: 200 },
    });
    expect(result.resilience).toEqual({ httpRequestTimeoutMs: 5000, readingBufferMaxSize: 200 });
  });

  it("accepts a bridge-only instance config with no device, defaulting ports to {}", () => {
    const { device, ...bridgeOnly } = validInstance;

    const result = instanceConfigSchema.parse(bridgeOnly);

    expect(result.device).toBeUndefined();
    expect(result.ports).toEqual({});
  });

  it("rejects an unknown device templateId", () => {
    const result = instanceConfigSchema.safeParse({
      ...validInstance,
      device: { templateId: "some-unknown-device", serialNumber: "1" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL ferrion.baseUrl", () => {
    const result = instanceConfigSchema.safeParse({
      ...validInstance,
      ferrion: { ...validInstance.ferrion, baseUrl: "not-a-url" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing instanceName", () => {
    const { instanceName, ...withoutName } = validInstance;
    const result = instanceConfigSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });
});

describe("fleetConfigSchema", () => {
  const validFleet = {
    ferrion: { baseUrl: "https://localhost:3000" },
    instances: [
      {
        instanceName: "af2-opcua-1",
        apiKeyEnvVar: "FG_KEY_AF2_OPCUA_1",
        device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
      },
    ],
  };

  it("accepts a minimal valid fleet config and fills in defaults", () => {
    const result = fleetConfigSchema.parse(validFleet);
    expect(result.ferrion.rejectUnauthorized).toBe(true);
    expect(result.resilience.httpRequestTimeoutMs).toBe(10_000);
    expect(result.instances).toHaveLength(1);
  });

  it("rejects an empty instances list", () => {
    const result = fleetConfigSchema.safeParse({ ...validFleet, instances: [] });
    expect(result.success).toBe(false);
  });

  it("accepts a fleet entry with no device (bridge-only)", () => {
    const bridgeEntry = { instanceName: "bridge-1", apiKeyEnvVar: "FG_KEY_BRIDGE_1" };

    const result = fleetConfigSchema.parse({ ...validFleet, instances: [...validFleet.instances, bridgeEntry] });

    expect(result.instances[1]?.device).toBeUndefined();
  });
});

describe("resilienceSchema", () => {
  it("defaults both fields when given an empty object", () => {
    expect(resilienceSchema.parse({})).toEqual({ httpRequestTimeoutMs: 10_000, readingBufferMaxSize: 10_000 });
  });

  it("rejects a non-positive value", () => {
    expect(resilienceSchema.safeParse({ httpRequestTimeoutMs: 0 }).success).toBe(false);
  });

  it("caps readingBufferMaxSize at ferrion's per-push limit", () => {
    expect(resilienceSchema.safeParse({ readingBufferMaxSize: 25_000 }).success).toBe(true);
    expect(resilienceSchema.safeParse({ readingBufferMaxSize: 25_001 }).success).toBe(false);
  });
});

describe("file-config strictness (review 2026-09, M-12)", () => {
  const validInstance = {
    instanceName: "af2-opcua-1",
    ferrion: { baseUrl: "https://localhost:3000", apiKey: "gw_test" },
    device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
  };
  const validFleet = {
    ferrion: { baseUrl: "https://localhost:3000" },
    instances: [
      {
        instanceName: "af2-opcua-1",
        apiKeyEnvVar: "FG_KEY_AF2_OPCUA_1",
        device: { templateId: "aventics-af2-opcua", serialNumber: "10000456" },
      },
    ],
  };

  it("refuses a misspelt key instead of silently dropping it and applying the default", () => {
    const result = instanceConfigSchema.safeParse({ ...validInstance, polling: { readingIntervalMS: 1 } });
    expect(result.success).toBe(false);
    expect(instanceConfigSchema.safeParse({ ...validInstance, typo: true }).success).toBe(false);
  });

  it("accepts only http(s) ferrion URLs without credentials", () => {
    for (const baseUrl of ["ftp://ferrion.example", "javascript:alert(1)", "https://user:pw@ferrion.example"]) {
      expect(instanceConfigSchema.safeParse({ ...validInstance, ferrion: { ...validInstance.ferrion, baseUrl } }).success, baseUrl).toBe(false);
    }
    expect(instanceConfigSchema.safeParse({ ...validInstance, ferrion: { ...validInstance.ferrion, baseUrl: "http://10.0.0.5:3000" } }).success).toBe(true);
  });

  it("keeps the push interval at one second or more - the millisecond range is for reads", () => {
    expect(pollingSchema.safeParse({ readingsPushIntervalMs: 999 }).success).toBe(false);
    expect(pollingSchema.safeParse({ readingsPushIntervalMs: 1000, readingIntervalMs: 1 }).success).toBe(true);
  });

  it("refuses duplicate fleet instance names and explicit port collisions", () => {
    const entry = validFleet.instances[0]!;
    const twice = fleetConfigSchema.safeParse({ ...validFleet, instances: [entry, { ...entry }] });
    expect(twice.success).toBe(false);

    const collide = fleetConfigSchema.safeParse({
      ...validFleet,
      instances: [
        { ...entry, instanceName: "a", ports: { modbus: 5502 } },
        { ...entry, instanceName: "b", ports: { modbus: 5502 } },
      ],
    });
    expect(collide.success).toBe(false);

    const fine = fleetConfigSchema.safeParse({
      ...validFleet,
      instances: [
        { ...entry, instanceName: "a", ports: { modbus: 5502 } },
        { ...entry, instanceName: "b", ports: { modbus: 5503 } },
      ],
    });
    expect(fine.success).toBe(true);
  });

  it("reads the log level from FG_LOG_LEVEL and falls back to info on nonsense", () => {
    expect(envLogLevel({ FG_LOG_LEVEL: "debug" })).toBe("debug");
    expect(envLogLevel({ FG_LOG_LEVEL: "loud" })).toBe("info");
    expect(envLogLevel({})).toBe("info");
  });
});
