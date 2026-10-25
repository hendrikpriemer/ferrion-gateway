import { describe, expect, it, vi } from "vitest";
import { acquireModbusGatewayClient, releaseModbusGatewayClient } from "../protocol/modbus/gateway-client.js";
import { ModbusSimulatorServer } from "../protocol/modbus/simulator-server.js";
import { OpcuaGatewayClient } from "../protocol/opcua/gateway-client.js";
import { OpcuaSimulatorServer } from "../protocol/opcua/simulator-server.js";
import { handleCommand, handleTestConnection, resolveOpcuaNamespaceUri, resolveOpcuaNamespaceUriFallbacks } from "./command-handlers.js";

// Covers the templateId disambiguation fix: before it existed, every
// TEST_CONNECTION/BROWSE_DATA_POINTS command resolved AF2's namespace URI
// regardless of which OPC UA device was actually being tested - harmless
// while AF2 was the catalog's only OPC UA template, but silently wrong as
// soon as a second one (Janitza UMG801) was added, since testConnection()
// eagerly checks the resolved namespaceUri is registered on the server
// (gateway-client.ts's resolveNamespaceIndex()) and throws if not.
describe("handleCommand with a type this gateway does not know (R07)", () => {
  it("answers unsupported instead of running it as a browse", async () => {
    // Until R07 every type but TEST_CONNECTION ran as BROWSE_DATA_POINTS: an
    // older gateway would have browsed a device when ferrion asked it to scan.
    // DISCOVER_DEVICES itself never reaches here (command-loop.ts).
    const result = await handleCommand("SAMPLE_DATA_POINTS" as never, { protocol: "OPC_UA", connectionValues: {} });

    expect(result).toEqual({ status: "FAILED", result: { error: "unsupported command: SAMPLE_DATA_POINTS" } });
  });
});

describe("resolveOpcuaNamespaceUri / resolveOpcuaNamespaceUriFallbacks", () => {
  it("resolves AF2's namespace URI (with serialNumber substituted) and its fallbacks when templateId names AF2", () => {
    expect(resolveOpcuaNamespaceUri({ templateId: "aventics-af2-opcua" }, "10000123")).toBe(
      "urn:AVENTICS:AF2:10000123"
    );
    expect(resolveOpcuaNamespaceUriFallbacks({ templateId: "aventics-af2-opcua" }, "10000123")).toEqual([
      "urn:AVENTICS:AF2::10000123",
      "http://emerson.com/Flowmeter/AF2/Instance/",
    ]);
  });

  it("falls back to AF2 when templateId is absent, matching the pre-templateId behavior for manual/custom connections", () => {
    expect(resolveOpcuaNamespaceUri({}, "10000123")).toBe("urn:AVENTICS:AF2:10000123");
    expect(resolveOpcuaNamespaceUriFallbacks({}, "10000123")).toHaveLength(2);
  });

  it("falls back to AF2 when templateId names an id this gateway doesn't recognize (version skew)", () => {
    expect(resolveOpcuaNamespaceUri({ templateId: "some-future-device" }, "10000123")).toBe(
      "urn:AVENTICS:AF2:10000123"
    );
  });

  it("resolves Janitza UMG801's fixed namespace URI with no fallbacks when templateId names it", () => {
    expect(resolveOpcuaNamespaceUri({ templateId: "janitza-umg801-opcua" }, "")).toBe(
      "https://opc.janitza.de/umg801/public"
    );
    expect(resolveOpcuaNamespaceUriFallbacks({ templateId: "janitza-umg801-opcua" }, "")).toEqual([]);
  });
});

// Port outside the simulator range and distinct from gateway-client.test.ts's
// 15020, since vitest may run both files in parallel.
const MODBUS_PORT = 15030;

describe("handleTestConnection (Modbus TCP) against a device that accepts only one connection", () => {
  const payload = {
    protocol: "MODBUS_TCP" as const,
    templateId: "aventics-ds1-modbus-tcp",
    connectionValues: { host: "127.0.0.1", port: String(MODBUS_PORT) },
  };

  it("succeeds while data sources are already reading the device - found live on a DS1 refusing a second client", async () => {
    const server = new ModbusSimulatorServer();
    server.limitConnections(1);
    await server.start(MODBUS_PORT);
    server.setFloat32(1000, 23.5);
    const connection = { host: "127.0.0.1", port: MODBUS_PORT };
    const reader = acquireModbusGatewayClient(connection);
    try {
      await expect(reader.read({ register: 1000, registerCount: 2, byteOrder: "BIG_ENDIAN" })).resolves.toBe(23.5);

      await expect(handleTestConnection(payload)).resolves.toEqual({ status: "COMPLETED", result: { ok: true } });
      await expect(reader.read({ register: 1000, registerCount: 2, byteOrder: "BIG_ENDIAN" })).resolves.toBe(23.5);
    } finally {
      releaseModbusGatewayClient(connection);
      await server.stop();
    }
  });

  it("closes its connection afterwards when nothing else reads the device", async () => {
    const server = new ModbusSimulatorServer();
    server.limitConnections(1);
    await server.start(MODBUS_PORT);
    try {
      await expect(handleTestConnection(payload)).resolves.toEqual({ status: "COMPLETED", result: { ok: true } });
      // The single slot must be free again for the next client.
      await vi.waitFor(async () => expect(await server.connectionCount()).toBe(0), { timeout: 2000 });
    } finally {
      await server.stop();
    }
  });
});

