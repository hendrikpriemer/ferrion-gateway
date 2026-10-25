import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { bufferFileNameFor, ReadingBufferStore } from "./reading-buffer-store.js";

function reading(dataSourceId: string, timestamp: string, value: number) {
  return { dataSourceId, timestamp, value };
}

describe("ReadingBufferStore", () => {
  let filePath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-store-test-"));
    filePath = join(dir, "af2-opcua-1.json");
  });

  it("starts with an empty array when no file exists yet", () => {
    const store = new ReadingBufferStore(filePath);
    expect(store.load()).toEqual([]);
  });

  it("save() then a fresh instance's load() round-trips the readings", () => {
    const readings = [reading("d1", "2026-08-14T12:00:00.000Z", 1), reading("d1", "2026-08-14T12:00:05.000Z", 2)];
    const first = new ReadingBufferStore(filePath);
    first.save(readings);

    const second = new ReadingBufferStore(filePath);
    expect(second.load()).toEqual(readings);
  });

  it("creates the parent directory if it doesn't exist yet", () => {
    const nestedPath = join(filePath, "..", "reading-buffers", "af2-opcua-1.json");
    const store = new ReadingBufferStore(nestedPath);

    expect(() => store.save([reading("d1", "2026-08-14T12:00:00.000Z", 1)])).not.toThrow();
    expect(store.load()).toEqual([reading("d1", "2026-08-14T12:00:00.000Z", 1)]);
  });

  it("load() returns [] and doesn't throw on a corrupt file", () => {
    writeFileSync(filePath, "{not valid json");
    const store = new ReadingBufferStore(filePath);

    expect(store.load()).toEqual([]);
  });

  it("save() overwrites the previous contents rather than appending", () => {
    const store = new ReadingBufferStore(filePath);
    store.save([reading("d1", "2026-08-14T12:00:00.000Z", 1)]);

    store.save([reading("d1", "2026-08-14T12:00:05.000Z", 2)]);

    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual([reading("d1", "2026-08-14T12:00:05.000Z", 2)]);
  });
});

describe("bufferFileNameFor", () => {
  it("keeps a plain name and neutralises anything that could leave the directory", () => {
    expect(bufferFileNameFor("bridge")).toBe("bridge.json");
    expect(bufferFileNameFor("af2-opcua_1.prod")).toBe("af2-opcua_1.prod.json");
    expect(bufferFileNameFor("../../etc/x")).toBe("__.._etc_x.json");
    expect(bufferFileNameFor("Mein Sensor #1")).toBe("Mein_Sensor__1.json");
    expect(bufferFileNameFor("")).toBe("instance.json");
    expect(bufferFileNameFor("x".repeat(100))).toBe(`${"x".repeat(64)}.json`);
  });
});
