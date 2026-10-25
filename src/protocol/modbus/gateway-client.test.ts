import { afterEach, describe, expect, it } from "vitest";
import { ModbusSimulatorServer } from "./simulator-server.js";
import { acquireModbusGatewayClient, ModbusGatewayClient, releaseModbusGatewayClient } from "./gateway-client.js";

// A distinctive, fixed port well outside the simulator's own 5502-5512
// range - this test runs its own throwaway server, never a simulated
// instance's, so there's nothing to collide with.
const TEST_PORT = 15020;
const CONNECTION = { host: "127.0.0.1", port: TEST_PORT };

function target(register: number) {
  return { register, registerCount: 2 as const, byteOrder: "BIG_ENDIAN" as const };
}

describe("ModbusGatewayClient", () => {
  let server: ModbusSimulatorServer | undefined;
  let client: ModbusGatewayClient | undefined;

  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
    server = undefined;
    client = undefined;
  });

  it("reads a float32 value from its configured register", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setFloat32(1000, 23.5);

    client = new ModbusGatewayClient(CONNECTION);
    await expect(client.read(target(1000))).resolves.toBe(23.5);
  });

  it("testConnection() succeeds when register 0 holds a real value", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);

    client = new ModbusGatewayClient(CONNECTION);
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("testConnection() still succeeds when the device rejects register 0 with a genuine Modbus exception - found live against a real DS1 unit", async () => {
    server = new ModbusSimulatorServer();
    server.rejectAddress(0);
    await server.start(TEST_PORT);

    client = new ModbusGatewayClient(CONNECTION);
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("reads several targets sharing one client without mismatching their values", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    // .5-fraction values only, so they round-trip through float32 exactly -
    // see float32.test.ts's own convention for exact-equality fixtures.
    server.setFloat32(1000, 23.5);
    server.setFloat32(1004, 55.5);
    server.setFloat32(1006, 12.5);

    client = new ModbusGatewayClient(CONNECTION);
    // Fired concurrently (not awaited one at a time) - the whole point of
    // the shared SerialQueue is that this is safe even though it's one
    // physical connection underneath.
    const [temperature, humidity, dewPoint] = await Promise.all([
      client.read(target(1000)),
      client.read(target(1004)),
      client.read(target(1006)),
    ]);

    expect(temperature).toBe(23.5);
    expect(humidity).toBe(55.5);
    expect(dewPoint).toBe(12.5);
  });

  it("reads a WORD_SWAPPED INT32 value, matching the KEYENCE FD-G's own word order", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setInt32(4, -12345, "WORD_SWAPPED");

    client = new ModbusGatewayClient(CONNECTION);
    await expect(
      client.read({ register: 4, registerCount: 2, byteOrder: "WORD_SWAPPED", format: "INT32" }),
    ).resolves.toBe(-12345);
  });

  it("reads a WORD_SWAPPED UINT32 value", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setUint32(10, 123456789, "WORD_SWAPPED");

    client = new ModbusGatewayClient(CONNECTION);
    await expect(
      client.read({ register: 10, registerCount: 2, byteOrder: "WORD_SWAPPED", format: "UINT32" }),
    ).resolves.toBe(123456789);
  });

  it("scales a raw INT32 by the resolutionRegister's enum multiplier (0 -> 0.001, per the FD-G's own Durchflussauflösung register)", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setInt32(4, 26436, "WORD_SWAPPED");
    server.setRegister(25, 0);

    client = new ModbusGatewayClient(CONNECTION);
    await expect(
      client.read({
        register: 4,
        registerCount: 2,
        byteOrder: "WORD_SWAPPED",
        format: "INT32",
        resolutionRegister: 25,
      }),
    ).resolves.toBeCloseTo(26.436, 5);
  });

  it("caches the resolutionRegister's value instead of re-reading it every call", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setInt32(4, 1000, "WORD_SWAPPED");
    server.setRegister(25, 2); // 0.1 multiplier

    client = new ModbusGatewayClient(CONNECTION);
    const readTarget = {
      register: 4,
      registerCount: 2,
      byteOrder: "WORD_SWAPPED" as const,
      format: "INT32" as const,
      resolutionRegister: 25,
    };
    await expect(client.read(readTarget)).resolves.toBeCloseTo(100, 5);

    // Changing the device's resolution register after the first read must
    // NOT affect a later read within the same connection - it's cached,
    // not re-fetched every tick (see gateway-client.ts's resolutionCache).
    server.setRegister(25, 0);
    await expect(client.read(readTarget)).resolves.toBeCloseTo(100, 5);
  });

  it("rejects a FLOAT32 target combined with WORD_SWAPPED - only DS1's own BIG_ENDIAN float32 is supported", async () => {
    server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);

    client = new ModbusGatewayClient(CONNECTION);
    await expect(
      client.read({ register: 1000, registerCount: 2, byteOrder: "WORD_SWAPPED", format: "FLOAT32" }),
    ).rejects.toThrow(/FLOAT32 only supports byteOrder BIG_ENDIAN/);
  });
});

