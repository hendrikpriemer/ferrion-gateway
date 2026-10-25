import { describe, expect, it } from "vitest";
import { decodeFloat32BE, encodeFloat32BE } from "./float32.js";

describe("float32 Modbus codec", () => {
  it.each([
    [1, [0x3f80, 0x0000]],
    [-20, [0xc1a0, 0x0000]],
    [0, [0x0000, 0x0000]],
    [100.5, [0x42c9, 0x0000]],
  ] as const)("encodes %f to the known IEEE-754 register pair", (value, expected) => {
    expect(encodeFloat32BE(value)).toEqual(expected);
  });

  it.each([
    [[0x3f80, 0x0000], 1],
    [[0xc1a0, 0x0000], -20],
    [[0x0000, 0x0000], 0],
    [[0x42c9, 0x0000], 100.5],
  ] as const)("decodes the known register pair %j back to the original value", (registers, expected) => {
    expect(decodeFloat32BE(registers)).toBe(expected);
  });

  it.each([-80, -20.5, 0, 3.14159, 16, 60, 70, 100])("round-trips %f through encode/decode", (value) => {
    expect(decodeFloat32BE(encodeFloat32BE(value))).toBeCloseTo(value, 5);
  });
});
