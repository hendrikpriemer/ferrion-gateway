import { describe, expect, it } from "vitest";
import { decodeInt32BE, decodeUint32BE, encodeInt32BE, encodeUint32BE } from "./int32.js";

describe("int32 Modbus codec", () => {
  it.each([
    [1, [0x0000, 0x0001]],
    [-1, [0xffff, 0xffff]],
    [-999999, [0xfff0, 0xbdc1]],
    [999999, [0x000f, 0x423f]],
    [0, [0x0000, 0x0000]],
  ] as const)("encodes %i to the known register pair", (value, expected) => {
    expect(encodeInt32BE(value)).toEqual(expected);
  });

  it.each([
    [[0x0000, 0x0001], 1],
    [[0xffff, 0xffff], -1],
    [[0xfff0, 0xbdc1], -999999],
    [[0x000f, 0x423f], 999999],
  ] as const)("decodes the known register pair %j back to the original value", (registers, expected) => {
    expect(decodeInt32BE(registers)).toBe(expected);
  });

  it.each([-999999, -1, 0, 1, 999999])("round-trips %i through encode/decode", (value) => {
    expect(decodeInt32BE(encodeInt32BE(value))).toBe(value);
  });
});

describe("uint32 Modbus codec", () => {
  it.each([
    [0, [0x0000, 0x0000]],
    [1, [0x0000, 0x0001]],
    [999999999, [0x3b9a, 0xc9ff]],
  ] as const)("encodes %i to the known register pair", (value, expected) => {
    expect(encodeUint32BE(value)).toEqual(expected);
  });

  it.each([
    [[0x0000, 0x0000], 0],
    [[0x0000, 0x0001], 1],
    [[0x3b9a, 0xc9ff], 999999999],
  ] as const)("decodes the known register pair %j back to the original value", (registers, expected) => {
    expect(decodeUint32BE(registers)).toBe(expected);
  });

  it.each([0, 1, 999999999])("round-trips %i through encode/decode", (value) => {
    expect(decodeUint32BE(encodeUint32BE(value))).toBe(value);
  });
});
