import type { DeviceTemplateId, Ports } from "../../config/schema.js";
import { getDeviceTemplate } from "../../device-catalog/known-device-templates.js";
import { setByPath } from "../../protocol/json-path.js";
// Type-only imports (erased at compile time, zero runtime cost) - the
// actual classes are loaded lazily below, per protocol.
import type { MqttSimulatorBroker } from "../../protocol/mqtt/broker.js";
import type { MqttDevicePublisher } from "../../protocol/mqtt/device-publisher.js";
import type { ModbusSimulatorServer } from "../../protocol/modbus/simulator-server.js";
import type { OpcuaSimulatorServer } from "../../protocol/opcua/simulator-server.js";
import { createAf2ValueGenerator } from "./devices/af2-values.js";
import { createDs1ValueGenerator } from "./devices/ds1-values.js";
import { createFdgValueGenerator } from "./devices/fdg-values.js";
import { createJanitzaUmg801ValueGenerator } from "./devices/janitza-umg801-values.js";
import { createPrng } from "./prng.js";

export interface DeviceSimulatorOptions {
  templateId: DeviceTemplateId;
  serialNumber: string;
  ports: Ports;
  tickIntervalMs?: number;
  seed?: number;
}

const DEFAULT_TICK_INTERVAL_MS = 2000;

// 127.0.0.1 only means "this same machine" outside a container - inside
// one, it means "this same container", which Docker's published ports
// can never reach regardless of port mapping. FG_BIND_HOST overrides this
// to 0.0.0.0 in docker-compose.yml so a simulated instance is actually
// reachable from outside the container; the default preserves today's
// local-machine-only behavior everywhere else.
function bindHost(): string {
  return process.env.FG_BIND_HOST ?? "127.0.0.1";
}

// The first full-fledged device driver (see the plan): starts a real local
// protocol server/broker for the chosen device template and periodically
// feeds it realistic, range-bounded values. Real hardware drivers arrive
// later as sibling folders behind the same protocol/*/gateway-client.ts
// interface - this file is the only part of the simulated driver that isn't
// reused by them.
//
// Each protocol module is imported lazily (only the one this particular
// instance's template actually needs) rather than all three eagerly at
// the top of the file - measured live (2026-08-16): importing node-opcua
// alone costs ~78Mi RSS on top of the Node/tsx baseline (~70Mi), while
// Modbus/MQTT cost almost nothing beyond it. Every forked instance process
// was paying node-opcua's weight before this change, even a pure Modbus
// or MQTT one that never touches it.
export class DeviceSimulator {
  private readonly options: DeviceSimulatorOptions;
  private readonly template: ReturnType<typeof getDeviceTemplate>;
  private timer: NodeJS.Timeout | undefined;
  private opcuaServer: OpcuaSimulatorServer | undefined;
  private modbusServer: ModbusSimulatorServer | undefined;
  private mqttBroker: MqttSimulatorBroker | undefined;
  private mqttPublisher: MqttDevicePublisher | undefined;

  constructor(options: DeviceSimulatorOptions) {
    this.options = options;
    this.template = getDeviceTemplate(options.templateId);
  }

  async start(): Promise<void> {
    const prng = createPrng(this.options.seed ?? Date.now());
    const generateValues = this.template.id.startsWith("aventics-af2")
      ? createAf2ValueGenerator(prng)
      : this.template.id.startsWith("keyence-fd-g")
        ? createFdgValueGenerator(prng)
        : this.template.id.startsWith("janitza-umg801")
          ? createJanitzaUmg801ValueGenerator(prng, {
              metricKeys: this.template.metrics.map((metric) => metric.metricKey),
              // The energy counter integrates power over exactly this tick.
              tickSeconds: (this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS) / 1000,
            })
          : createDs1ValueGenerator(prng);
    // Every generator returns exactly its own metric keys as numbers, so
    // treating any of them as Record<string, number> from here on is safe -
    // the consuming code below only ever looks values up by the catalog's
    // own metricKey and ignores keys it doesn't recognize.
    const nextValues = (): Record<string, number> => generateValues() as unknown as Record<string, number>;

    if (this.template.protocol === "OPC_UA") {
      await this.startOpcua(nextValues);
    } else if (this.template.protocol === "MODBUS_TCP") {
      await this.startModbus(nextValues);
    } else {
      await this.startMqtt(nextValues);
    }
  }

