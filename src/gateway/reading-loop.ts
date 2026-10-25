import type { AggregationStrategy } from "../config/schema.js";
import type { GatewayApi } from "../ferrion-client/gateway-api.js";
import { GatewayApiError } from "../ferrion-client/http-client.js";
import type { GatewayDataSource } from "../ferrion-client/types.js";
import type { Logger } from "../logging/logger.js";
import { errorMessage } from "../util/error-message.js";
import { NodeNotFoundError } from "../protocol/node-not-found-error.js";
import { ReadingAggregator } from "./reading-aggregator.js";
import { ReadingBuffer } from "./reading-buffer.js";
import type { ReadingBufferStore } from "./reading-buffer-store.js";

// ferrion's connectionConfig is a JSON bag - a string field that arrives as
// something else is a data-source configuration bug, but not one that
// should turn into "[object Object]" as a username on the wire.
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// Key order as ferrion sends it - a reorder would count as a change and
// cost one needless reconnect, never a missed one.
function configKeyOf(dataSource: GatewayDataSource): string {
  return `${dataSource.protocol}|${JSON.stringify(dataSource.connectionConfig)}`;
}

export interface DataSourceReader {
  // undefined means "no value available yet" (e.g. an MQTT topic that
  // hasn't published since we subscribed) - not an error.
  read(): Promise<number | undefined>;
  stop(): Promise<void>;
}

// Builds the real protocol-specific reader for one data source directly
// from ferrion's own fully-resolved connectionConfig (see
// ferrion-client/types.ts's GatewayDataSource) - no device-catalog lookup
// needed, ferrion already did that resolution server-side. Each protocol's
// gateway-client is imported lazily, only for the protocol actually in
// use (see device-simulator.ts's comment on why: node-opcua alone costs
// ~78Mi RSS beyond the Node/tsx baseline, and every data source used to
// pull it in regardless of protocol).
export interface CreateDataSourceReaderOptions {
  // OPC UA uses this as its monitored item's samplingInterval (see
  // protocol/opcua/gateway-client.ts's ensureSubscribed) - the server does the
  // sampling, the reader here just returns whatever the subscription's change
  // handler cached most recently, the same "subscribe once, read from cache"
  // shape MQTT already used below.
  readIntervalMs?: number;
  // So every protocol client can log through the same logger as the rest
  // of this instance instead of failing invisibly.
  logger?: Logger;
}

