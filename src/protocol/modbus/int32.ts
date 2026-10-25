/**
 * Mirrors float32.ts's register-order convention: register[0] = high 16
 * bits, register[1] = low 16 bits, each register itself big-endian on the
 * wire (standard Modbus). Callers needing the opposite word order (e.g. the
 * KEYENCE FD-G, whose Holding Register spec section 9-6 explicitly labels
 * the lower relative address "Wort niederer Ordnung" [low-order word] and
 * the next one "Wort höherer Ordnung" [high-order word]) reorder the pair
 * before calling these - see gateway-client.ts's decodeRegisterPair().
 */

export function decodeInt32BE(registers: readonly [number, number]): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint16(0, registers[0], false);
  view.setUint16(2, registers[1], false);
  return view.getInt32(0, false);
}

export function decodeUint32BE(registers: readonly [number, number]): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint16(0, registers[0], false);
  view.setUint16(2, registers[1], false);
  return view.getUint32(0, false);
}

export function encodeInt32BE(value: number): [number, number] {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setInt32(0, value, false);
  return [view.getUint16(0, false), view.getUint16(2, false)];
}

export function encodeUint32BE(value: number): [number, number] {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value, false);
  return [view.getUint16(0, false), view.getUint16(2, false)];
}
