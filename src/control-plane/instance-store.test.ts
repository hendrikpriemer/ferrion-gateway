import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceStore } from "./instance-store.js";

function input(instanceName: string) {
  return {
    instanceName,
    device: { templateId: "aventics-ds1-modbus-tcp" as const, serialNumber: "1" },
    ports: { modbus: 5502 },
  };
}

// A bridge-only instance - no locally-simulated device, only bridges real
// hardware whose connection details live entirely in ferrion's own
// data-source config (see schema.ts's instanceConfigSchema.device).
function bridgeInput(instanceName: string) {
  return { instanceName, ports: {} };
}

describe("InstanceStore", () => {
  let filePath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-store-test-"));
    filePath = join(dir, "instances.json");
  });

  it("starts empty when no file exists yet", () => {
    const store = new InstanceStore(filePath);
    expect(store.list()).toEqual([]);
  });

  it("creates a record, assigns an id, and persists it to disk", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(input("af2-opcua-1"));

    expect(record.id).toBeTruthy();
    expect(record.instanceName).toBe("af2-opcua-1");
    expect(store.get(record.id)).toEqual(record);

    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].id).toBe(record.id);
  });

  it("persists across store instances (survives a restart)", () => {
    const first = new InstanceStore(filePath);
    const record = first.create(input("af2-opcua-1"));

    const second = new InstanceStore(filePath);
    expect(second.get(record.id)).toEqual(record);
  });

  it("updates a record in place, keeping its id and createdAt", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(input("af2-opcua-1"));

    const updated = store.update(record.id, {
      instanceName: "renamed",
      device: { templateId: "aventics-af2-mqtt", serialNumber: "10000456" },
      ports: { mqtt: 1883 },
    });

    expect(updated).toEqual({
      id: record.id,
      createdAt: record.createdAt,
      instanceName: "renamed",
      device: { templateId: "aventics-af2-mqtt", serialNumber: "10000456" },
      ports: { mqtt: 1883 },
    });
    expect(store.get(record.id)).toEqual(updated);
  });

  it("update persists the change to disk", () => {
    const first = new InstanceStore(filePath);
    const record = first.create(input("af2-opcua-1"));
    first.update(record.id, { ...input("renamed") });

    const second = new InstanceStore(filePath);
    expect(second.get(record.id)?.instanceName).toBe("renamed");
  });

  it("update returns undefined for an unknown id without touching the store", () => {
    const store = new InstanceStore(filePath);
    store.create(input("af2-opcua-1"));

    expect(store.update("does-not-exist", input("x"))).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("persists polling overrides alongside the rest of a record", () => {
    const store = new InstanceStore(filePath);
    const record = store.create({ ...input("af2-opcua-1"), polling: { readingIntervalMs: 10, aggregation: "avg" } });

    expect(record.polling).toEqual({ readingIntervalMs: 10, aggregation: "avg" });
    expect(store.get(record.id)?.polling).toEqual({ readingIntervalMs: 10, aggregation: "avg" });
  });

  it("creates and round-trips a bridge-only record (no device) across store instances", () => {
    const first = new InstanceStore(filePath);
    const record = first.create(bridgeInput("bridge-1"));
    expect(record.device).toBeUndefined();

    const second = new InstanceStore(filePath);
    expect(second.get(record.id)).toEqual(record);
  });

  it("setAutoStart flips the flag and persists it", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(input("af2-opcua-1"));
    expect(record.autoStart).toBeUndefined();

    const updated = store.setAutoStart(record.id, true);

    expect(updated?.autoStart).toBe(true);
    expect(store.get(record.id)?.autoStart).toBe(true);

    const second = new InstanceStore(filePath);
    expect(second.get(record.id)?.autoStart).toBe(true);
  });

  it("setAutoStart leaves the rest of the record untouched", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(input("af2-opcua-1"));

    const updated = store.setAutoStart(record.id, true);

    expect(updated).toEqual({ ...record, autoStart: true });
  });

  it("setAutoStart returns undefined for an unknown id without touching the store", () => {
    const store = new InstanceStore(filePath);
    store.create(input("af2-opcua-1"));

    expect(store.setAutoStart("does-not-exist", true)).toBeUndefined();
  });

  it("updateSettings merges polling and resilience, persists, and leaves the rest untouched", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(bridgeInput("bridge-1"));

    const updated = store.updateSettings(record.id, {
      polling: { readingIntervalMs: 1000 },
      resilience: { httpRequestTimeoutMs: 5000, readingBufferMaxSize: 500 },
    });

    expect(updated).toEqual({
      ...record,
      polling: { readingIntervalMs: 1000 },
      resilience: { httpRequestTimeoutMs: 5000, readingBufferMaxSize: 500 },
    });
    expect(store.get(record.id)).toEqual(updated);

    const second = new InstanceStore(filePath);
    expect(second.get(record.id)?.resilience).toEqual({ httpRequestTimeoutMs: 5000, readingBufferMaxSize: 500 });
  });

  it("updateSettings returns undefined for an unknown id without touching the store", () => {
    const store = new InstanceStore(filePath);
    store.create(bridgeInput("bridge-1"));

    expect(store.updateSettings("does-not-exist", { polling: {} })).toBeUndefined();
  });

  it("moves a file that is not a record array aside and starts empty, instead of crashing the boot", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(filePath, "{}");
      const store = new InstanceStore(filePath);
      expect(store.list()).toEqual([]);
      const aside = readdirSync(dirname(filePath)).filter((name) => name.startsWith("instances.json.invalid-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dirname(filePath), aside[0]!), "utf-8")).toBe("{}");

      // A record missing its id is just as unusable as a non-array.
      writeFileSync(filePath, JSON.stringify([{ instanceName: "x", ports: {}, createdAt: "2026-01-01" }]));
      expect(new InstanceStore(filePath).list()).toEqual([]);

      // The next write repairs the file for good.
      const repaired = new InstanceStore(filePath);
      repaired.create(bridgeInput("bridge"));
      expect(new InstanceStore(filePath).list()).toHaveLength(1);
    } finally {
      quiet.mockRestore();
    }
  });

  it("removes a record and reports whether anything was removed", () => {
    const store = new InstanceStore(filePath);
    const record = store.create(input("af2-opcua-1"));

    expect(store.remove("does-not-exist")).toBe(false);
    expect(store.remove(record.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });
});