export async function createDataSourceReader(
  dataSource: GatewayDataSource,
  options: CreateDataSourceReaderOptions = {},
): Promise<DataSourceReader> {
  const config = dataSource.connectionConfig;

  if (dataSource.protocol === "OPC_UA") {
    const { acquireOpcuaGatewayClient, releaseOpcuaGatewayClient } = await import("../protocol/opcua/gateway-client.js");
    const namespaceUri = String(config.namespaceUri);
    // Optional: only the AF2 catalog entry sets this (two namespace URI
    // schemes across AVENTICS- vs Emerson-branded firmware, same Node IDs -
    // see gateway-client.ts's OpcuaConnectionConfig.namespaceUriFallbacks).
    const namespaceUriFallbacks = Array.isArray(config.namespaceUriFallbacks)
      ? config.namespaceUriFallbacks.map(String)
      : undefined;
    const connection = { host: String(config.host), port: Number(config.port), namespaceUri, namespaceUriFallbacks };
    // Shared (reference-counted) across every data source reading from the
    // same physical device, not a fresh client per metric - see
    // gateway-client.ts's acquireOpcuaGatewayClient() doc comment.
    const client = acquireOpcuaGatewayClient(connection, options.logger);
    const target = { namespaceUri, namespaceUriFallbacks, nodeIdentifier: Number(config.nodeIdentifier) };
    const samplingIntervalMs = options.readIntervalMs ?? DEFAULT_READ_INTERVAL_MS;
    return {
      // ensureSubscribed() is already a cheap no-op once subscribed (or
      // while a reconnect cooldown is active) - no need for our own
      // "already subscribed" flag here.
      read: async () => {
        await client.ensureSubscribed(target, samplingIntervalMs);
        return client.readCachedValue(target);
      },
      stop: () => releaseOpcuaGatewayClient(connection),
    };
  }

  if (dataSource.protocol === "MODBUS_TCP") {
    const { acquireModbusGatewayClient, releaseModbusGatewayClient } = await import("../protocol/modbus/gateway-client.js");
    const connection = { host: String(config.host), port: Number(config.port) };
    // Shared (reference-counted) across every data source reading from the
    // same physical device, not a fresh connection per metric - see
    // gateway-client.ts's acquireModbusGatewayClient() doc comment.
    const client = acquireModbusGatewayClient(connection, options.logger);
    const target = {
      register: Number(config.register),
      registerCount: Number(config.registerCount),
      byteOrder: (config.byteOrder as "BIG_ENDIAN" | "WORD_SWAPPED" | undefined) ?? "BIG_ENDIAN",
      format: config.format as "FLOAT32" | "INT32" | "UINT32" | undefined,
      resolutionRegister: config.resolutionRegister !== undefined ? Number(config.resolutionRegister) : undefined,
    };
    return {
      read: () => client.read(target),
      stop: () => {
        releaseModbusGatewayClient(connection);
        return Promise.resolve();
      },
    };
  }

  const { acquireMqttGatewayClient, releaseMqttGatewayClient } = await import("../protocol/mqtt/gateway-client.js");
  const connection = {
    brokerUrl: String(config.brokerUrl),
    port: Number(config.port),
    username: optionalString(config.username),
    password: optionalString(config.password),
  };
  // Shared (reference-counted) across every data source reading from the
  // same broker, not a fresh connection per metric - see
  // gateway-client.ts's acquireMqttGatewayClient() doc comment.
  const client = acquireMqttGatewayClient(connection, options.logger);
  const jsonFieldFallbacks = Array.isArray(config.jsonFieldFallbacks) ? config.jsonFieldFallbacks.map(String) : undefined;
  const target = {
    topic: String(config.topic),
    jsonField: optionalString(config.jsonField),
    jsonFieldFallbacks,
    qos: config.qos !== undefined ? (Number(config.qos) as 0 | 1 | 2) : undefined,
  };
  return {
    read: async () => {
      await client.ensureSubscribed(target);
      return client.readCachedValue(target);
    },
    stop: () => {
      releaseMqttGatewayClient(connection);
      return Promise.resolve();
    },
  };
}

interface TrackedSource {
  dataSource: GatewayDataSource;
  reader: DataSourceReader;
  timer: NodeJS.Timeout;
  // The connectionConfig this reader was built from - a data source edited
  // in ferrion (new host, register, topic) keeps its id, and without this
  // the gateway read the old address until its next restart (review
  // 2026-09, N-8).
  configKey: string;
  // Written by readOnce() on every tick - see getTrackedSensors(), which
  // derives a live/stale/error status purely from these two fields
  // rather than reaching into any protocol-specific client state (OPC
  // UA/Modbus/MQTT each have their own, differently-shaped internal
  // signals today, none of them public - see createDataSourceReader()
  // above).
  lastValueAt?: number;
  lastError?: string;
  // The last error was "the device does not know this node" - a wrong
  // configuration (a UMG 801 on firmware 1.5.x, asset-manager#902), shown as
  // its own status because retrying will not fix it.
  nodeUnknown?: boolean;
}

export type TrackedSourceStatusValue = "live" | "stale" | "error" | "node-unknown";

// One metric (= one GatewayDataSource) of a physical sensor. Carried
// alongside the aggregate row so the UI can show WHICH datapoint of a
// sensor is dark - a device can report "live" as a whole while a single
// node never delivers (found live 2026-10-11 on a UMG 801: the device was
// "live", one of its seven nodes silently had no value - Befund 2 in
// docs/umg801-zuordnung-gateway-befunde-2026-10-11.md over in ferrion).
export interface TrackedMetricStatus {
  dataSourceId: string;
  metricKey: string;
  label: string;
  status: TrackedSourceStatusValue;
  // Epoch ms of the last value, or null if none has ever arrived - the UI
  // turns this into an age ("vor 3 s"). null is the "never delivered" case
  // the whole breakdown exists to make visible.
  lastValueAt: number | null;
}

