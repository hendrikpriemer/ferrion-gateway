/**
 * DS1's catalog entries all declare `byteOrder: "BIG_ENDIAN"` with
 * `registerCount: 2` (see device-catalog/known-device-templates.ts) - a
 * 32-bit float spread across two 16-bit holding registers, most-significant
 * register first (register[0] = high 16 bits, register[1] = low 16 bits),
 * each register itself big-endian on the wire (standard Modbus).
 */

export function encodeFloat32BE(value: number): [number, number] {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  return [view.getUint16(0, false), view.getUint16(2, false)];
}

export function decodeFloat32BE(registers: readonly [number, number]): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint16(0, registers[0], false);
  view.setUint16(2, registers[1], false);
  return view.getFloat32(0, false);
}
