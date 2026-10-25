import { afterEach, describe, expect, it, vi } from "vitest";
import type { MqttClient } from "mqtt";
import { MqttSimulatorBroker } from "./broker.js";
import { MqttDevicePublisher } from "./device-publisher.js";
import { acquireMqttGatewayClient, MqttGatewayClient, releaseMqttGatewayClient } from "./gateway-client.js";

// MqttGatewayClient doesn't expose its underlying mqtt.js client - these
// two tests need it directly (to spy on subscribe(), and to simulate
// mqtt.js's own reconnect firing "connect" again without actually killing
// the TCP connection), so they reach past the private field the same way
// the codebase already does elsewhere for exactly this kind of thing.
function underlyingMqttClient(client: MqttGatewayClient): MqttClient {
  return (client as unknown as { client: MqttClient }).client;
}

// A distinctive, fixed port well outside the simulator's own 1883-1893
// range - this test runs its own throwaway broker, never a simulated
// instance's, so there's nothing to collide with.
const TEST_PORT = 18830;
const CONNECTION = { brokerUrl: "mqtt://127.0.0.1", port: TEST_PORT };

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MqttGatewayClient", () => {
  let broker: MqttSimulatorBroker | undefined;
  let publisher: MqttDevicePublisher | undefined;
  let client: MqttGatewayClient | undefined;

  afterEach(async () => {
    client?.disconnect();
    publisher?.disconnect();
    await broker?.stop();
    broker = undefined;
    publisher = undefined;
    client = undefined;
  });

  it("reads a bare numeric payload when no jsonField is configured (existing simulator behavior)", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const target = { topic: "af2/processdata/temperature" };
    await client.ensureSubscribed(target);
    publisher.publish(target.topic, 21.5);

    await waitUntil(() => client!.readCachedValue(target) !== undefined);
    expect(client.readCachedValue(target)).toBe(21.5);
  });

  it("extracts one field from a combined JSON payload when jsonField is configured (real AF2 'Single' format)", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const temperatureTarget = { topic: "af2/processdata", jsonField: "temperature" };
    const pressureTarget = { topic: "af2/processdata", jsonField: "pressure" };
    await client.ensureSubscribed(temperatureTarget);
    await client.ensureSubscribed(pressureTarget);

    publisher.publishJson("af2/processdata", { massFlowRate: 0, temperature: 39.4, pressure: 11.62 });

    await waitUntil(() => client!.readCachedValue(temperatureTarget) !== undefined);
    expect(client.readCachedValue(temperatureTarget)).toBe(39.4);
    expect(client.readCachedValue(pressureTarget)).toBe(11.62);
  });

  it("extracts a nested field via a dotted jsonField path (ITA_SDK AF2 payload variant)", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const massFlowTarget = { topic: "af2/processdata", jsonField: "MassFlowRate.value" };
    const pressureTarget = { topic: "af2/processdata", jsonField: "Pressure.value" };
    await client.ensureSubscribed(massFlowTarget);
    await client.ensureSubscribed(pressureTarget);

    publisher.publishJson("af2/processdata", {
      MassFlowRate: { value: 1.91, unit: "kg/h", max: 137.41, mean: 2.11, min: 0 },
      Pressure: { value: 11.7, unit: "bar", max: 13.84, mean: 11.82, min: 0 },
      systemFailure: false,
      timestamp: 1157354029,
    });

    await waitUntil(() => client!.readCachedValue(massFlowTarget) !== undefined);
    expect(client.readCachedValue(massFlowTarget)).toBe(1.91);
    expect(client.readCachedValue(pressureTarget)).toBe(11.7);
  });

  it("ignores a message whose jsonField is missing or the payload isn't JSON, without crashing", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const target = { topic: "af2/processdata", jsonField: "temperature" };
    await client.ensureSubscribed(target);

    publisher.publish("af2/processdata", 42); // not JSON at all
    publisher.publishJson("af2/processdata", { massFlowRate: 0 }); // JSON, but no "temperature" field

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.readCachedValue(target)).toBeUndefined();
  });

  it("falls back to jsonFieldFallbacks when the primary jsonField isn't present (older-firmware AF2 payload shape merged into one template)", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const massFlowTarget = {
      topic: "af2/processdata",
      jsonField: "massFlowRate",
      jsonFieldFallbacks: ["MassFlowRate.value"],
    };
    const pressureTarget = { topic: "af2/processdata", jsonField: "pressure", jsonFieldFallbacks: ["Pressure.value"] };
    await client.ensureSubscribed(massFlowTarget);
    await client.ensureSubscribed(pressureTarget);

    // Older firmware's nested shape - no flat "massFlowRate"/"pressure" fields at all.
    publisher.publishJson("af2/processdata", {
      MassFlowRate: { value: 1.91, unit: "kg/h", max: 137.41, mean: 2.11, min: 0 },
      Pressure: { value: 11.7, unit: "bar", max: 13.84, mean: 11.82, min: 0 },
      systemFailure: false,
      timestamp: 1157354029,
    });

    await waitUntil(() => client!.readCachedValue(massFlowTarget) !== undefined);
    expect(client.readCachedValue(massFlowTarget)).toBe(1.91);
    expect(client.readCachedValue(pressureTarget)).toBe(11.7);
  });

  it("prefers the primary jsonField over jsonFieldFallbacks when the primary field is present", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const target = { topic: "af2/processdata", jsonField: "pressure", jsonFieldFallbacks: ["Pressure.value"] };
    await client.ensureSubscribed(target);

    publisher.publishJson("af2/processdata", { pressure: 11.62, Pressure: { value: 999 } });

    await waitUntil(() => client!.readCachedValue(target) !== undefined);
    expect(client.readCachedValue(target)).toBe(11.62);
  });

  it("stays undefined when neither the primary jsonField nor any jsonFieldFallbacks resolve", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const target = { topic: "af2/processdata", jsonField: "pressure", jsonFieldFallbacks: ["Pressure.value"] };
    await client.ensureSubscribed(target);

    publisher.publishJson("af2/processdata", { massFlowRate: 0 });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.readCachedValue(target)).toBeUndefined();
  });

  it("updates every target registered on a topic from a single incoming message, even when they were subscribed separately", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const temperatureTarget = { topic: "af2/processdata", jsonField: "temperature" };
    const pressureTarget = { topic: "af2/processdata", jsonField: "pressure" };
    await client.ensureSubscribed(temperatureTarget);
    await client.ensureSubscribed(pressureTarget);

    publisher.publishJson("af2/processdata", { temperature: 39.4, pressure: 11.62 });

    await waitUntil(() => client!.readCachedValue(temperatureTarget) !== undefined);
    expect(client.readCachedValue(temperatureTarget)).toBe(39.4);
    expect(client.readCachedValue(pressureTarget)).toBe(11.62);
  });

  it("passes the target's configured QoS to the broker subscription, defaulting to 0 when omitted", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    client = new MqttGatewayClient(CONNECTION);
    await client.connect();

    const subscribeSpy = vi.spyOn(underlyingMqttClient(client), "subscribe");
    await client.ensureSubscribed({ topic: "af2/processdata", qos: 1 });

    expect(subscribeSpy).toHaveBeenCalledWith("af2/processdata", { qos: 1 }, expect.any(Function));
  });

  it("resubscribes every previously-subscribed topic when mqtt.js reconnects, so a network blip doesn't silently kill delivery", async () => {
    broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);

    client = new MqttGatewayClient(CONNECTION);
    const target = { topic: "af2/processdata", jsonField: "temperature" };
    await client.ensureSubscribed(target);

    const mqttClient = underlyingMqttClient(client);
    const subscribeSpy = vi.spyOn(mqttClient, "subscribe");
    // Simulates what mqtt.js does internally after a real network blip
    // (its own reconnect logic re-fires "connect") without needing to
    // actually kill this test's TCP connection to exercise it.
    mqttClient.emit("connect", { cmd: "connack", sessionPresent: false } as never);

    await waitUntil(() => subscribeSpy.mock.calls.length > 0);
    expect(subscribeSpy).toHaveBeenCalledWith("af2/processdata", { qos: 0 }, expect.any(Function));

    // And delivery genuinely still works afterward, not just "subscribe was
    // called again" - resubscribing to the wrong thing would pass the
    // assertion above but still leave the sensor stale.
    publisher.publishJson("af2/processdata", { temperature: 21.1 });
    await waitUntil(() => client!.readCachedValue(target) !== undefined);
    expect(client.readCachedValue(target)).toBe(21.1);
  });
});

