import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { OpcuaSimulatorServer } from "./simulator-server.js";
import { NodeNotFoundError } from "../node-not-found-error.js";
import {
  noFirstValueResubscribeMs,
  OpcuaNodeNotFoundError,
  OpcuaGatewayClient,
  parseModuleIndexFromBrowseName,
  shouldResubscribeTarget,
} from "./gateway-client.js";

// A fixed port outside the simulator's own 4840-4850 range and outside the
// Docker image's published ports: this test runs its own throwaway server,
// never a simulated instance's.
const TEST_PORT = 24843;
const NAMESPACE = "urn:ferrion:test:opcua-gateway-client";
const CONNECTION = { host: "127.0.0.1", port: TEST_PORT, namespaceUri: NAMESPACE };
const FLOW = 1001;
const PRESSURE = 1002;
const SAMPLING_MS = 100;

function target(nodeIdentifier: number) {
  return { namespaceUri: NAMESPACE, nodeIdentifier };
}

/** Polls `read` until it returns `expected` (or the timeout passes) and returns the last value seen. */
async function until(read: () => number | undefined, expected: number | undefined, timeoutMs = 5_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  let seen = read();
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = read();
  }
  return seen;
}

/** A real pino logger whose lines land in an array - the client's logger is pino's type, not an interface to fake. */
function capturingLogger(): { logger: pino.Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: "info" }, stream), lines };
}

describe("OpcuaGatewayClient against the simulator", () => {
  let server: OpcuaSimulatorServer | undefined;
  let client: OpcuaGatewayClient | undefined;

  afterEach(async () => {
    await client?.disconnect();
    await server?.stop();
    server = undefined;
    client = undefined;
  });

  it("drops the cached value when a node turns null or reports a bad status - and logs each once per node, with the recovery", async () => {
    // Found on the production instance 2026-10-10: a Janitza UMG 801
    // reported null for its power factors while the compressor stood still,
    // and the gateway kept pushing the last number for 32 hours as if it
    // were current. A frozen value is a wrong reading; no value is a gap.
    server = new OpcuaSimulatorServer();
    await server.start(TEST_PORT, NAMESPACE);
    server.addVariable(FLOW, "Flow", 12.5);
    server.addVariable(PRESSURE, "Pressure", 6.5);
    const { logger, lines } = capturingLogger();
    client = new OpcuaGatewayClient(CONNECTION, logger);
    await client.connect();
    await client.ensureSubscribed(target(FLOW), SAMPLING_MS);
    await client.ensureSubscribed(target(PRESSURE), SAMPLING_MS);
    const flow = () => client!.readCachedValue(target(FLOW));
    const pressure = () => client!.readCachedValue(target(PRESSURE));
    expect(await until(flow, 12.5)).toBe(12.5);
    expect(await until(pressure, 6.5)).toBe(6.5);

    // The two shapes a device uses for "no good value right now".
    server.setNull(FLOW);
    server.setBadStatus(PRESSURE);
    expect(await until(flow, undefined)).toBeUndefined();
    expect(await until(pressure, undefined)).toBeUndefined();

    // A second bad sample with the same status (different carried value, so
    // the server does notify again) must not produce a second warning - a
    // device in trouble repeats its status every sample.
    server.setBadStatus(PRESSURE, undefined, 1);
    await new Promise((resolve) => setTimeout(resolve, SAMPLING_MS * 10));
    expect(pressure()).toBeUndefined();

    const warnings = lines.filter((line) => line.level === 40);
    const about = (node: number) => warnings.filter((line) => String(line.target).endsWith(`:${node}`) || String(line.target).includes(String(node)));
    expect(about(FLOW)).toHaveLength(1);
    expect(about(PRESSURE)).toHaveLength(1);
    expect(String(about(PRESSURE)[0]!.status)).toMatch(/BadSensorFailure/);

    // Good values again: cached and read, and the recovery logged once each.
    server.setValue(FLOW, 7.5);
    server.setValue(PRESSURE, 6.25);
    expect(await until(flow, 7.5)).toBe(7.5);
    expect(await until(pressure, 6.25)).toBe(6.25);
    const recoveries = lines.filter((line) => line.level === 30 && /good values again/.test(String(line.msg)));
    expect(recoveries).toHaveLength(2);
  }, 30_000);

  it("reads the device's firmware version, for ferrion to refuse a UMG 801 older than 1.6 (ferrion#902)", async () => {
    server = new OpcuaSimulatorServer();
    await server.start(TEST_PORT, NAMESPACE, "127.0.0.1", { softwareVersion: "1.5.2+1c931b83.231006103238.b636" });
    client = new OpcuaGatewayClient(CONNECTION);

    expect(await client.readSoftwareVersion()).toBe("1.5.2+1c931b83.231006103238.b636");
  }, 30_000);

  it("delivers a first value for many targets subscribed on one endpoint in quick succession", async () => {
    // The shape of Befund 1 (docs/umg801-zuordnung-gateway-befunde-2026-10-11.md
    // in ferrion): seven-plus sources on one physical device, each subscribing
    // in quick succession on the shared session. All must deliver without a
    // restart. This is the happy path; shouldResubscribeTarget() below covers
    // the recovery decision the concurrency race needs.
    server = new OpcuaSimulatorServer();
    await server.start(TEST_PORT, NAMESPACE);
    const nodes = [1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017];
    nodes.forEach((node, index) => server!.addVariable(node, `N${node}`, index + 0.5));
    client = new OpcuaGatewayClient(CONNECTION);
    await client.connect();

    // Fired concurrently, not one at a time - the real reading loop ticks each
    // source on its own timer, so their ensureSubscribed() calls overlap.
    await Promise.all(nodes.map((node) => client!.ensureSubscribed(target(node), SAMPLING_MS)));

    for (const [index, node] of nodes.entries()) {
      expect(await until(() => client!.readCachedValue(target(node)), index + 0.5)).toBe(index + 0.5);
    }
  }, 30_000);
});

