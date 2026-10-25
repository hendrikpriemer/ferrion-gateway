import { connect, type MqttClient } from "mqtt";
import type { Logger } from "../../logging/logger.js";
import { getByPath } from "../json-path.js";
import { ReconnectCooldown } from "../reconnect-cooldown.js";
import { SingleFlight } from "../single-flight.js";
import { isStale } from "../staleness.js";

export interface MqttConnectionConfig {
  brokerUrl: string;
  port: number;
  username?: string;
  password?: string;
}

export interface MqttReadTarget {
  topic: string;
  // Set when the device publishes a combined JSON object on this topic
  // rather than a bare number - confirmed live against a real SICK
  // FTMg/AVENTICS AF2 unit's "ProcessData Single" format
  // (https://www.sick.com, FTMg operating instructions ch. 9.4.4):
  // {"massFlowRate":0,...,"pressure":0,"timestamp":...}. Selects which
  // field of that object this target reads. Omitted for devices/simulators
  // that still publish one bare numeric value per topic (e.g. this repo's
  // own MQTT simulator, ../../drivers/simulated).
  //
  // May be a dotted path ("MassFlowRate.value") to reach into a nested
  // object - confirmed live against a second real AF2 unit (SCANIA-AF2-Montage,
  // 2026-08-21, topic under a "d/ITA_SDK/..." prefix) whose payload wraps
  // every metric as {value, unit, min, max, mean} instead of a flat number,
  // with PascalCase field names. See `jsonFieldFallbacks` below for how a
  // single target now covers both shapes.
  jsonField?: string;
  // Further dotted paths tried, in order, if `jsonField` isn't present on
  // an incoming message - same idea as OPC UA's namespaceUriFallbacks
  // (protocol/opcua/gateway-client.ts), just per-field instead of
  // per-namespace: a user creating a data source has no reliable way to
  // tell which firmware/payload shape their real unit uses before
  // connecting, so device-catalog/known-device-templates.ts's
  // "aventics-af2-mqtt" entry lists the known nested/PascalCase variant
  // here instead of requiring a second, separately-selectable catalog
  // entry (see extractJsonField()).
  jsonFieldFallbacks?: string[];
  // A real wire-level property of the *subscription* to this topic, not of
  // each target/message - mqtt.js defaults to 0 ("at most once") if
  // omitted, same as this. When several targets share one topic (see
  // targetsByTopic), whichever one first triggers the subscribe decides it
  // for all of them - every metric on one physical sensor is expected to
  // agree anyway, since ferrion's wizard captures qos once per
  // data-source-creation session, not per metric.
  qos?: 0 | 1 | 2;
}

function targetKey(target: MqttReadTarget): string {
  return `${target.topic} ${target.jsonField ?? ""}`;
}

// A cached value older than this is treated as "no value" (undefined)
// rather than replayed as if it were still live - see readCachedValue().
// MQTT devices publish on their own cadence (the real AF2 every 100 ms), so
// a value that has not been re-published for this long is a real gap.
const DEFAULT_STALE_AFTER_MS = 10_000;