describe("handleTestConnection reports an OPC UA device's firmware (ferrion#902)", () => {
  // Janitza renumbered the UMG 801's node ids between firmware 1.5.x and
  // 1.6.x; ferrion refuses an older device with this version.
  const OPCUA_PORT = 24851;
  const payload = {
    protocol: "OPC_UA" as const,
    templateId: "janitza-umg801-opcua",
    connectionValues: { host: "127.0.0.1", port: String(OPCUA_PORT) },
  };

  async function withDevice<T>(run: () => Promise<T>): Promise<T> {
    const server = new OpcuaSimulatorServer();
    await server.start(OPCUA_PORT, "https://opc.janitza.de/umg801/public", "127.0.0.1", { softwareVersion: "1.5.2+1c931b83.231006103238.b636" });
    // The current-group lookup is HTTP and has no simulator; failing it here
    // keeps this test about the firmware.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no web interface in the simulator"); }));
    try {
      return await run();
    } finally {
      vi.unstubAllGlobals();
      await server.stop();
    }
  }

  it("passes the firmware version on with the successful test", async () => {
    const result = await withDevice(() => handleTestConnection(payload));

    expect(result).toMatchObject({ status: "COMPLETED", result: { ok: true, softwareVersion: "1.5.2+1c931b83.231006103238.b636" } });
  }, 30_000);

  it("still passes the test when the version cannot be read, and then leaves it out", async () => {
    const spy = vi.spyOn(OpcuaGatewayClient.prototype, "readSoftwareVersion").mockRejectedValue(new Error("BadNodeIdUnknown"));
    try {
      const result = await withDevice(() => handleTestConnection(payload));

      expect(result).toMatchObject({ status: "COMPLETED", result: { ok: true } });
      expect((result.result as Record<string, unknown>).softwareVersion).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe("handleTestConnection asks a UMG 801 for its current groups", () => {
  /**
   * The names of the outgoing circuits live only on the device's web
   * interface, and the catalogue offered 308 register checkboxes instead.
   * This is the lookup that turns those into "Kompressor HD1".
   *
   * Driven against a real Modbus simulator so the connection test itself is
   * genuine; only the HTTP lookup is stubbed, because that is the part with
   * no simulator.
   */
  const MODBUS_PORT = 15502;
  const payload = {
    protocol: "MODBUS_TCP" as const,
    templateId: "janitza-umg801-modbus-tcp",
    connectionValues: { host: "127.0.0.1", port: String(MODBUS_PORT) },
  };

  async function withDevice<T>(run: () => Promise<T>): Promise<T> {
    const server = new ModbusSimulatorServer();
    await server.start(MODBUS_PORT);
    try {
      return await run();
    } finally {
      await server.stop();
    }
  }

  it("reports the groups the device names", async () => {
    const structure = [{ physPos: 0, type: "UMG801/5A", numCurrentGroups: 2, state: "active" }];
    const groups = { D0: { IG1: { name: "Kompressor ND1" }, IG2: { name: "" } } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith("/currentGroup") ? groups : structure),
      }))
    );

    const result = await withDevice(() => handleTestConnection(payload));

    expect(result).toEqual({
      status: "COMPLETED",
      result: {
        ok: true,
        discoveredCurrentGroups: [
          { device: 0, group: 1, name: "Kompressor ND1", moduleType: "UMG801/5A" },
          { device: 0, group: 2, name: null, moduleType: "UMG801/5A" },
        ],
      },
    });
    vi.unstubAllGlobals();
  });

  it("says the lookup was unavailable instead of pretending there are no groups", async () => {
    // Older firmware, port 80 closed, authentication demanded - all land
    // here. "Could not ask" and "has none" must not look the same.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));

    const result = await withDevice(() => handleTestConnection(payload));

    expect(result).toEqual({
      status: "COMPLETED",
      result: { ok: true, currentGroupDiscovery: "unavailable" },
    });
    vi.unstubAllGlobals();
  });

  it("never fails the connection test because of the lookup", async () => {
    // The device answered Modbus; that is what the test is about.
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));

    const result = await withDevice(() => handleTestConnection(payload));

    expect(result.status).toBe("COMPLETED");
    vi.unstubAllGlobals();
  });

  it("asks nothing of a device that is not a UMG 801", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await withDevice(() =>
      handleTestConnection({ ...payload, templateId: "aventics-ds1-modbus-tcp" })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