describe("shouldResubscribeTarget", () => {
  const base = { sameSubscription: true, subscriptionAlive: true, hasValue: true, msSinceSubscribed: 0, noFirstValueMs: 10_000 };

  it("keeps a target that is current, alive and delivering", () => {
    expect(shouldResubscribeTarget(base)).toBe(false);
  });

  it("re-subscribes when the whole subscription is no longer alive", () => {
    expect(shouldResubscribeTarget({ ...base, subscriptionAlive: false })).toBe(true);
  });

  it("re-subscribes an item left on a since-replaced subscription (the 2026-10-11 race)", () => {
    expect(shouldResubscribeTarget({ ...base, sameSubscription: false })).toBe(true);
  });

  it("re-subscribes a current, alive item that never delivered its first value", () => {
    expect(shouldResubscribeTarget({ ...base, hasValue: false, msSinceSubscribed: 10_000 })).toBe(true);
  });

  it("waits out the grace window before calling a value-less item silent", () => {
    expect(shouldResubscribeTarget({ ...base, hasValue: false, msSinceSubscribed: 9_999 })).toBe(false);
  });
});

describe("noFirstValueResubscribeMs", () => {
  it("floors at 10 s so a fast sampling interval does not thrash", () => {
    expect(noFirstValueResubscribeMs(1)).toBe(10_000);
    expect(noFirstValueResubscribeMs(100)).toBe(10_000);
  });

  it("scales to fifty samples once that exceeds the floor", () => {
    expect(noFirstValueResubscribeMs(1_000)).toBe(50_000);
  });
});

describe("OpcuaNodeNotFoundError", () => {
  it("is the protocol-neutral NodeNotFoundError the reading loop shows as its own status (ferrion#902)", () => {
    expect(new OpcuaNodeNotFoundError("No namespace candidate serves node i=101260")).toBeInstanceOf(NodeNotFoundError);
  });
});

describe("parseModuleIndexFromBrowseName", () => {
  it("extracts the module index from a ModuleN browse name", () => {
    expect(parseModuleIndexFromBrowseName("2:Module3")).toBe(3);
    expect(parseModuleIndexFromBrowseName("0:Module1")).toBe(1);
    expect(parseModuleIndexFromBrowseName("2:Module20")).toBe(20);
  });

  it("returns null for a non-module browse name", () => {
    expect(parseModuleIndexFromBrowseName("2:Measurements")).toBeNull();
    expect(parseModuleIndexFromBrowseName("2:ModuleType")).toBeNull();
  });
});