// undefined (not thrown) on malformed JSON - handleMessage() below parses
// once per *message*, not once per target reading it, and needs to tell
// "not JSON at all" apart from "parsed fine, field extraction is up to the
// caller" so a single bad payload doesn't get reparsed on every target.
function parseJsonPayload(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// NaN (not undefined) on a missing/non-numeric field - so the caller's
// existing `Number.isFinite(value)` guard is the single place that decides
// whether a reading updates the cache, same as the plain-number path.
// `field` and each of `fallbacks` may be a dotted path (see
// MqttReadTarget.jsonField's doc comment) - getByPath() treats a dot-free
// field as a single plain lookup either way. Tries `field` first, then each
// fallback in order, same "first candidate that actually resolves wins"
// pattern as protocol/opcua/gateway-client.ts's resolveNamespaceIndex().
function extractJsonField(parsed: Record<string, unknown> | undefined, field: string, fallbacks: string[] = []): number {
  if (parsed === undefined) return NaN;
  for (const candidate of [field, ...fallbacks]) {
    const value = Number(getByPath(parsed, candidate));
    if (!Number.isNaN(value)) return value;
  }
  return NaN;
}

interface MonitoredTargetState {
  latestValue: number | undefined;
  latestValueAt: number | undefined;
}

// Protocol-generic: knows how to talk MQTT, nothing about which device or
// metric it's reading - the caller supplies broker connection details and a
// read target (topic + optional jsonField), same shape as
// protocol/opcua/gateway-client.ts. Unlike OPC UA/Modbus (request/response),
// MQTT is push-based - readCachedValue() returns whatever the device's own
// publisher last sent, not a fresh on-demand read.
export class MqttGatewayClient {
  private readonly connection: MqttConnectionConfig;
  private client: MqttClient | undefined;
  // Keyed by targetKey() - one shared connection per MqttGatewayClient (see
  // acquireMqttGatewayClient()), but a device can publish several metrics
  // (jsonFields) on the very same topic - the real AF2's "ProcessData
  // Single" format does exactly this (see MqttReadTarget's doc comment) -
  // so one incoming message updates every target registered against that
  // topic, not just one.
  private readonly monitoredTargets = new Map<string, MonitoredTargetState>();
  private readonly targetsByTopic = new Map<string, MqttReadTarget[]>();
  private readonly subscribedTopics = new Set<string>();
  // Remembered per topic so a later resubscribe (see resubscribeAll()) uses
  // the same QoS as the original subscribe, not always the 0 default.
  private readonly topicQos = new Map<string, 0 | 1 | 2>();
  private readonly logger: Logger | undefined;
  // Guards against overlapping connect attempts at a fast readIntervalMs -
  // see the identical, live-found issue in protocol/opcua/gateway-client.ts
  // and protocol/modbus/gateway-client.ts. SingleFlight (not just a shared
  // promise) also collapses a *failing* attempt's rejection down to one
  // report instead of one per overlapping caller - found live at a real
  // 1ms interval.
  private readonly connectGate = new SingleFlight<void>();
  // One gate per topic, not one shared gate for the whole client - a shared
  // SingleFlight would coalesce a concurrent ensureSubscribed() for a
  // second metric's topic into the first metric's already-in-flight
  // subscribe, silently never subscribing the second - see the identical
  // per-target gate map in protocol/opcua/gateway-client.ts.
  private readonly subscribeGates = new Map<string, SingleFlight<void>>();
  // The one protocol client that had no cooldown (review 2026-09, H-2):
  // with a broker that is down, every read tick started a fresh connect
  // attempt - at 1 ms hundreds per second - and each failed attempt's
  // mqtt.js client kept reconnecting on its own, forever (see
  // performConnect()).
  private readonly cooldown = new ReconnectCooldown();

  constructor(connection: MqttConnectionConfig, logger?: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    await this.connectGate.run(() => this.performConnect());
  }

  private async performConnect(): Promise<void> {
    const client = await new Promise<MqttClient>((resolve, reject) => {
      const c = connect(this.connection.brokerUrl, {
        port: this.connection.port,
        username: this.connection.username,
        password: this.connection.password,
      });
      // Both listeners removed on whichever fires first. On failure the
      // client is ended *with force*: mqtt.js otherwise keeps the orphan
      // alive and reconnecting every second (its reconnectPeriod default)
      // for the life of the process, one more per failed attempt - a
      // socket and memory leak plus a reconnect storm against the broker
      // the moment it comes back.
      const onConnect = () => {
        c.off("error", onError);
        resolve(c);
      };
      const onError = (error: Error) => {
        c.off("connect", onConnect);
        c.end(true);
        reject(error);
      };
      c.once("connect", onConnect);
      c.once("error", onError);
    });
    client.on("message", (topic, payload) => this.handleMessage(topic, payload));
    // mqtt.js defaults to a "clean session": the broker discards every
    // subscription on *any* disconnect, including mqtt.js's own automatic
    // reconnect after a network blip, not just this first connect - found
    // live while designing the shared-client registry above: nothing here
    // previously resubscribed after a reconnect, so a single network
    // hiccup would silently and permanently stop delivery for every metric
    // already subscribed, with no error or log anywhere, until the whole
    // container restarted. `on` (not `once`) so this also fires on every
    // later reconnect, not just the first connect this promise resolves.
    client.on("connect", () => this.resubscribeAll());
    this.client = client;
  }

  private resubscribeAll(): void {
    if (!this.client || this.subscribedTopics.size === 0) return;
    const client = this.client;
    for (const topic of this.subscribedTopics) {
      const qos = this.topicQos.get(topic) ?? 0;
      client.subscribe(topic, { qos }, (error) => {
        if (error) this.logger?.warn({ topic, error: error.message }, "MQTT resubscribe after reconnect failed");
      });
    }
  }

  private handleMessage(topic: string, payload: Buffer): void {
    const targets = this.targetsByTopic.get(topic);
    if (!targets) return;
    const raw = payload.toString();
    // Parsed at most once per *message*, not once per target reading this
    // topic - found live: the real AF2's 100ms native publish rate across
    // 4 sensors sharing one connection meant up to 160 redundant
    // JSON.parse() calls/sec for what was, per message, the exact same
    // payload every time. Lazy (only if at least one target actually wants
    // a jsonField) since a target with none just parses the raw string as
    // a number instead.
    const needsJson = targets.some((target) => target.jsonField !== undefined);
    const parsed = needsJson ? parseJsonPayload(raw) : undefined;
    const now = Date.now();
    for (const target of targets) {
      const value =
        target.jsonField !== undefined ? extractJsonField(parsed, target.jsonField, target.jsonFieldFallbacks) : Number(raw);
      // Finite only: "Infinity" and "NaN" are valid JSON-ish strings a
      // device could publish, and the platform drops non-finite readings
      // per entry - locally they must not count as a live value either.
      if (!Number.isFinite(value)) continue;
      const state = this.monitoredTargets.get(targetKey(target));
      if (!state) continue;
      state.latestValue = value;
      state.latestValueAt = now;
    }
  }

  // Registers this target (idempotent - a no-op once it's already tracked)
  // and subscribes its topic if this is the first target reading from it.
  // Safe to call repeatedly, including with a different target each time,
  // same contract as OpcuaGatewayClient.ensureSubscribed(). Silently a
  // no-op during the post-failure cooldown - the caller retries on its own
  // schedule, readCachedValue() reports "no value" meanwhile.
  async ensureSubscribed(target: MqttReadTarget): Promise<void> {
    const key = targetKey(target);
    if (!this.monitoredTargets.has(key)) {
      this.monitoredTargets.set(key, { latestValue: undefined, latestValueAt: undefined });
      const targets = this.targetsByTopic.get(target.topic) ?? [];
      targets.push(target);
      this.targetsByTopic.set(target.topic, targets);
    }
    if (!this.topicQos.has(target.topic)) {
      this.topicQos.set(target.topic, target.qos ?? 0);
    }
    if (this.subscribedTopics.has(target.topic)) return;
    if (!this.cooldown.canAttempt()) return;
    let gate = this.subscribeGates.get(target.topic);
    if (!gate) {
      gate = new SingleFlight<void>();
      this.subscribeGates.set(target.topic, gate);
    }
    await gate.run(() => this.performSubscribe(target.topic));
  }

  private async performSubscribe(topic: string): Promise<void> {
    try {
      await this.connect();
      const client = this.client as MqttClient;
      const qos = this.topicQos.get(topic) ?? 0;
      await new Promise<void>((resolve, reject) => {
        client.subscribe(topic, { qos }, (error) => (error ? reject(error) : resolve()));
      });
      this.subscribedTopics.add(topic);
      this.cooldown.reset();
    } catch (error) {
      this.cooldown.recordFailure();
      throw error;
    }
  }

  // undefined both while no message has arrived yet and once the last one
  // is older than DEFAULT_STALE_AFTER_MS - a broker/publisher outage should
  // read as an honest gap, not a frozen value replayed as if it were live.
  readCachedValue(target: MqttReadTarget): number | undefined {
    const state = this.monitoredTargets.get(targetKey(target));
    if (!state || state.latestValue === undefined) return undefined;
    if (isStale(state, Date.now(), DEFAULT_STALE_AFTER_MS)) return undefined;
    return state.latestValue;
  }

  async testConnection(): Promise<void> {
    await this.connect();
  }

  disconnect(): void {
    if (this.client) {
      this.client.end(true);
      this.client = undefined;
    }
  }
}

function connectionKey(connection: MqttConnectionConfig): string {
  return `${connection.brokerUrl}:${connection.port}`;
}

// Reference-counted registry so every data source reading from the same
// physical MQTT broker (same brokerUrl+port, e.g. every metric on one AF2
// unit sharing its "ProcessData Single" topic) shares a single
// MqttGatewayClient/connection instead of reading-loop.ts's per-data-source
// createDataSourceReader() each opening its own - found live: 4 sensors x 4
// metrics opened 16 separate TCP/MQTT connections to the same broker for
// what should have been 4, at roughly 8-10x the CPU of the equivalent
// OPC UA bridge (which already shares one session per device) despite
// fewer physical sensors. Mirrors
// protocol/opcua/gateway-client.ts's identical acquire/release pattern -
// see its own doc comment for why this is module-level, not per-ReadingLoop.
const sharedClients = new Map<string, { client: MqttGatewayClient; refCount: number }>();

// `logger` only takes effect for the first caller that acquires a given
// connection (later callers just get the already-constructed shared
// client) - acceptable since every data source on one gateway instance
// shares the same logger anyway. Mirrors acquireOpcuaGatewayClient()'s
// identical note.
export function acquireMqttGatewayClient(connection: MqttConnectionConfig, logger?: Logger): MqttGatewayClient {
  const key = connectionKey(connection);
  const existing = sharedClients.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing.client;
  }
  const client = new MqttGatewayClient(connection, logger);
  sharedClients.set(key, { client, refCount: 1 });
  return client;
}

// Only actually disconnects once every data source sharing this client has
// released it - releasing before that would drop the other data sources'
// subscriptions out from under them.
export function releaseMqttGatewayClient(connection: MqttConnectionConfig): void {
  const key = connectionKey(connection);
  const entry = sharedClients.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  sharedClients.delete(key);
  entry.client.disconnect();
}
