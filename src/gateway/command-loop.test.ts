import { describe, expect, it, vi } from "vitest";
import { CommandLoop } from "./command-loop.js";
import type { GatewayApi } from "../ferrion-client/gateway-api.js";
import type { GatewayCommand } from "../ferrion-client/types.js";

function fakeApi(overrides: Partial<GatewayApi> = {}): GatewayApi {
  return {
    fetchCommands: vi.fn().mockResolvedValue([]),
    postCommandResult: vi.fn().mockResolvedValue(undefined),
    fetchDataSources: vi.fn().mockResolvedValue([]),
    pushReadings: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as GatewayApi;
}

const command: GatewayCommand = {
  id: "cmd1",
  type: "TEST_CONNECTION",
  payload: { protocol: "MODBUS_TCP", connectionValues: { host: "127.0.0.1", port: "5502" } },
};

describe("CommandLoop.tick", () => {
  it("does nothing when there are no pending commands", async () => {
    const api = fakeApi();
    const loop = new CommandLoop(api, { handleCommand: vi.fn() });
    await loop.tick();
    expect(api.postCommandResult).not.toHaveBeenCalled();
  });

  it("dispatches each fetched command to the handler and posts its result", async () => {
    const api = fakeApi({ fetchCommands: vi.fn().mockResolvedValue([command]) });
    const handleCommand = vi.fn().mockResolvedValue({ status: "COMPLETED", result: { ok: true } });
    const loop = new CommandLoop(api, { handleCommand });

    await loop.tick();

    expect(handleCommand).toHaveBeenCalledWith("TEST_CONNECTION", command.payload);
    expect(api.postCommandResult).toHaveBeenCalledWith("cmd1", { status: "COMPLETED", result: { ok: true } });
  });

  it("posts a FAILED result if the handler itself throws, guaranteeing every command gets a result", async () => {
    const api = fakeApi({ fetchCommands: vi.fn().mockResolvedValue([command]) });
    const handleCommand = vi.fn().mockRejectedValue(new Error("boom"));
    const loop = new CommandLoop(api, { handleCommand });

    await loop.tick();

    expect(api.postCommandResult).toHaveBeenCalledWith(
      "cmd1",
      expect.objectContaining({ status: "FAILED", result: { error: "boom" } }),
    );
  });

  it("does not throw if fetching commands itself fails", async () => {
    const api = fakeApi({ fetchCommands: vi.fn().mockRejectedValue(new Error("network down")) });
    const loop = new CommandLoop(api, { handleCommand: vi.fn() });
    await expect(loop.tick()).resolves.toBeUndefined();
  });

  it("does not throw if posting the result itself fails", async () => {
    const api = fakeApi({
      fetchCommands: vi.fn().mockResolvedValue([command]),
      postCommandResult: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const handleCommand = vi.fn().mockResolvedValue({ status: "COMPLETED" });
    const loop = new CommandLoop(api, { handleCommand });
    await expect(loop.tick()).resolves.toBeUndefined();
  });
});

describe("CommandLoop with DISCOVER_DEVICES (R07)", () => {
  const scan: GatewayCommand = { id: "scan1", type: "DISCOVER_DEVICES", payload: { protocols: ["OPC_UA"] } };

  function deferred() {
    let resolve!: (value: { status: "COMPLETED"; result: unknown }) => void;
    const promise = new Promise<{ status: "COMPLETED"; result: unknown }>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("runs a scan beside the loop: a connection test in the same poll is answered first", async () => {
    const pending = deferred();
    const api = fakeApi({ fetchCommands: vi.fn().mockResolvedValue([scan, command]) });
    const handleDiscovery = vi.fn(() => pending.promise);
    const handleCommand = vi.fn().mockResolvedValue({ status: "COMPLETED", result: { ok: true } });
    const loop = new CommandLoop(api, { handleCommand, handleDiscovery });

    await loop.tick();

    expect(handleDiscovery).toHaveBeenCalledWith(scan.payload);
    expect(api.postCommandResult).toHaveBeenCalledTimes(1);
    expect(api.postCommandResult).toHaveBeenCalledWith("cmd1", { status: "COMPLETED", result: { ok: true } });

    pending.resolve({ status: "COMPLETED", result: { candidates: [] } });
    await loop.scanSettled();
    expect(api.postCommandResult).toHaveBeenLastCalledWith("scan1", { status: "COMPLETED", result: { candidates: [] } });
  });

  it("refuses a second scan while one runs, and takes the next one after it", async () => {
    const pending = deferred();
    const second: GatewayCommand = { ...scan, id: "scan2" };
    const third: GatewayCommand = { ...scan, id: "scan3" };
    const fetchCommands = vi.fn().mockResolvedValueOnce([scan]).mockResolvedValueOnce([second]).mockResolvedValueOnce([third]);
    const api = fakeApi({ fetchCommands });
    const handleDiscovery = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ status: "COMPLETED", result: {} });
    const loop = new CommandLoop(api, { handleCommand: vi.fn(), handleDiscovery });

    await loop.tick();
    await loop.tick();
    expect(api.postCommandResult).toHaveBeenCalledWith("scan2", { status: "FAILED", result: { error: "scan already running" } });
    expect(handleDiscovery).toHaveBeenCalledTimes(1);

    pending.resolve({ status: "COMPLETED", result: {} });
    await loop.scanSettled();
    await loop.tick();
    await loop.scanSettled();
    expect(handleDiscovery).toHaveBeenCalledTimes(2);
    expect(api.postCommandResult).toHaveBeenLastCalledWith("scan3", { status: "COMPLETED", result: {} });
  });

  it("posts a FAILED result when the scan throws", async () => {
    const api = fakeApi({ fetchCommands: vi.fn().mockResolvedValue([scan]) });
    const loop = new CommandLoop(api, { handleCommand: vi.fn(), handleDiscovery: vi.fn().mockRejectedValue(new Error("boom")) });

    await loop.tick();
    await loop.scanSettled();

    expect(api.postCommandResult).toHaveBeenCalledWith("scan1", { status: "FAILED", result: { error: "boom" } });
  });

  it("refuses by default when the gateway has no discovery limit", async () => {
    const api = fakeApi({ fetchCommands: vi.fn().mockResolvedValue([scan]) });
    const loop = new CommandLoop(api, { handleCommand: vi.fn(), discoveryLimit: { cidrs: [], invalid: [] } });

    await loop.tick();
    await loop.scanSettled();

    expect(api.postCommandResult).toHaveBeenCalledWith("scan1", {
      status: "FAILED",
      result: { error: "discovery not enabled on this gateway (FG_DISCOVERY_ALLOWED_CIDRS not set)" },
    });
  });

  it("does not throw when posting the scan's result fails", async () => {
    const api = fakeApi({
      fetchCommands: vi.fn().mockResolvedValue([scan]),
      postCommandResult: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const loop = new CommandLoop(api, { handleCommand: vi.fn(), handleDiscovery: vi.fn().mockResolvedValue({ status: "COMPLETED" }) });

    await loop.tick();
    await expect(loop.scanSettled()).resolves.toBeUndefined();
  });
});

describe("CommandLoop start/stop", () => {
  it("polls immediately on start and stops scheduling further ticks after stop()", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi();
      const loop = new CommandLoop(api, { handleCommand: vi.fn(), intervalMs: 1000 });

      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.fetchCommands).toHaveBeenCalledTimes(1);

      loop.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(api.fetchCommands).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