describe("acquireMqttGatewayClient / releaseMqttGatewayClient", () => {
  afterEach(() => {
    // Best-effort cleanup in case a test fails before its own release -
    // avoids leaking a shared client (and its live broker connection) into
    // a later test in this file.
    releaseMqttGatewayClient(CONNECTION);
  });

  it("returns the same client instance for the same broker+port, reference-counted", async () => {
    const broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    try {
      const clientA = acquireMqttGatewayClient(CONNECTION);
      const clientB = acquireMqttGatewayClient(CONNECTION);
      expect(clientB).toBe(clientA);

      releaseMqttGatewayClient(CONNECTION);
      // Still referenced once (by clientB's acquire) - the underlying
      // connection must not have been torn down yet.
      const clientC = acquireMqttGatewayClient(CONNECTION);
      expect(clientC).toBe(clientA);
      releaseMqttGatewayClient(CONNECTION);
      releaseMqttGatewayClient(CONNECTION);
    } finally {
      await broker.stop();
    }
  });

  it("lets several metrics on one physical sensor share a single broker connection", async () => {
    const broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    const publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);
    try {
      const massFlowClient = acquireMqttGatewayClient(CONNECTION);
      const temperatureClient = acquireMqttGatewayClient(CONNECTION);
      const pressureClient = acquireMqttGatewayClient(CONNECTION);
      expect(temperatureClient).toBe(massFlowClient);
      expect(pressureClient).toBe(massFlowClient);

      const massFlowTarget = { topic: "af2/processdata", jsonField: "massFlowRate" };
      const temperatureTarget = { topic: "af2/processdata", jsonField: "temperature" };
      const pressureTarget = { topic: "af2/processdata", jsonField: "pressure" };
      await massFlowClient.ensureSubscribed(massFlowTarget);
      await temperatureClient.ensureSubscribed(temperatureTarget);
      await pressureClient.ensureSubscribed(pressureTarget);

      publisher.publishJson("af2/processdata", { massFlowRate: 12.3, temperature: 39.4, pressure: 11.62 });

      await waitUntil(() => massFlowClient.readCachedValue(massFlowTarget) !== undefined);
      expect(massFlowClient.readCachedValue(massFlowTarget)).toBe(12.3);
      expect(temperatureClient.readCachedValue(temperatureTarget)).toBe(39.4);
      expect(pressureClient.readCachedValue(pressureTarget)).toBe(11.62);

      releaseMqttGatewayClient(CONNECTION);
      releaseMqttGatewayClient(CONNECTION);
      releaseMqttGatewayClient(CONNECTION);
    } finally {
      publisher.disconnect();
      await broker.stop();
    }
  });

  it("ends the mqtt.js client of a failed first connect and backs off instead of retrying every tick (review H-2)", async () => {
    // No broker on this port: the connect is refused outright.
    const client = new MqttGatewayClient({ brokerUrl: "mqtt://127.0.0.1", port: 18831 });
    const target = { topic: "af2/processdata/temperature" };
    try {
      await expect(client.ensureSubscribed(target)).rejects.toThrow();
      // Nothing is kept around to reconnect on its own.
      expect(underlyingMqttClient(client)).toBeUndefined();

      // Inside the cooldown the next ticks are silent no-ops, not new connects.
      await expect(client.ensureSubscribed(target)).resolves.toBeUndefined();
      await expect(client.ensureSubscribed(target)).resolves.toBeUndefined();
      expect(client.readCachedValue(target)).toBeUndefined();
    } finally {
      client.disconnect();
    }
  });

  it("ignores a payload that is not a finite number", async () => {
    const broker = new MqttSimulatorBroker();
    await broker.start(TEST_PORT);
    const publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", TEST_PORT);
    const client = new MqttGatewayClient(CONNECTION);
    try {
      const target = { topic: "af2/processdata/temperature" };
      await client.ensureSubscribed(target);
      publisher.publish(target.topic, Number.NaN);
      publisher.publish(target.topic, Number.POSITIVE_INFINITY);
      publisher.publish(target.topic, 21.5);

      await waitUntil(() => client.readCachedValue(target) !== undefined);
      expect(client.readCachedValue(target)).toBe(21.5);
    } finally {
      client.disconnect();
      publisher.disconnect();
      await broker.stop();
    }
  });
});
