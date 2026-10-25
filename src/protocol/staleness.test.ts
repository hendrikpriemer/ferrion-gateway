import { describe, expect, it } from "vitest";
import { isStale } from "./staleness.js";

describe("isStale", () => {
  it("is not stale when no value has ever been received yet", () => {
    expect(isStale({ latestValueAt: undefined }, 1000, 500)).toBe(false);
  });

  it("is not stale exactly at the threshold (boundary, strict > only)", () => {
    expect(isStale({ latestValueAt: 500 }, 1000, 500)).toBe(false);
  });

  it("is stale once the last value is older than the threshold", () => {
    expect(isStale({ latestValueAt: 499 }, 1000, 500)).toBe(true);
  });

  it("is not stale for a value that just arrived", () => {
    expect(isStale({ latestValueAt: 1000 }, 1000, 500)).toBe(false);
  });
});