// One row per physical sensor (= ferrion Asset), not per metric - a
// sensor with 4 bridged metrics (flow, temperature, pressure, ...)
// collapses to one entry here, aggregating across every GatewayDataSource
// that shares one assetId. `status` is the worst-of across the sensor's
// metrics (see getTrackedSensors()); `metrics` is the per-datapoint
// breakdown behind it.
export interface TrackedSensorStatus {
  assetId: string;
  assetName: string;
  protocol: GatewayDataSource["protocol"];
  host: string | undefined;
  port: string | number | undefined;
  status: TrackedSourceStatusValue;
  metrics: TrackedMetricStatus[];
}

// A value is only "live" within a few read cycles of its own arrival -
// beyond that it's the same kind of frozen-value risk the OPC UA client's
// own liveness check guards against (see protocol/opcua/gateway-client.ts),
// just generalized here across every protocol instead of only OPC UA. 3x
// (not 1x) so a read cycle or two of ordinary jitter never flips a
// genuinely-fine data source to "stale".
const LIVE_STATUS_WINDOW_MULTIPLIER = 3;

// Best-effort host/port extraction from a data source's own
// connectionConfig, purely for display in the Web UI's tracked-sensors
// table - mirrors the exact same field names createDataSourceReader()
// above already reads per protocol (host+port for OPC UA/Modbus,
// brokerUrl+port for MQTT), just without the Number()/String() coercion
// this only needs for showing, not connecting. Kept as separate fields
// (not one joined "host:port" string) so the Web UI can show them as
// separate table columns.
function extractConnectionInfo(
  connectionConfig: Record<string, unknown>,
): { host: string | undefined; port: string | number | undefined } {
  const rawPort = connectionConfig.port;
  const port = typeof rawPort === "string" || typeof rawPort === "number" ? rawPort : undefined;
  if (typeof connectionConfig.host === "string") {
    return { host: connectionConfig.host, port };
  }
  if (typeof connectionConfig.brokerUrl === "string") {
    return { host: connectionConfig.brokerUrl, port };
  }
  return { host: undefined, port };
}

// Worst-of across a sensor's metrics: a single erroring metric makes the
// whole sensor "error", a single stale one (with no errors) makes it
// "stale" - only "live" once every one of its metrics is.
// A node the device does not know is the worst: it will not heal by itself.
const STATUS_SEVERITY: Record<TrackedSourceStatusValue, number> = { "node-unknown": 0, error: 1, stale: 2, live: 3 };

function worstStatus(statuses: TrackedSourceStatusValue[]): TrackedSourceStatusValue {
  return statuses.reduce((worst, current) => (STATUS_SEVERITY[current] < STATUS_SEVERITY[worst] ? current : worst));
}

