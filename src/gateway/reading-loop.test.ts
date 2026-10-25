import { describe, expect, it, vi } from "vitest";
import { NodeNotFoundError } from "../protocol/node-not-found-error.js";
import type { GatewayApi } from "../ferrion-client/gateway-api.js";
import { GatewayApiError } from "../ferrion-client/http-client.js";
import type { GatewayDataSource } from "../ferrion-client/types.js";
import type { Logger } from "../logging/logger.js";
import type { ReadingBufferStore } from "./reading-buffer-store.js";
import { ReadingLoop, type DataSourceReader } from "./reading-loop.js";

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function fakeApi(overrides: Partial<GatewayApi> = {}): GatewayApi {
  return {
    fetchCommands: vi.fn().mockResolvedValue([]),
    postCommandResult: vi.fn().mockResolvedValue(undefined),
    fetchDataSources: vi.fn().mockResolvedValue([]),
    pushReadings: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as GatewayApi;
}

const dataSource: GatewayDataSource = {
  id: "ds1",
  assetId: "asset1",
  assetName: "Pump 1",
  protocol: "MODBUS_TCP",
  connectionConfig: { host: "127.0.0.1", port: 5502, register: 1000, registerCount: 2, byteOrder: "BIG_ENDIAN" },
  metricKey: "temperature",
  label: "Temperatur",
  unit: "°C",
};

function fakeReader(values: Array<number | undefined>): DataSourceReader & { stop: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    read: vi.fn().mockImplementation(async () => values[Math.min(index++, values.length - 1)]),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ReadingLoop.runDiscovery", () => {
  it("starts tracking a newly-discovered data source and reads it on its own ticker", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([21.5]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      expect(reader.read).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(reader.read).toHaveBeenCalledTimes(1);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops tracking and disconnects a data source that disappeared from ferrion", async () => {
    vi.useFakeTimers();
    try {
      const fetchDataSources = vi.fn().mockResolvedValueOnce([dataSource]).mockResolvedValueOnce([]);
      const api = fakeApi({ fetchDataSources });
      const reader = fakeReader([21.5]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await loop.runDiscovery();

      expect(reader.stop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(reader.read).not.toHaveBeenCalled();

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart tracking for a data source it already knows about", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const createReader = vi.fn().mockResolvedValue(fakeReader([1]));
      const loop = new ReadingLoop(api, { createReader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await loop.runDiscovery();

      expect(createReader).toHaveBeenCalledTimes(1);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconfigures a source by creating its new reader before stopping the old one", async () => {
    // Debounce for Befund 1's churn: when a source's config changes, the old
    // reader must not be stopped before the new one exists. For a shared
    // client (several metrics on one device reconfigured together) this keeps
    // the reference count above zero, so the session is not torn down and
    // immediately rebuilt. Observable here as ordering: the new reader is
    // created before the old reader's stop() runs.
    vi.useFakeTimers();
    try {
      const reconfigured: GatewayDataSource = { ...dataSource, connectionConfig: { ...dataSource.connectionConfig, register: 2000 } };
      const fetchDataSources = vi.fn().mockResolvedValueOnce([dataSource]).mockResolvedValueOnce([reconfigured]);
      const api = fakeApi({ fetchDataSources });
      const oldReader = fakeReader([1]);
      const newReader = fakeReader([2]);
      const createReader = vi.fn().mockResolvedValueOnce(oldReader).mockResolvedValueOnce(newReader);
      const loop = new ReadingLoop(api, { createReader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await loop.runDiscovery();

      expect(createReader).toHaveBeenCalledTimes(2);
      // The new reader was created before the old one was stopped.
      expect(createReader.mock.invocationCallOrder[1]!).toBeLessThan(oldReader.stop.mock.invocationCallOrder[0]!);
      expect(oldReader.stop).toHaveBeenCalledTimes(1);
      // Reads now go to the new reader, not the old one.
      await vi.advanceTimersByTimeAsync(1000);
      expect(newReader.read).toHaveBeenCalled();
      expect(oldReader.read).not.toHaveBeenCalled();

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ReadingLoop.runPush", () => {
  it("does nothing when the buffer is empty", async () => {
    const api = fakeApi();
    const loop = new ReadingLoop(api);
    await loop.runPush();
    expect(api.pushReadings).not.toHaveBeenCalled();
  });

  it("drains buffered readings collected via discovery+read and pushes them as a batch", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([21.5]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);
      await loop.runPush();

      expect(api.pushReadings).toHaveBeenCalledWith([expect.objectContaining({ dataSourceId: "ds1", value: 21.5 })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requeues the batch if the push itself fails, instead of dropping it", async () => {
    const api = fakeApi({ pushReadings: vi.fn().mockRejectedValue(new Error("network down")) });
    const loop = new ReadingLoop(api);
    // Bracket notation reaches the private buffer directly to seed a
    // reading, since runPush() is what's under test here.
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 });

    await loop.runPush();

    expect(loop["buffer"].size).toBe(1);
  });

  it("reports buffer overflow once per push tick with a count, not once per evicted reading", async () => {
    const api = fakeApi({ pushReadings: vi.fn().mockResolvedValue(1) });
    const logger = fakeLogger();
    const loop = new ReadingLoop(api, { bufferMaxSize: 1, logger });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:01.000Z", value: 2 });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:02.000Z", value: 3 });
    expect(logger.warn).not.toHaveBeenCalled();

    await loop.runPush();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ evicted: 2, bufferSize: 1 }, expect.stringMatching(/dropped since the last push/));

    await loop.runPush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("skips a read that returned no value yet (e.g. an MQTT topic with no message received)", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([undefined]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);
      await loop.runPush();

      expect(api.pushReadings).not.toHaveBeenCalled();
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeBufferStore(seed: unknown[] = []): ReadingBufferStore & { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> } {
  return { load: vi.fn().mockReturnValue(seed), save: vi.fn() } as unknown as ReadingBufferStore & {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
}

describe("ReadingLoop bufferStore persistence", () => {
  it("seeds the buffer from bufferStore.load() on start(), included in the next push", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      const bufferStore = fakeBufferStore([{ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 }]);
      const loop = new ReadingLoop(api, { bufferStore, pushIntervalMs: 1000 });

      loop.start();
      expect(bufferStore.load).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);

      expect(api.pushReadings).toHaveBeenCalledWith([
        { dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 },
      ]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the buffer to the store once, before a successful push - the file then over-reports, which ferrion dedupes", async () => {
    const api = fakeApi();
    const bufferStore = fakeBufferStore();
    const loop = new ReadingLoop(api, { bufferStore });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 });
    loop["bufferDirty"] = true;

    await loop.runPush();

    expect(bufferStore.save).toHaveBeenCalledTimes(1);
    expect(bufferStore.save).toHaveBeenCalledWith([{ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 }]);
    // The next stop() writes the now-empty buffer, so a clean shutdown
    // leaves an accurate file behind.
    await loop.stop();
    expect(bufferStore.save).toHaveBeenLastCalledWith([]);
  });

  it("persists once before a failed push and not again after it - the requeued buffer equals what was written", async () => {
    const api = fakeApi({ pushReadings: vi.fn().mockRejectedValue(new Error("network down")) });
    const bufferStore = fakeBufferStore();
    const loop = new ReadingLoop(api, { bufferStore });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 });
    loop["bufferDirty"] = true;

    await loop.runPush();

    expect(bufferStore.save).toHaveBeenCalledTimes(1);
    expect(bufferStore.save).toHaveBeenLastCalledWith([{ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 }]);
  });

  it("does not touch the store when there is nothing buffered to push", async () => {
    const api = fakeApi();
    const bufferStore = fakeBufferStore();
    const loop = new ReadingLoop(api, { bufferStore });

    await loop.runPush();

    expect(bufferStore.save).not.toHaveBeenCalled();
  });

  it("persists the buffer to the store on stop(), even without a pending push", async () => {
    const api = fakeApi();
    const bufferStore = fakeBufferStore();
    const loop = new ReadingLoop(api, { bufferStore });
    loop["buffer"].add({ dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 });
    loop["bufferDirty"] = true;

    await loop.stop();

    expect(bufferStore.save).toHaveBeenCalledWith([
      { dataSourceId: "ds1", timestamp: "2026-08-14T12:00:00.000Z", value: 1 },
    ]);
  });
});

describe("ReadingLoop.getTrackedSensors", () => {
  it("reports \"stale\" for a tracked sensor that has never received a value", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([undefined]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();

      expect(loop.getTrackedSensors()).toEqual([
        {
          assetId: "asset1",
          assetName: "Pump 1",
          protocol: "MODBUS_TCP",
          host: "127.0.0.1",
          port: 5502,
          status: "stale",
          metrics: [
            { dataSourceId: "ds1", metricKey: "temperature", label: "Temperatur", status: "stale", lastValueAt: null },
          ],
        },
      ]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports \"live\" shortly after a successful read", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([21.5]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "live" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports \"stale\" again once a live value ages past the live window (3x readIntervalMs)", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([21.5, undefined]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000); // live value arrives at t=1000
      await vi.advanceTimersByTimeAsync(4000); // t=5000, 4000ms since - past the 3000ms window

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "stale" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports \"error\" after a read throws, then back to \"live\" once a read succeeds again", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader: DataSourceReader = {
        read: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(21.5),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "error" })]);

      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "live" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a node the device does not know as its own status, and logs it once instead of on every retry (asset-manager#902)", async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const unknown = () => new NodeNotFoundError("No namespace candidate serves node i=101260");
      const reader: DataSourceReader = {
        read: vi
          .fn()
          .mockRejectedValueOnce(unknown())
          .mockRejectedValueOnce(unknown())
          .mockRejectedValueOnce(unknown())
          .mockResolvedValueOnce(21.5)
          .mockRejectedValueOnce(unknown()),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000, logger });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(3000);

      expect(loop.getTrackedSensors()).toEqual([
        expect.objectContaining({ status: "node-unknown", metrics: [expect.objectContaining({ status: "node-unknown" })] }),
      ]);
      // Three failed tries, one line: 140 such sources logged ~67,000 a day.
      expect(logger.error).toHaveBeenCalledTimes(1);

      // A good value clears it; the same failure afterwards is news again.
      await vi.advanceTimersByTimeAsync(1000);
      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ status: "live" })]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(logger.error).toHaveBeenCalledTimes(2);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a different error again, and keeps a connection failure as \"error\", not \"node-unknown\"", async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader: DataSourceReader = {
        read: vi
          .fn()
          .mockRejectedValueOnce(new NodeNotFoundError("unknown node"))
          .mockRejectedValueOnce(new Error("connection lost")),
        stop: vi.fn().mockResolvedValue(undefined),
      };
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000, logger });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(2000);

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ status: "error" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks an unknown node above any other error for the sensor as a whole", async () => {
    vi.useFakeTimers();
    try {
      const second: GatewayDataSource = { ...dataSource, id: "ds2", metricKey: "pressure" };
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource, second]) });
      const loop = new ReadingLoop(api, {
        createReader: async (source) => ({
          read: vi.fn().mockRejectedValue(source.id === "ds2" ? new NodeNotFoundError("unknown node") : new Error("boom")),
          stop: vi.fn().mockResolvedValue(undefined),
        }),
        readIntervalMs: 1000,
      });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ status: "node-unknown" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("extracts host/port as separate fields for OPC UA/Modbus connectionConfig, and brokerUrl+port for MQTT", async () => {
    const opcuaSource: GatewayDataSource = {
      ...dataSource,
      id: "ds-opcua",
      assetId: "asset-opcua",
      protocol: "OPC_UA",
      connectionConfig: { host: "10.0.0.1", port: 4840 },
    };
    const mqttSource: GatewayDataSource = {
      ...dataSource,
      id: "ds-mqtt",
      assetId: "asset-mqtt",
      protocol: "MQTT",
      connectionConfig: { brokerUrl: "mqtt://10.0.0.2", port: 1883, topic: "x" },
    };
    const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([opcuaSource, mqttSource]) });
    const loop = new ReadingLoop(api, { createReader: async () => fakeReader([undefined]) });

    await loop.runDiscovery();
    const sensors = loop.getTrackedSensors();

    expect(sensors.find((s) => s.assetId === "asset-opcua")).toEqual(
      expect.objectContaining({ host: "10.0.0.1", port: 4840 }),
    );
    expect(sensors.find((s) => s.assetId === "asset-mqtt")).toEqual(
      expect.objectContaining({ host: "mqtt://10.0.0.2", port: 1883 }),
    );

    await loop.stop();
  });

  it("collapses a sensor's multiple tracked metrics into a single row", async () => {
    vi.useFakeTimers();
    try {
      const flowMetric: GatewayDataSource = { ...dataSource, id: "ds-flow", metricKey: "flow", label: "Flow" };
      const tempMetric: GatewayDataSource = { ...dataSource, id: "ds-temp", metricKey: "temperature", label: "Temp" };
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([flowMetric, tempMetric]) });
      const reader = fakeReader([21.5]);
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      const sensors = loop.getTrackedSensors();
      expect(sensors).toHaveLength(1);
      expect(sensors[0]).toEqual(expect.objectContaining({ assetId: "asset1", status: "live" }));
      // The per-metric breakdown behind the aggregate dot (Befund 2): one
      // entry per metric, sorted by metricKey, each with its own status.
      expect(sensors[0]!.metrics.map((m) => m.metricKey)).toEqual(["flow", "temperature"]);
      expect(sensors[0]!.metrics.every((m) => m.status === "live")).toBe(true);
      expect(sensors[0]!.metrics.every((m) => typeof m.lastValueAt === "number")).toBe(true);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a sensor live overall but flags the one metric that never delivered a value", async () => {
    // Befund 2's exact situation: a UMG 801 reported "live" as a device
    // while one of its nodes silently had no value. The aggregate dot may
    // say live/stale, but the breakdown must name the dark datapoint.
    vi.useFakeTimers();
    try {
      const flowMetric: GatewayDataSource = { ...dataSource, id: "ds-flow", metricKey: "flow", label: "Flow" };
      const deadMetric: GatewayDataSource = { ...dataSource, id: "ds-dead", metricKey: "pressure", label: "Pressure" };
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([flowMetric, deadMetric]) });
      // flow delivers, pressure never does.
      const readers = new Map<string, DataSourceReader>([
        ["ds-flow", fakeReader([21.5])],
        ["ds-dead", fakeReader([undefined])],
      ]);
      const loop = new ReadingLoop(api, {
        createReader: async (ds) => readers.get(ds.id)!,
        readIntervalMs: 1000,
      });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      const [sensor] = loop.getTrackedSensors();
      const byKey = new Map(sensor!.metrics.map((m) => [m.metricKey, m]));
      expect(byKey.get("flow")!.status).toBe("live");
      expect(byKey.get("flow")!.lastValueAt).toEqual(expect.any(Number));
      expect(byKey.get("pressure")!.status).toBe("stale");
      expect(byKey.get("pressure")!.lastValueAt).toBeNull();

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a sensor as \"error\" if even one of its metrics is erroring, regardless of the others", async () => {
    vi.useFakeTimers();
    try {
      const liveMetric: GatewayDataSource = { ...dataSource, id: "ds-live", metricKey: "flow" };
      const errorMetric: GatewayDataSource = { ...dataSource, id: "ds-error", metricKey: "temperature" };
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([liveMetric, errorMetric]) });
      const readers = new Map([
        ["ds-live", fakeReader([21.5])],
        ["ds-error", { read: vi.fn().mockRejectedValue(new Error("boom")), stop: vi.fn().mockResolvedValue(undefined) }],
      ]);
      const loop = new ReadingLoop(api, {
        createReader: async (ds) => readers.get(ds.id)!,
        readIntervalMs: 1000,
      });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "error" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a sensor as \"stale\" (not \"live\") if any of its metrics hasn't reported yet, with no errors", async () => {
    vi.useFakeTimers();
    try {
      const liveMetric: GatewayDataSource = { ...dataSource, id: "ds-live", metricKey: "flow" };
      const staleMetric: GatewayDataSource = { ...dataSource, id: "ds-stale", metricKey: "temperature" };
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([liveMetric, staleMetric]) });
      const readers = new Map([
        ["ds-live", fakeReader([21.5])],
        ["ds-stale", fakeReader([undefined])],
      ]);
      const loop = new ReadingLoop(api, {
        createReader: async (ds) => readers.get(ds.id)!,
        readIntervalMs: 1000,
      });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);

      expect(loop.getTrackedSensors()).toEqual([expect.objectContaining({ assetId: "asset1", status: "stale" })]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ReadingLoop onTrackedSensorsChange", () => {
  it("fires on every push tick, even when the buffer is empty", async () => {
    const api = fakeApi();
    const onTrackedSensorsChange = vi.fn();
    const loop = new ReadingLoop(api, { onTrackedSensorsChange });

    await loop.runPush();

    expect(onTrackedSensorsChange).toHaveBeenCalledWith([]);
  });

  it("reflects currently-tracked sensors in the reported snapshot", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({ fetchDataSources: vi.fn().mockResolvedValue([dataSource]) });
      const reader = fakeReader([21.5]);
      const onTrackedSensorsChange = vi.fn();
      const loop = new ReadingLoop(api, { createReader: async () => reader, readIntervalMs: 1000, onTrackedSensorsChange });

      await loop.runDiscovery();
      await vi.advanceTimersByTimeAsync(1000);
      await loop.runPush();

      expect(onTrackedSensorsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ assetId: "asset1", status: "live" }),
      ]);

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ReadingLoop review 2026-09 fixes", () => {
  it("rebuilds the reader when a known data source's connection config changes (N-8)", async () => {
    vi.useFakeTimers();
    try {
      const moved = { ...dataSource, connectionConfig: { ...dataSource.connectionConfig, host: "10.0.0.9" } };
      const fetchDataSources = vi.fn().mockResolvedValueOnce([dataSource]).mockResolvedValueOnce([moved]);
      const api = fakeApi({ fetchDataSources });
      const first = fakeReader([1]);
      const second = fakeReader([2]);
      const createReader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const loop = new ReadingLoop(api, { createReader, readIntervalMs: 1000 });

      await loop.runDiscovery();
      await loop.runDiscovery();

      expect(first.stop).toHaveBeenCalledTimes(1);
      expect(createReader).toHaveBeenCalledTimes(2);
      expect(createReader.mock.calls[1]![0]).toBe(moved);

      await vi.advanceTimersByTimeAsync(1000);
      expect(second.read).toHaveBeenCalledTimes(1);
      expect(first.read).not.toHaveBeenCalled();

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when ferrion accepted fewer readings than were pushed (M-11)", async () => {
    const logger = fakeLogger();
    const api = fakeApi({ pushReadings: vi.fn().mockResolvedValue(1) });
    const loop = new ReadingLoop(api, { logger, createReader: async () => fakeReader([1]) });
    const buffer = (loop as unknown as { buffer: { add: (r: unknown) => void } }).buffer;
    buffer.add({ dataSourceId: "ds1", timestamp: "2026-09-14T10:00:00.000Z", value: 1 });
    buffer.add({ dataSourceId: "ds2", timestamp: "2026-09-14T10:00:00.000Z", value: 2 });

    await loop.runPush();

    expect(logger.warn).toHaveBeenCalledWith({ sent: 2, accepted: 1 }, expect.stringMatching(/fewer readings/));
  });

  function seed(loop: ReadingLoop, count: number): void {
    for (let index = 0; index < count; index++) {
      loop["buffer"].add({ dataSourceId: `ds${index % 40}`, timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(), value: index });
    }
    loop["bufferDirty"] = true;
  }

  it("drains a backlog in batches of at most MAX_PUSH_BATCH, several per tick (M-10)", async () => {
    const pushReadings = vi.fn().mockResolvedValue(0);
    const loop = new ReadingLoop(fakeApi({ pushReadings }), { bufferMaxSize: 25_000 });
    seed(loop, 12_000);

    await loop.runPush();

    expect(pushReadings).toHaveBeenCalledTimes(3);
    expect(pushReadings.mock.calls.map((call) => (call[0] as unknown[]).length)).toEqual([5000, 5000, 2000]);
    expect(loop["buffer"].size).toBe(0);
  });

  it("halves the batch after a 413 and requeues instead of resending the same too-large batch forever", async () => {
    const pushReadings = vi
      .fn()
      .mockRejectedValueOnce(new GatewayApiError("too large", 413))
      .mockResolvedValue(0);
    const loop = new ReadingLoop(fakeApi({ pushReadings }), { bufferMaxSize: 25_000 });
    seed(loop, 6_000);

    await loop.runPush();
    expect(loop["buffer"].size).toBe(6_000);

    await loop.runPush();
    expect(pushReadings.mock.calls.slice(1).map((call) => (call[0] as unknown[]).length)).toEqual([2500, 2500, 1000]);
  });

  it("paces the retry by Retry-After on a 429 and by doubling backoff otherwise, reset by a success", async () => {
    vi.useFakeTimers();
    try {
      const pushReadings = vi
        .fn()
        .mockRejectedValueOnce(new GatewayApiError("slow down", 429, undefined, 7_000))
        .mockRejectedValueOnce(new Error("network"))
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(0);
      const loop = new ReadingLoop(fakeApi({ pushReadings }), { pushIntervalMs: 1000 });
      vi.spyOn(Math, "random").mockReturnValue(0);
      seed(loop, 3);

      await loop.runPush();
      expect(loop["nextPushDelayMs"]).toBe(7_000);
      await loop.runPush();
      expect(loop["nextPushDelayMs"]).toBe(2_000);
      await loop.runPush();
      expect(loop["nextPushDelayMs"]).toBe(4_000);
      await loop.runPush();
      expect(loop["nextPushDelayMs"]).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("keeps running when the buffer file cannot be written, and says so once per interval (H-4)", async () => {
    const logger = fakeLogger();
    const bufferStore = fakeBufferStore();
    bufferStore.save.mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const loop = new ReadingLoop(fakeApi({ pushReadings: vi.fn().mockResolvedValue(2) }), { bufferStore, logger });
    seed(loop, 2);

    await expect(loop.runPush()).resolves.toBeUndefined();
    await expect(loop.stop()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/Could not persist/));
  });

  it("rewrites the buffer file at most every 30 s while pushes keep failing (M-9)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-14T10:00:00Z"));
      const bufferStore = fakeBufferStore();
      const loop = new ReadingLoop(fakeApi({ pushReadings: vi.fn().mockRejectedValue(new Error("down")) }), { bufferStore });
      seed(loop, 1);

      await loop.runPush();
      seed(loop, 2);
      await loop.runPush();
      expect(bufferStore.save).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-09-14T10:00:31Z"));
      seed(loop, 3);
      await loop.runPush();
      expect(bufferStore.save).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