describe("acquireModbusGatewayClient / releaseModbusGatewayClient", () => {
  afterEach(() => {
    // Best-effort cleanup in case a test fails before its own release -
    // avoids leaking a shared client (and its live connection) into a
    // later test in this file.
    releaseModbusGatewayClient(CONNECTION);
  });

  it("returns the same client instance for the same host+port, reference-counted", async () => {
    const server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    try {
      const clientA = acquireModbusGatewayClient(CONNECTION);
      const clientB = acquireModbusGatewayClient(CONNECTION);
      expect(clientB).toBe(clientA);

      releaseModbusGatewayClient(CONNECTION);
      // Still referenced once (by clientB's acquire) - the underlying
      // connection must not have been torn down yet.
      const clientC = acquireModbusGatewayClient(CONNECTION);
      expect(clientC).toBe(clientA);
      releaseModbusGatewayClient(CONNECTION);
      releaseModbusGatewayClient(CONNECTION);
    } finally {
      await server.stop();
    }
  });

  it("lets several metrics on one physical device share a single connection", async () => {
    const server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    server.setFloat32(1000, 23.5);
    server.setFloat32(1004, 55.5);
    try {
      const temperatureClient = acquireModbusGatewayClient(CONNECTION);
      const humidityClient = acquireModbusGatewayClient(CONNECTION);
      expect(humidityClient).toBe(temperatureClient);

      const [temperature, humidity] = await Promise.all([
        temperatureClient.read(target(1000)),
        humidityClient.read(target(1004)),
      ]);
      expect(temperature).toBe(23.5);
      expect(humidity).toBe(55.5);

      releaseModbusGatewayClient(CONNECTION);
      releaseModbusGatewayClient(CONNECTION);
    } finally {
      await server.stop();
    }
  });

  it("reports a float32 NaN pattern as 'no value' rather than a reading, and recovers once the register is sane again", async () => {
    const server = new ModbusSimulatorServer();
    await server.start(TEST_PORT);
    const client = new ModbusGatewayClient(CONNECTION);
    try {
      server.setFloat32(1000, Number.NaN);
      await expect(client.read(target(1000))).resolves.toBeUndefined();

      server.setFloat32(1000, 42);
      await expect(client.read(target(1000))).resolves.toBe(42);
    } finally {
      client.disconnect();
      await server.stop();
    }
  });

  describe("on a device that accepts only one connection", () => {
    it("a second, separate client cannot test the connection while a reader holds it", async () => {
      const server = new ModbusSimulatorServer();
      server.limitConnections(1);
      await server.start(TEST_PORT);
      server.setFloat32(1000, 23.5);
      const reader = acquireModbusGatewayClient(CONNECTION);
      const separate = new ModbusGatewayClient(CONNECTION);
      try {
        await expect(reader.read(target(1000))).resolves.toBe(23.5);
        await expect(separate.testConnection()).rejects.toThrow();
      } finally {
        separate.disconnect();
        releaseModbusGatewayClient(CONNECTION);
        await server.stop();
      }
    });

    it("testConnection() on the shared client reuses the reader's connection, and reads keep working afterwards", async () => {
      const server = new ModbusSimulatorServer();
      server.limitConnections(1);
      await server.start(TEST_PORT);
      server.setFloat32(1000, 23.5);
      const reader = acquireModbusGatewayClient(CONNECTION);
      try {
        await expect(reader.read(target(1000))).resolves.toBe(23.5);

        const tester = acquireModbusGatewayClient(CONNECTION);
        expect(tester).toBe(reader);
        // Concurrently with a read - both go through the one serial queue.
        await expect(Promise.all([tester.testConnection(), reader.read(target(1000))])).resolves.toEqual([undefined, 23.5]);
        releaseModbusGatewayClient(CONNECTION);

        await expect(reader.read(target(1000))).resolves.toBe(23.5);
      } finally {
        releaseModbusGatewayClient(CONNECTION);
        await server.stop();
      }
    });
  });

  it("disconnect() is safe before any connect and after a failed read", async () => {
    // Nothing listening on this port - the connect fails fast.
    const client = new ModbusGatewayClient({ host: "127.0.0.1", port: 15021 });
    expect(() => client.disconnect()).not.toThrow();
    await expect(client.read(target(1000))).rejects.toThrow();
    expect(() => client.disconnect()).not.toThrow();
  });
});
