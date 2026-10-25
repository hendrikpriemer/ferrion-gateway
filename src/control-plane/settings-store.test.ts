import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "./settings-store.js";

describe("SettingsStore", () => {
  let filePath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-settings-test-"));
    filePath = join(dir, "settings.json");
  });

  it("returns undefined when no settings file exists yet", () => {
    const store = new SettingsStore(filePath);
    expect(store.get()).toBeUndefined();
  });

  it("saves settings, persists them to disk, and returns them via get()", () => {
    const store = new SettingsStore(filePath);
    const settings = { baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: false };

    store.save(settings);

    expect(store.get()).toEqual(settings);
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(settings);
  });

  it("persists across store instances (survives a restart)", () => {
    const settings = { baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: false };
    const first = new SettingsStore(filePath);
    first.save(settings);

    const second = new SettingsStore(filePath);
    expect(second.get()).toEqual(settings);
  });

  it("overwrites previously saved settings", () => {
    const store = new SettingsStore(filePath);
    store.save({ baseUrl: "https://localhost:3000", apiKey: "gw_old", rejectUnauthorized: false });
    store.save({ baseUrl: "https://localhost:3000", apiKey: "gw_new", rejectUnauthorized: true });

    expect(store.get()).toEqual({ baseUrl: "https://localhost:3000", apiKey: "gw_new", rejectUnauthorized: true });
  });

  it("clear() removes the settings, returns true, and deletes the file", () => {
    const store = new SettingsStore(filePath);
    store.save({ baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: false });

    const cleared = store.clear();

    expect(cleared).toBe(true);
    expect(store.get()).toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it("clear() returns false and is a no-op when nothing was configured", () => {
    const store = new SettingsStore(filePath);

    expect(store.clear()).toBe(false);
    expect(store.get()).toBeUndefined();
  });

  it("treats a settings file without an apiKey, or with broken JSON, as unconfigured instead of sending Bearer undefined", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(filePath, JSON.stringify({ baseUrl: "https://ferrion.example" }));
      expect(new SettingsStore(filePath).get()).toBeUndefined();

      writeFileSync(filePath, "{not json");
      expect(new SettingsStore(filePath).get()).toBeUndefined();

      writeFileSync(filePath, JSON.stringify({ baseUrl: "https://ferrion.example", apiKey: "gw_x" }));
      expect(new SettingsStore(filePath).get()).toEqual({ baseUrl: "https://ferrion.example", apiKey: "gw_x", rejectUnauthorized: true });
    } finally {
      quiet.mockRestore();
    }
  });

  it("clear() is not undone by re-loading in a new store instance", () => {
    const first = new SettingsStore(filePath);
    first.save({ baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: false });
    first.clear();

    const second = new SettingsStore(filePath);
    expect(second.get()).toBeUndefined();
  });
});
