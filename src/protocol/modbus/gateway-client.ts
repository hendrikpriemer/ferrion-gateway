// modbus-serial's own .d.ts declares an ESM `export default ModbusRTU` for
// what is actually a CJS module (`module.exports.default = module.exports`)
// - under NodeNext + esModuleInterop this makes TS type any default import
// as the whole (non-constructable) module namespace instead of the class.
// Worked around with our own minimal interface for just the methods used
// here, cast through `unknown` past the broken upstream typing.
import ModbusSerialPkg from "modbus-serial";
import type { Logger } from "../../logging/logger.js";
import { ReconnectCooldown } from "../reconnect-cooldown.js";
import { SerialQueue } from "../serial-queue.js";
import { SingleFlight } from "../single-flight.js";
import { decodeFloat32BE } from "./float32.js";
import { decodeInt32BE, decodeUint32BE } from "./int32.js";

interface ModbusRTUClient {
  // `timeout` here is what modbus-serial hands to its TcpPort as the
  // socket timeout for the connect itself - setTimeout() below only takes
  // effect for requests on an already-open port (its apis/connection.js
  // copies `_timeout` into the port options at connectTCP() time).
  connectTCP(host: string, options: { port: number; timeout?: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(duration: number): void;
  close(callback: () => void): void;
  readHoldingRegisters(address: number, length: number): Promise<{ data: number[] }>;
}

type ModbusRTUConstructor = new () => ModbusRTUClient;

const ModbusRTU = ModbusSerialPkg as unknown as ModbusRTUConstructor;

// Found live: modbus-serial's own request timeout defaults to disabled
// (`this._timeout = null`, see its index.js) - a request that never gets a
// response (e.g. the remote closed the TCP connection) then hangs forever
// instead of rejecting, which would silently freeze that data source's read
// ticker (and leak one never-settled transaction per tick) rather than ever
// reaching the reconnect/cooldown logic below.
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;

export interface ModbusConnectionConfig {
  host: string;
  port: number;
}

export interface ModbusReadTarget {
  register: number;
  registerCount: number;
  // "BIG_ENDIAN": register[0] = high 16 bits, register[1] = low 16 bits
  // (AVENTICS DS1's convention, and the only one FLOAT32 supports here -
  // see decodeRegisterPair()). "WORD_SWAPPED": the opposite - register[0]
  // = low 16 bits, register[1] = high 16 bits - seen live on the KEYENCE
  // FD-G, whose Holding Register spec (section 9-6) explicitly labels the
  // lower relative address "Wort niederer Ordnung" [low-order word].
  byteOrder: "BIG_ENDIAN" | "WORD_SWAPPED";
  // Defaults to FLOAT32 (DS1's own registers, and every target that
  // predates this field) when omitted.
  format?: "FLOAT32" | "INT32" | "UINT32";
  // INT32/UINT32 only: a further holding register (read-only on the FD-G)
  // whose value (0-3) selects the decimal-resolution multiplier applied to
  // the raw integer this target decodes - see RESOLUTION_MULTIPLIERS. Some
  // devices (e.g. KEYENCE FD-G) report physical values as a scaled raw
  // integer whose decimal position is itself a device-configured setting,
  // not a fixed constant baked into the register's own value - found live
  // in the FD-G's own manual (section 9-6, registers 25/26). Read once per
  // connection and cached (see resolveScale()), not re-read every tick -
  // it's read-only over Modbus, so it only actually changes via the
  // device's own local UI, which a running gateway can't observe anyway
  // short of a fresh connection.
  resolutionRegister?: number;
}

// KEYENCE FD-G section 9-6: 0 -> 0.001, 1 -> 0.01, 2 -> 0.1, 3 -> 1 -
// applied to the raw INT32/UINT32 this target decodes once a
// resolutionRegister is configured (see resolveScale()). Exported so
// drivers/simulated/device-simulator.ts can encode a simulated FD-G's
// registers against the exact same table instead of a second, driftable
// copy of it.
export const RESOLUTION_MULTIPLIERS = [0.001, 0.01, 0.1, 1];

function targetKey(target: ModbusReadTarget): string {
  return `${target.register}:${target.registerCount}:${target.byteOrder}:${target.format ?? "FLOAT32"}:${target.resolutionRegister ?? ""}`;
}

// Decodes one 32-bit value from a raw register pair as read off the wire
// (registers[0] is always the first/lower-address register regardless of
// byteOrder - only the *interpretation* of which half is significant
// differs). WORD_SWAPPED reorders the pair before handing it to the
// same BIG_ENDIAN-convention codecs float32.ts/int32.ts already provide,
// rather than teaching each codec its own word-order parameter.
function decodeRegisterPair(target: ModbusReadTarget, registers: readonly [number, number]): number {
  const format = target.format ?? "FLOAT32";
  if (format === "FLOAT32") {
    if (target.byteOrder !== "BIG_ENDIAN") {
      throw new Error(`FLOAT32 only supports byteOrder BIG_ENDIAN, got ${target.byteOrder}`);
    }
    return decodeFloat32BE(registers);
  }
  const ordered: readonly [number, number] =
    target.byteOrder === "BIG_ENDIAN" ? registers : [registers[1], registers[0]];
  return format === "INT32" ? decodeInt32BE(ordered) : decodeUint32BE(ordered);
}

// Protocol-generic: knows how to talk Modbus TCP, nothing about which
// device or metric it's reading - the caller supplies host/port and a read
// target (see gateway/command-handlers.ts and gateway/reading-loop.ts).
export class ModbusGatewayClient {
  private readonly client = new ModbusRTU();
  private readonly connection: ModbusConnectionConfig;
  private readonly cooldown = new ReconnectCooldown();
  private connected = false;
  // Guards against overlapping connect attempts: at a fast readIntervalMs,
  // reading-loop.ts's setInterval can fire the next read before a slow
  // first connectTCP() (real network I/O) has resolved, and
  // `if (this.connected) return` only blocks *sequential* re-entry - see
  // the identical, live-found issue in protocol/opcua/gateway-client.ts.
  private readonly connectGate = new SingleFlight<void>();
  // One gate per target (register), not one shared gate for the whole
  // client: at a real 1ms interval, dozens of overlapping readFloat32()
  // calls for the *same* target could otherwise each hit their own failing
  // readHoldingRegisters() and each log it - SingleFlight collapses that
  // into one real attempt, with only its outcome reported. A single shared
  // gate across *different* targets would be wrong here, unlike a plain
  // connect gate: it would make target B's read piggyback on (and receive)
  // target A's value instead of its own. See the identical per-target gate
  // map in protocol/opcua/gateway-client.ts.
  private readonly readGates = new Map<string, SingleFlight<number | undefined>>();
  // Targets whose decoded value was NaN/±Infinity (a float32 NaN pattern
  // is how some devices say "no value"), so that is logged once per
  // target, not once per tick (review 2026-09, M-11).
  private readonly nonFiniteReported = new Set<string>();
  private readonly logger: Logger | undefined;
  // modbus-serial doesn't pipeline requests over one TCP connection - two
  // targets reading concurrently over what's now a *shared* connection
  // (see acquireModbusGatewayClient()) could otherwise have their responses
  // mismatched to the wrong request. Every actual readHoldingRegisters()
  // call, across every target sharing this client, goes through this one
  // queue so only one is ever in flight on the wire at a time.
  private readonly queue = new SerialQueue();
  // register -> multiplier, see ModbusReadTarget.resolutionRegister. Reset
  // on every fresh connection (performConnect()) so a device reconfigured
  // locally during a power cycle isn't read with a stale multiplier
  // forever; never re-read within one connection's lifetime otherwise, to
  // avoid doubling the register traffic of every scaled target on every
  // single tick for a value that's read-only over Modbus anyway.
  private readonly resolutionCache = new Map<number, number>();

  constructor(connection: ModbusConnectionConfig, logger?: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.connectGate.run(() => this.performConnect());
  }

  private async performConnect(): Promise<void> {
    // Connect timeout as well as request timeout: without it, the first
    // connect to a black-holed host (and every TEST_CONNECTION, which is
    // always a first connect) sat in the OS TCP timeout, ~127 s on Linux,
    // with the whole command loop queued behind it (review 2026-09, M-8).
    await this.client.connectTCP(this.connection.host, { port: this.connection.port, timeout: DEFAULT_REQUEST_TIMEOUT_MS });
    this.client.setID(1);
    this.client.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS);
    this.connected = true;
    this.resolutionCache.clear();
  }

  // Always closes, connected or not: after a read failure `connected` is
  // already false while the socket may well still be open (a response
  // timeout does not close it), and modbus-serial's own close() is a no-op
  // without a port - so there is no state in which skipping it is right.
  disconnect(): void {
    this.client.close(() => {});
    this.connected = false;
  }

  // Returns undefined (not an error) while a prior failure's reconnect
  // cooldown is still active - Modbus TCP has no auto-reconnect of its own
  // (unlike node-opcua/mqtt.js), so without this a dead device would
  // otherwise get a fresh connectTCP() attempt on every single read tick,
  // down to every 1ms.
  async read(target: ModbusReadTarget): Promise<number | undefined> {
    if (target.registerCount !== 2) {
      throw new Error(
        `Unsupported Modbus read target (registerCount=${target.registerCount}) - only a single 32-bit value across 2 registers is implemented`,
      );
    }
    if (!this.cooldown.canAttempt()) return undefined;
    const key = targetKey(target);
    let gate = this.readGates.get(key);
    if (!gate) {
      gate = new SingleFlight<number>();
      this.readGates.set(key, gate);
    }
    return gate.run(() => this.queue.run(() => this.performRead(target)));
  }

  private async performRead(target: ModbusReadTarget): Promise<number | undefined> {
    try {
      await this.connect();
      const { data } = await this.client.readHoldingRegisters(target.register, 2);
      const raw = decodeRegisterPair(target, [data[0] ?? 0, data[1] ?? 0]);
      const scale = await this.resolveScale(target.resolutionRegister);
      this.cooldown.reset();
      const value = raw * scale;
      // The float32 NaN/Infinity bit patterns are how some devices report
      // "no value"; the platform drops such readings per entry, so locally
      // they are "no value this cycle" too - not an error (the device
      // answered), not a live reading either.
      if (!Number.isFinite(value)) {
        const key = targetKey(target);
        if (!this.nonFiniteReported.has(key)) {
          this.nonFiniteReported.add(key);
          this.logger?.warn({ target: key, raw }, "Modbus register decoded to a non-finite value - ignored");
        }
        return undefined;
      }
      this.nonFiniteReported.delete(targetKey(target));
      return value;
    } catch (error) {
      // A dropped socket leaves `connected` true with no way to tell short
      // of the next failed call - reset it here so the *next* attempt (once
      // the cooldown clears) reconnects instead of repeating the same
      // broken call forever. Closed, not just flagged: a response timeout
      // leaves the socket open, and the next connectTCP() would replace
      // modbus-serial's port object without closing the old one.
      this.client.close(() => {});
      this.connected = false;
      this.cooldown.recordFailure();
      throw error;
    }
  }

  // Deliberately does NOT go through this.queue.run() - it's always called
  // from within performRead(), which is itself already executing inside
  // that same queue's one in-flight slot. SerialQueue isn't reentrant (see
  // its own doc comment: each run() chains onto the *previous* task's
  // completion) - a nested run() here would wait on this very task's own
  // completion and deadlock forever, silently freezing this data source's
  // read ticker exactly like the unbounded-request-timeout issue documented
  // above DEFAULT_REQUEST_TIMEOUT_MS.
  private async resolveScale(resolutionRegister: number | undefined): Promise<number> {
    if (resolutionRegister === undefined) return 1;
    const cached = this.resolutionCache.get(resolutionRegister);
    if (cached !== undefined) return cached;
    const { data } = await this.client.readHoldingRegisters(resolutionRegister, 1);
    const enumValue = data[0] ?? -1;
    const multiplier = RESOLUTION_MULTIPLIERS[enumValue];
    if (multiplier === undefined) {
      throw new Error(`Unexpected resolution enum value at register ${resolutionRegister}: ${enumValue} (expected 0-3)`);
    }
    this.resolutionCache.set(resolutionRegister, multiplier);
    return multiplier;
  }

  // Through the same queue as read(), and without the cooldown check (an
  // explicit user action): the test may run on a connection that data
  // sources are reading from at this very moment - see command-handlers.ts.
  async testConnection(): Promise<void> {
    await this.queue.run(() => this.performTestConnection());
  }

  private async performTestConnection(): Promise<void> {
    try {
      await this.connect();
      await this.client.readHoldingRegisters(0, 1);
    } catch (error) {
      // A well-formed Modbus exception response (e.g. "Illegal Data
      // Address" because register 0 isn't in this specific device's own
      // valid range) still proves it's live and speaking Modbus TCP
      // correctly - found live against a real DS1 unit that rejects
      // register 0 outright, surfacing as a false "connection failed" in
      // the wizard even though the device answered. modbus-serial tags
      // exactly this case with `.modbusCode` (see its own index.js); a
      // genuine transport failure (timeout, ECONNREFUSED, ...) never
      // reaches the Modbus PDU layer and so never carries it.
      if (error && typeof error === "object" && "modbusCode" in error) return;
      // Same reset as performRead(): the socket may be shared with readers,
      // and a transport failure leaves it in no state worth keeping.
      this.client.close(() => {});
      this.connected = false;
      throw error;
    }
  }
}

function connectionKey(connection: ModbusConnectionConfig): string {
  return `${connection.host}:${connection.port}`;
}

// Reference-counted registry so every data source reading from the same
// physical Modbus TCP device (same host+port, e.g. several metrics on one
// DS1 unit) shares a single ModbusGatewayClient/connection instead of
// reading-loop.ts's per-data-source createDataSourceReader() each opening
// its own. Matters even more here than for MQTT (see that gateway-client.ts's
// identical registry): many real Modbus TCP devices, especially simple/
// embedded ones, cap concurrent TCP connections far lower than a proper
// MQTT broker or OPC UA server does - a handful of metrics opening their
// own connection each risks the *device* itself refusing connections, not
// just wasted gateway-side overhead. Mirrors
// protocol/opcua/gateway-client.ts's identical acquire/release pattern -
// see its own doc comment for why this is module-level, not per-ReadingLoop.
const sharedClients = new Map<string, { client: ModbusGatewayClient; refCount: number }>();

export function acquireModbusGatewayClient(connection: ModbusConnectionConfig, logger?: Logger): ModbusGatewayClient {
  const key = connectionKey(connection);
  const existing = sharedClients.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.client;
  }
  const client = new ModbusGatewayClient(connection, logger);
  sharedClients.set(key, { client, refCount: 1 });
  return client;
}

// Only actually disconnects once every data source sharing this client has
// released it - releasing before that would drop the other data sources'
// connection out from under them.
export function releaseModbusGatewayClient(connection: ModbusConnectionConfig): void {
  const key = connectionKey(connection);
  const entry = sharedClients.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  sharedClients.delete(key);
  entry.client.disconnect();
}