export interface ReadingLoopOptions {
  discoveryIntervalMs?: number;
  pushIntervalMs?: number;
  readIntervalMs?: number;
  bufferMaxSize?: number;
  // Survives the ReadingBuffer's contents across a process restart - see
  // reading-buffer-store.ts. Optional/undefined in every existing test and
  // the standalone CLI entry point that has no persistence configured;
  // the buffer then behaves exactly as before (in-memory only).
  bufferStore?: ReadingBufferStore;
  aggregationStrategy?: AggregationStrategy;
  logger?: Logger;
  createReader?: (dataSource: GatewayDataSource, options: CreateDataSourceReaderOptions) => Promise<DataSourceReader>;
  // Fired only on ok<->fail transitions (not every tick) so a persistently
  // reachable or persistently unreachable ferrion doesn't spam this - see
  // control-plane/process-manager.ts's pushDegraded, surfaced through it.
  onPushStatusChange?: (ok: boolean) => void;
  // Fired on every push tick (see runPush()) with the current
  // getTrackedSensors() snapshot - unlike onPushStatusChange above, this
  // always fires, not just on transitions, since the Web UI's
  // tracked-sensors table (see control-plane/process-manager.ts) needs to
  // keep reflecting "still stale" for as long as that stays true, not
  // just the moment it started.
  onTrackedSensorsChange?: (sensors: TrackedSensorStatus[]) => void;
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 15000;
const DEFAULT_PUSH_INTERVAL_MS = 5000;
const DEFAULT_READ_INTERVAL_MS = 5000;

// One push carries at most this many readings, whatever the buffer holds
// (readingBufferMaxSize goes up to 25 000 - ferrion's own per-push cap,
// see its readings route - and used to be sent as one POST after an
// outage). A 413 halves it further, down to MIN_PUSH_BATCH, and it stays
// halved for the life of the process - restoring it on success would trip
// the same 413 every other push against a platform whose cap is lower
// than ours. Several batches per tick drain a backlog quickly without
// letting one tick run unbounded (review 2026-09, M-10).
export const MAX_PUSH_BATCH = 5_000;
const MIN_PUSH_BATCH = 100;
const MAX_BATCHES_PER_TICK = 5;
// Retry pacing after a failed push: doubling from the push interval up to
// this, plus up to 20 % jitter so several instances behind one API key do
// not retry in lock-step; a 429's Retry-After wins over the doubling.
const MAX_PUSH_BACKOFF_MS = 60_000;
// While pushes fail, the buffer file is rewritten at most this often -
// during an outage it grows towards ~1 MB and was rewritten twice per
// 5 s tick, a real wear concern on SD-card edge devices and a blocking
// write on the same event loop the 1 ms read tickers run on (review
// 2026-09, M-9).
const PERSIST_THROTTLE_DURING_OUTAGE_MS = 30_000;
// A persist failure (full disk, read-only volume) is logged this often,
// not on every tick - and never crashes the process (review 2026-09, H-4).
const PERSIST_ERROR_LOG_INTERVAL_MS = 60_000;

// Two independent tickers per instance (see the plan): discovery polls
// which data sources currently exist and starts/stops a per-source read
// ticker accordingly; push periodically flushes the ReadingAggregator into
// the ReadingBuffer and drains that into batched POSTs, requeuing on
// failure. Reads can run far faster than pushes (down to a 1ms
// readIntervalMs) without inflating what actually gets queued/sent, since
// the aggregator collapses everything recorded between two pushes into one
// reading per data source.
export class ReadingLoop {
  private readonly api: GatewayApi;
  private readonly buffer: ReadingBuffer;
  private readonly bufferStore: ReadingBufferStore | undefined;
  private readonly aggregator: ReadingAggregator;
  private readonly discoveryIntervalMs: number;
  private readonly pushIntervalMs: number;
  private readonly readIntervalMs: number;
  private readonly logger: Logger | undefined;
  private readonly createReader: (
    dataSource: GatewayDataSource,
    options: CreateDataSourceReaderOptions,
  ) => Promise<DataSourceReader>;
  private readonly onPushStatusChange: ((ok: boolean) => void) | undefined;
  private readonly onTrackedSensorsChange: ((sensors: TrackedSensorStatus[]) => void) | undefined;
  private readonly tracked = new Map<string, TrackedSource>();
  private discoveryTimer: NodeJS.Timeout | undefined;
  private pushTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private lastPushOk = true;
  private pushBatchSize = MAX_PUSH_BATCH;
  private consecutivePushFailures = 0;
  // Set by a failed push (backoff / Retry-After), cleared by a success;
  // schedulePush() reads it for the next delay.
  private nextPushDelayMs: number | undefined;
  private bufferDirty = false;
  private evictedSinceLastPush = 0;
  private lastPersistAt = 0;
  private lastPersistErrorLogAt = 0;

