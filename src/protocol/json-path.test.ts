import { describe, expect, it } from "vitest";
import { getByPath, setByPath } from "./json-path.js";

describe("getByPath", () => {
  it("reads a flat (dot-free) key, same as a plain object lookup", () => {
    expect(getByPath({ temperature: 21.5 }, "temperature")).toBe(21.5);
  });

  it("reads a nested value through a dotted path", () => {
    expect(getByPath({ Temperature: { value: 21.5, unit: "C" } }, "Temperature.value")).toBe(21.5);
  });

  it("returns undefined when an intermediate segment is missing", () => {
    expect(getByPath({ Temperature: { value: 21.5 } }, "Pressure.value")).toBeUndefined();
  });

  it("returns undefined when an intermediate segment isn't an object", () => {
    expect(getByPath({ Temperature: 21.5 }, "Temperature.value")).toBeUndefined();
  });
});

describe("setByPath", () => {
  it("sets a flat (dot-free) key, same as a plain object assignment", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "temperature", 21.5);
    expect(obj).toEqual({ temperature: 21.5 });
  });

  it("creates intermediate objects for a dotted path", () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, "Temperature.value", 21.5);
    expect(obj).toEqual({ Temperature: { value: 21.5 } });
  });

  it("merges into an already-existing intermediate object rather than overwriting it", () => {
    const obj: Record<string, unknown> = { Temperature: { unit: "C" } };
    setByPath(obj, "Temperature.value", 21.5);
    expect(obj).toEqual({ Temperature: { unit: "C", value: 21.5 } });
  });
});
