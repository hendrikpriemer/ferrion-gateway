import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpcuaSimulatorServer } from "../protocol/opcua/simulator-server.js";
import type { DiscoveryResult } from "./discover-devices.js";
import { handleDiscoverDevices } from "./handle-discover-devices.js";
import { DISCOVERY_LIMIT_ENV, readDiscoveryLimit } from "./scan-request.js";

// End to end, real probe and real identification, against two simulators
// on the loopback: what the gateway reports to ferrion.
const AF2_PORT = 26851;
const UMG_PORT = 26852;
const LOOPBACK = readDiscoveryLimit({ [DISCOVERY_LIMIT_ENV]: "127.0.0.1/32" });

const af2 = new OpcuaSimulatorServer();
const umg = new OpcuaSimulatorServer();
beforeAll(async () => {
  await af2.start(AF2_PORT, "urn:AVENTICS:AF2:10000123");
  await umg.start(UMG_PORT, "https://opc.janitza.de/umg801/public", "127.0.0.1", { softwareVersion: "1.6.2" });
}, 30_000);
afterAll(async () => {
  await Promise.all([af2.stop(), umg.stop()]);
});

describe("handleDiscoverDevices", () => {
  it("finds both simulators and names each by its namespace", async () => {
    const outcome = await handleDiscoverDevices(
      {
        protocols: ["OPC_UA"],
        opcua: { hosts: ["127.0.0.1"], sweep: { cidrs: [], ports: [AF2_PORT, UMG_PORT, 26853] } },
        budgetMs: 10_000,
        knownEndpoints: [`127.0.0.1:${UMG_PORT}`],
      },
      LOOPBACK,
    );

    expect(outcome.status).toBe("COMPLETED");
    const result = outcome.result as DiscoveryResult;
    expect(result.candidates.map((candidate) => candidate.endpointUrl)).toEqual([
      `opc.tcp://127.0.0.1:${AF2_PORT}`,
      `opc.tcp://127.0.0.1:${UMG_PORT}`,
    ]);
    const [found, known] = result.candidates;
    expect(found?.namespaceUris).toContain("urn:AVENTICS:AF2:10000123");
    expect(found?.foundBy).toEqual(["host"]);
    // Already a data source: endpoints only, no second session at the device.
    expect(known?.sessionSkipped).toBe("known-data-source");
    expect(known?.namespaceUris).toBeNull();
    expect(result.scan).toMatchObject({ probed: 3, openPorts: 2, notOpcua: 0, truncated: false, limit: ["127.0.0.1/32"] });
  });

  it("refuses a request outside the limit without probing", async () => {
    const outcome = await handleDiscoverDevices({ protocols: ["OPC_UA"], opcua: { hosts: ["10.20.30.23"] } }, LOOPBACK);

    expect(outcome).toEqual({ status: "FAILED", result: { error: "outside gateway discovery limit: 10.20.30.23" } });
  });
});