  constructor(api: GatewayApi, options: ReadingLoopOptions = {}) {
    this.api = api;
    this.logger = options.logger;
    this.buffer = new ReadingBuffer({
      maxSize: options.bufferMaxSize,
      // Counted, reported once per push tick (see runPush()) - a full
      // buffer during an outage evicts one reading per data source per
      // tick, and logging each with its payload came to ~670 000 lines a
      // day (review 2026-09, M-5).
      onEvict: () => {
        this.evictedSinceLastPush += 1;
      },
    });
    this.bufferStore = options.bufferStore;
    this.aggregator = new ReadingAggregator({ strategy: options.aggregationStrategy });
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
    this.pushIntervalMs = options.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
    this.readIntervalMs = options.readIntervalMs ?? DEFAULT_READ_INTERVAL_MS;
    this.createReader = options.createReader ?? createDataSourceReader;
    this.onPushStatusChange = options.onPushStatusChange;
    this.onTrackedSensorsChange = options.onTrackedSensorsChange;
  }

  start(): void {
    this.stopped = false;
    // Restores whatever survived a previous process's shutdown/crash
    // before the tickers start, so it's included in the very first push
    // instead of waiting for a fresh reading to prompt one.
    for (const reading of this.bufferStore?.load() ?? []) {
      this.buffer.add(reading);
      this.bufferDirty = true;
    }
    this.scheduleDiscovery(0);
    this.schedulePush(this.pushIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // A clean shutdown (SIGINT/SIGTERM, container redeploy) should have
    // zero loss window, not just a crash mid-push (see runPush()).
    this.persist({ force: true });
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    for (const tracked of this.tracked.values()) {
      clearInterval(tracked.timer);
      await tracked.reader.stop();
    }
    this.tracked.clear();
  }

  // Writes the buffer to disk when it changed since the last write. Never
  // throws: a full disk or a read-only volume must not take the reading
  // loop down with it - the readings keep flowing in memory and the
  // warning says why the file is behind.
  private persist(options: { force?: boolean } = {}): void {
    if (!this.bufferStore || !this.bufferDirty) return;
    const now = Date.now();
    if (!options.force && !this.lastPushOk && now - this.lastPersistAt < PERSIST_THROTTLE_DURING_OUTAGE_MS) return;
    try {
      this.bufferStore.save(this.buffer.toArray());
      this.bufferDirty = false;
      this.lastPersistAt = now;
    } catch (error) {
      if (now - this.lastPersistErrorLogAt >= PERSIST_ERROR_LOG_INTERVAL_MS) {
        this.lastPersistErrorLogAt = now;
        this.logger?.warn({ err: error }, "Could not persist the reading buffer - continuing in memory");
      }
    }
  }

  private scheduleDiscovery(delayMs: number): void {
    if (this.stopped) return;
    this.discoveryTimer = setTimeout(() => {
      void this.runDiscovery().finally(() => this.scheduleDiscovery(this.discoveryIntervalMs));
    }, delayMs);
  }

  private schedulePush(delayMs: number): void {
    if (this.stopped) return;
    this.pushTimer = setTimeout(() => {
      void this.runPush().finally(() => this.schedulePush(this.nextPushDelayMs ?? this.pushIntervalMs));
    }, delayMs);
  }

  async runDiscovery(): Promise<void> {
    let dataSources: GatewayDataSource[];
    try {
      dataSources = await this.api.fetchDataSources();
    } catch (error) {
      this.logger?.error({ err: error }, "Failed to fetch data sources");
      return;
    }

    const current = new Map(dataSources.map((dataSource) => [dataSource.id, dataSource]));

    // Sources that vanished from ferrion entirely: there is no replacement
    // to create, so stop and drop them. A source whose config merely
    // CHANGED is handled in the loop below, which creates its new reader
    // BEFORE stopping the old one.
    for (const [id, tracked] of this.tracked) {
      if (!current.has(id)) {
        clearInterval(tracked.timer);
        await tracked.reader.stop();
        this.tracked.delete(id);
      }
    }

    // New and reconfigured sources. For a reconfigured one, the new reader
    // is acquired before the old is released: a batch of metrics on one
    // physical device being reconfigured together (ferrion resolves and
    // re-sends them in one go - the churn behind Befund 1) then keeps the
    // shared client's reference count above zero throughout, so the session
    // is never torn down and immediately rebuilt. When the endpoint itself
    // changed, acquire connects the new one and release disconnects the old
    // one, as before.
    for (const dataSource of dataSources) {
      const existing = this.tracked.get(dataSource.id);
      if (existing && existing.configKey === configKeyOf(dataSource)) continue;
      const reader = await this.createReader(dataSource, { readIntervalMs: this.readIntervalMs, logger: this.logger });
      const timer = setInterval(() => {
        void this.readOnce(dataSource, reader);
      }, this.readIntervalMs);
      if (existing) {
        clearInterval(existing.timer);
        this.tracked.set(dataSource.id, { dataSource, reader, timer, configKey: configKeyOf(dataSource) });
        await existing.reader.stop();
        this.logger?.info({ dataSourceId: dataSource.id }, "Data source connection config changed, applied without dropping the shared connection where possible");
      } else {
        this.tracked.set(dataSource.id, { dataSource, reader, timer, configKey: configKeyOf(dataSource) });
      }
    }
  }

  private async readOnce(dataSource: GatewayDataSource, reader: DataSourceReader): Promise<void> {
    const tracked = this.tracked.get(dataSource.id);
    try {
      const value = await reader.read();
      if (value === undefined) return;
      if (tracked) {
        tracked.lastValueAt = Date.now();
        tracked.lastError = undefined;
      }
      this.aggregator.record(dataSource.id, value, new Date().toISOString());
    } catch (error) {
      const message = errorMessage(error);
      // Once per source and error, not on every retry: 140 sources on a
      // UMG 801 the template does not fit logged ~67,000 identical lines a
      // day (asset-manager#902). A different error, or the same one after a
      // good value in between, is logged again.
      const repeated = tracked?.lastError === message;
      if (tracked) {
        tracked.lastError = message;
        tracked.nodeUnknown = error instanceof NodeNotFoundError;
      }
      if (!repeated) this.logger?.error({ err: error, dataSourceId: dataSource.id }, "Failed to read data source");
    }
  }

  // Per-metric status is purely derived from readOnce()'s own
  // success/failure outcome above - see TrackedSourceStatusValue's doc
  // comment for why this stays protocol-agnostic instead of reaching into
  // each gateway-client's own (today private, differently-shaped)
  // connection state. Grouped by assetId into one row per physical
  // sensor for display - every metric of one sensor is assumed to share
  // its protocol/connection (see createAssetDataSources() in ferrion,
  // which takes a single protocol per creation batch), so those are read
  // from whichever member happens to be first; a mismatch across a
  // group's own protocol is logged rather than silently picking one.
  getTrackedSensors(): TrackedSensorStatus[] {
    const now = Date.now();
    const byAsset = new Map<string, { dataSource: GatewayDataSource; status: TrackedSourceStatusValue; lastValueAt: number | null }[]>();
    for (const { dataSource, lastValueAt, lastError, nodeUnknown } of this.tracked.values()) {
      let status: TrackedSourceStatusValue;
      if (lastError !== undefined) {
        status = nodeUnknown ? "node-unknown" : "error";
      } else if (lastValueAt !== undefined && now - lastValueAt <= this.readIntervalMs * LIVE_STATUS_WINDOW_MULTIPLIER) {
        status = "live";
      } else {
        status = "stale";
      }
      const members = byAsset.get(dataSource.assetId) ?? [];
      members.push({ dataSource, status, lastValueAt: lastValueAt ?? null });
      byAsset.set(dataSource.assetId, members);
    }

    return [...byAsset.values()].map((members) => {
      const [first] = members;
      const protocols = new Set(members.map((member) => member.dataSource.protocol));
      if (protocols.size > 1) {
        this.logger?.warn(
          { assetId: first!.dataSource.assetId, protocols: [...protocols] },
          "Tracked sensor's metrics report different protocols - showing the first one",
        );
      }
      const { host, port } = extractConnectionInfo(first!.dataSource.connectionConfig);
      // One entry per metric, stable order by metricKey so the UI table
      // doesn't reshuffle rows between snapshots.
      const metrics: TrackedMetricStatus[] = members
        .map((member) => ({
          dataSourceId: member.dataSource.id,
          metricKey: member.dataSource.metricKey,
          label: member.dataSource.label,
          status: member.status,
          lastValueAt: member.lastValueAt,
        }))
        .sort((a, b) => a.metricKey.localeCompare(b.metricKey));
      return {
        assetId: first!.dataSource.assetId,
        assetName: first!.dataSource.assetName,
        protocol: first!.dataSource.protocol,
        host,
        port,
        status: worstStatus(members.map((member) => member.status)),
        metrics,
      };
    });
  }

  async runPush(): Promise<void> {
    // Before the buffer.size===0 early return below - a data source that
    // silently stops delivering values across several ticks (buffer stays
    // empty, nothing to push) is exactly the case the tracked-sensors
    // status table exists to surface, so this must not depend on there
    // being anything to actually push this cycle.
    this.onTrackedSensorsChange?.(this.getTrackedSensors());
    for (const reading of this.aggregator.flush()) {
      this.buffer.add(reading);
      this.bufferDirty = true;
    }
    if (this.evictedSinceLastPush > 0) {
      this.logger?.warn(
        { evicted: this.evictedSinceLastPush, bufferSize: this.buffer.size },
        "Reading buffer full - oldest readings were dropped since the last push",
      );
      this.evictedSinceLastPush = 0;
    }
    if (this.buffer.size === 0) return;
    // Persisted *before* attempting the push, while the buffer still holds
    // everything about to be sent (drain() below removes it from memory,
    // not from disk) - a crash exactly during the network call would
    // otherwise lose whatever only ever lived in the local `batch`
    // variable. Not persisted again after a success: the file then lists
    // readings ferrion already has, which a restart re-delivers and ferrion
    // dedupes on (dataSourceId, timestamp) via skipDuplicates - one write
    // per tick instead of two. After a failure the requeued buffer equals
    // what was just written, so nothing to write either.
    this.persist();
    for (let batches = 0; batches < MAX_BATCHES_PER_TICK && this.buffer.size > 0; batches++) {
      const batch = this.buffer.drain(this.pushBatchSize);
      this.bufferDirty = true;
      try {
        const accepted = await this.api.pushReadings(batch);
        // The platform filters per reading (unknown data source, non-finite
        // value) and answers 200 regardless - the only place a silently
        // dropped reading can be seen is this count (review 2026-09, M-11).
        if (accepted < batch.length) {
          this.logger?.warn({ sent: batch.length, accepted }, "ferrion accepted fewer readings than were pushed");
        }
        this.consecutivePushFailures = 0;
        this.nextPushDelayMs = undefined;
        this.reportPushStatus(true);
      } catch (error) {
        this.buffer.requeue(batch);
        this.handlePushFailure(error);
        this.reportPushStatus(false);
        return;
      }
    }
  }

  private handlePushFailure(error: unknown): void {
    const status = error instanceof GatewayApiError ? error.status : undefined;
    if (status === 413 && this.pushBatchSize > MIN_PUSH_BATCH) {
      // ferrion's cap is lower than ours (or its body limit was hit with
      // unusually long ids) - shrink and retry rather than resend the same
      // too-large batch forever ("poison batch").
      this.pushBatchSize = Math.max(MIN_PUSH_BATCH, Math.floor(this.pushBatchSize / 2));
    }
    this.consecutivePushFailures += 1;
    const retryAfterMs = error instanceof GatewayApiError ? error.retryAfterMs : undefined;
    const exponent = Math.min(this.consecutivePushFailures - 1, 6);
    const base = retryAfterMs ?? Math.min(MAX_PUSH_BACKOFF_MS, this.pushIntervalMs * 2 ** exponent);
    this.nextPushDelayMs = Math.round(base + Math.random() * base * 0.2);
    this.logger?.error(
      { err: error, status, nextAttemptInMs: this.nextPushDelayMs, batchSize: this.pushBatchSize },
      "Failed to push readings, requeued for retry",
    );
  }

  private reportPushStatus(ok: boolean): void {
    if (ok === this.lastPushOk) return;
    this.lastPushOk = ok;
    this.onPushStatusChange?.(ok);
  }
}
