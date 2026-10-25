import type { Server } from "node:net";
import { ServerTCP } from "modbus-serial";
import { decodeFloat32BE, encodeFloat32BE } from "./float32.js";
import { decodeInt32BE, decodeUint32BE, encodeInt32BE, encodeUint32BE } from "./int32.js";

// A small in-memory holding-register bank, sized to cover the highest
// register any catalog device actually uses - the Janitza UMG 801's own
// current-measurement module 20 reaches register 21344 (registerCount 2, so
// index 21345 must be valid), by far the highest of any template today. A
// Uint16Array silently drops out-of-bounds writes/reads (no error, no
// growth) rather than throwing, so an under-sized bank here doesn't fail
// loudly - it was found live as every one of that device's simulated
// readings silently coming back as 0. Sized with real headroom past that
// device's own need, not just exactly up to it, so the next device with an
// even higher register doesn't repeat the same silent failure.
const REGISTER_COUNT = 25000;

export class ModbusSimulatorServer {
  private readonly registers = new Uint16Array(REGISTER_COUNT);
  // Addresses this simulated device rejects outright with a genuine
  // Modbus exception (code 2, "Illegal Data Address") instead of
  // returning a value - real devices commonly only expose their own
  // documented register range and reject everything else this way,
  // rather than the fixed-size backing array's own default of just
  // returning 0 for any in-bounds address. Exists to test the gateway
  // client's own handling of that response (see
  // gateway-client.test.ts's testConnection tests) - found live against
  // a real DS1 unit that rejects register 0.
  private readonly rejectedAddresses = new Set<number>();
  private server: ServerTCP | undefined;
  // Cap on simultaneous TCP connections, like simple embedded devices
  // (found live: a DS1 refusing a second client while the gateway reads it).
  private maxConnections: number | undefined;

  setFloat32(registerAddress: number, value: number): void {
    const [high, low] = encodeFloat32BE(value);
    this.registers[registerAddress] = high;
    this.registers[registerAddress + 1] = low;
  }

  getFloat32(registerAddress: number): number {
    return decodeFloat32BE([this.registers[registerAddress] ?? 0, this.registers[registerAddress + 1] ?? 0]);
  }

  // wordOrder mirrors ModbusReadTarget.byteOrder (gateway-client.ts) -
  // "WORD_SWAPPED" writes the low 16 bits at registerAddress and the high
  // 16 bits at registerAddress + 1, the KEYENCE FD-G's own convention.
  setInt32(registerAddress: number, value: number, wordOrder: "BIG_ENDIAN" | "WORD_SWAPPED" = "BIG_ENDIAN"): void {
    const [high, low] = encodeInt32BE(value);
    const [first, second] = wordOrder === "BIG_ENDIAN" ? [high, low] : [low, high];
    this.registers[registerAddress] = first;
    this.registers[registerAddress + 1] = second;
  }

  getInt32(registerAddress: number, wordOrder: "BIG_ENDIAN" | "WORD_SWAPPED" = "BIG_ENDIAN"): number {
    const first = this.registers[registerAddress] ?? 0;
    const second = this.registers[registerAddress + 1] ?? 0;
    return decodeInt32BE(wordOrder === "BIG_ENDIAN" ? [first, second] : [second, first]);
  }

  setUint32(registerAddress: number, value: number, wordOrder: "BIG_ENDIAN" | "WORD_SWAPPED" = "BIG_ENDIAN"): void {
    const [high, low] = encodeUint32BE(value);
    const [first, second] = wordOrder === "BIG_ENDIAN" ? [high, low] : [low, high];
    this.registers[registerAddress] = first;
    this.registers[registerAddress + 1] = second;
  }

  getUint32(registerAddress: number, wordOrder: "BIG_ENDIAN" | "WORD_SWAPPED" = "BIG_ENDIAN"): number {
    const first = this.registers[registerAddress] ?? 0;
    const second = this.registers[registerAddress + 1] ?? 0;
    return decodeUint32BE(wordOrder === "BIG_ENDIAN" ? [first, second] : [second, first]);
  }

  // A single raw 16-bit register with no encoding - e.g. the FD-G's
  // Durchflussauflösung/Durchflusseinheit enum registers, which are plain
  // UINT values (0-3 / 0-2), not part of any 32-bit pair.
  setRegister(registerAddress: number, value: number): void {
    this.registers[registerAddress] = value;
  }

  rejectAddress(registerAddress: number): void {
    this.rejectedAddresses.add(registerAddress);
  }

  /** Must be called before start(). */
  limitConnections(max: number): void {
    this.maxConnections = max;
  }

  async start(port: number, host = "127.0.0.1"): Promise<void> {
    const registers = this.registers;
    const rejectedAddresses = this.rejectedAddresses;
    const vector = {
      getHoldingRegister: (addr: number) => registers[addr] ?? 0,
      getMultipleHoldingRegisters: (addr: number, length: number) => {
        for (let i = 0; i < length; i++) {
          if (rejectedAddresses.has(addr + i)) {
            const error = new Error("Illegal Data Address") as Error & { modbusErrorCode: number };
            error.modbusErrorCode = 0x02;
            throw error;
          }
        }
        return Array.from({ length }, (_, i) => registers[addr + i] ?? 0);
      },
    };

    await new Promise<void>((resolve, reject) => {
      const server = new ServerTCP(vector, { host, port, unitID: 1 });
      server.on("initialized", () => resolve());
      server.on("error", reject);
      this.server = server;
    });
    if (this.maxConnections !== undefined) {
      // net.Server drops connections over the cap; ServerTCP has no option for it.
      this.netServer().maxConnections = this.maxConnections;
    }
  }

  connectionCount(): Promise<number> {
    return new Promise((resolve, reject) =>
      this.netServer().getConnections((error, count) => (error ? reject(error) : resolve(count))),
    );
  }

  // modbus-serial's ServerTCP keeps its underlying net.Server as `_server`.
  private netServer(): Server {
    if (!this.server) throw new Error("ModbusSimulatorServer is not started");
    return (this.server as unknown as { _server: Server })._server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }
}