  private async startOpcua(nextValues: () => Record<string, number>): Promise<void> {
    const port = this.options.ports.opcua;
    if (!port) throw new Error(`Missing ports.opcua for device template "${this.template.id}"`);
    const namespaceUri = (this.template.namespaceUriTemplate ?? "").replace(
      "{serialNumber}",
      this.options.serialNumber,
    );

    const { OpcuaSimulatorServer } = await import("../../protocol/opcua/simulator-server.js");
    const server = new OpcuaSimulatorServer();
    await server.start(port, namespaceUri, bindHost());

    const initial = new Map(Object.entries(nextValues()));
    for (const metric of this.template.metrics) {
      if (metric.addressing.kind !== "opcua") continue;
      server.addVariable(metric.addressing.nodeIdentifier, metric.metricKey, initial.get(metric.metricKey) ?? 0);
    }

    this.opcuaServer = server;
    this.timer = setInterval(() => {
      const values = new Map(Object.entries(nextValues()));
      for (const metric of this.template.metrics) {
        if (metric.addressing.kind !== "opcua") continue;
        const value = values.get(metric.metricKey);
        if (value === undefined) continue;
        server.setValue(metric.addressing.nodeIdentifier, value);
      }
    }, this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  }

  private async startModbus(nextValues: () => Record<string, number>): Promise<void> {
    const port = this.options.ports.modbus;
    if (!port) throw new Error(`Missing ports.modbus for device template "${this.template.id}"`);

    const { ModbusSimulatorServer } = await import("../../protocol/modbus/simulator-server.js");
    const { RESOLUTION_MULTIPLIERS } = await import("../../protocol/modbus/gateway-client.js");
    const server = new ModbusSimulatorServer();
    await server.start(port, bindHost());

    // Simulates this device's own configured decimal resolution as a fixed
    // 0.001 (enum 0) - see gateway-client.ts's ModbusReadTarget.resolutionRegister
    // doc comment for why the real FD-G's own value is read-only, hence
    // static for the life of a connection. Written once here (not on every
    // tick), matching that same "essentially static" real-world behavior.
    for (const metric of this.template.metrics) {
      if (metric.addressing.kind !== "modbus" || metric.addressing.resolutionRegister === undefined) continue;
      server.setRegister(metric.addressing.resolutionRegister, 0);
    }

    const applyValues = (values: Record<string, number>) => {
      const byMetricKey = new Map(Object.entries(values));
      for (const metric of this.template.metrics) {
        if (metric.addressing.kind !== "modbus") continue;
        const value = byMetricKey.get(metric.metricKey);
        if (value === undefined) continue;
        const { register, byteOrder, format, resolutionRegister } = metric.addressing;
        if (format === "INT32" || format === "UINT32") {
          const multiplier = resolutionRegister !== undefined ? (RESOLUTION_MULTIPLIERS[0] ?? 0.001) : 1;
          const raw = Math.round(value / multiplier);
          if (format === "INT32") {
            server.setInt32(register, raw, byteOrder);
          } else {
            server.setUint32(register, raw, byteOrder);
          }
          continue;
        }
        server.setFloat32(register, value);
      }
    };

    applyValues(nextValues());
    this.modbusServer = server;
    this.timer = setInterval(() => applyValues(nextValues()), this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  }

  private async startMqtt(nextValues: () => Record<string, number>): Promise<void> {
    const port = this.options.ports.mqtt;
    if (!port) throw new Error(`Missing ports.mqtt for device template "${this.template.id}"`);

    const [{ MqttSimulatorBroker }, { MqttDevicePublisher }] = await Promise.all([
      import("../../protocol/mqtt/broker.js"),
      import("../../protocol/mqtt/device-publisher.js"),
    ]);
    const broker = new MqttSimulatorBroker();
    await broker.start(port, bindHost());
    // The publisher connects to the broker within the same process, so
    // loopback is always reachable here regardless of what bindHost()
    // returned (a 0.0.0.0-bound server still accepts loopback
    // connections).
    const publisher = new MqttDevicePublisher();
    await publisher.connect("mqtt://127.0.0.1", port);

    const publishValues = (values: Record<string, number>) => {
      const byMetricKey = new Map(Object.entries(values));
      // Metrics that share one topic via jsonField (the real AF2's
      // "ProcessData Single" format - see gateway-client.ts's
      // MqttConnectionConfig.jsonField) batch into one combined-JSON
      // publish per topic, matching what real hardware actually sends;
      // a metric with no jsonField still gets the old bare-number publish,
      // for any future device whose payload really is one scalar per topic.
      const jsonPayloadsByTopic = new Map<string, Record<string, number>>();
      for (const metric of this.template.metrics) {
        if (metric.addressing.kind !== "mqtt") continue;
        const value = byMetricKey.get(metric.metricKey);
        if (value === undefined) continue;
        const { topic, jsonField } = metric.addressing;
        if (jsonField === undefined) {
          publisher.publish(topic, value);
          continue;
        }
        const payload = jsonPayloadsByTopic.get(topic) ?? {};
        // jsonField may be a dotted path (see gateway-client.ts's
        // MqttReadTarget.jsonField doc comment) - setByPath() builds the
        // same nested {value, ...} shape a real ITA_SDK-style AF2 unit
        // sends, so a simulated instance of that template round-trips
        // correctly through the same read-side extraction.
        setByPath(payload, jsonField, value);
        jsonPayloadsByTopic.set(topic, payload);
      }
      for (const [topic, payload] of jsonPayloadsByTopic) {
        publisher.publishJson(topic, payload);
      }
    };

    publishValues(nextValues());
    this.mqttBroker = broker;
    this.mqttPublisher = publisher;
    this.timer = setInterval(() => publishValues(nextValues()), this.options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.opcuaServer) {
      await this.opcuaServer.stop();
      this.opcuaServer = undefined;
    }
    if (this.modbusServer) {
      await this.modbusServer.stop();
      this.modbusServer = undefined;
    }
    if (this.mqttPublisher) {
      this.mqttPublisher.disconnect();
      this.mqttPublisher = undefined;
    }
    if (this.mqttBroker) {
      await this.mqttBroker.stop();
      this.mqttBroker = undefined;
    }
  }
}
