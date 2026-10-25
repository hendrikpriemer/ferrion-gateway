import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The tab favicon is a hand-maintained static file (public/favicon.ico +
 * icon.svg), the same mark the ferrion platform uses. It carried a 20%
 * transparent margin that made browsers draw a light plate outside the blue
 * square - two nested frames, reported from a Safari tab. This guards the
 * corrected full-bleed version against a re-introduction of that margin.
 */
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const BRAND_BLUE = { r: 24, g: 95, b: 165 };

describe("icon.svg", () => {
  const svg = readFileSync(path.join(PUBLIC, "icon.svg"), "utf8");

  it("fills its box, with no scaling wrapper", () => {
    expect(svg).not.toMatch(/scale\(/);
  });

  it("draws the mark across the full viewBox", () => {
    expect(svg).toMatch(/viewBox="0 0 200 200"/);
    expect(svg).toMatch(/<rect x="0" y="0" width="200" height="200"/);
  });
});

describe("favicon.ico", () => {
  const buffer = readFileSync(path.join(PUBLIC, "favicon.ico"));
  const count = buffer.readUInt16LE(4);
  const entries = Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 16;
    return { size: buffer.readUInt8(at) || 256, offset: buffer.readUInt32LE(at + 12) };
  });

  function pixel(entry: { size: number; offset: number }, x: number, y: number) {
    const at = entry.offset + 40 + ((entry.size - 1 - y) * entry.size + x) * 4;
    return { r: buffer[at + 2]!, g: buffer[at + 1]!, b: buffer[at]!, a: buffer[at + 3]! };
  }

  it("reaches its mid-edges in brand blue, leaving no margin for a plate", () => {
    for (const entry of entries) {
      const mid = Math.floor(entry.size / 2);
      for (const p of [pixel(entry, mid, 0), pixel(entry, 0, mid)]) {
        expect(p.a).toBeGreaterThan(200);
        expect(Math.abs(p.r - BRAND_BLUE.r)).toBeLessThan(40);
        expect(Math.abs(p.g - BRAND_BLUE.g)).toBeLessThan(40);
        expect(Math.abs(p.b - BRAND_BLUE.b)).toBeLessThan(40);
      }
    }
  });

  it("keeps its rounded corners transparent", () => {
    for (const entry of entries) {
      expect(pixel(entry, 0, 0).a).toBeLessThan(60);
    }
  });
});
