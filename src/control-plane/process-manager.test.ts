import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { InstanceConfig } from "../config/schema.js";
import { childEnv, classifyExit, ProcessManager } from "./process-manager.js";

type FakeChild = EventEmitter & {
  connected: boolean;
  send: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

// Stands in for child_process.fork()'s real return value - a plain
// EventEmitter is enough since ProcessManager only ever calls
// .on("message"/"exit", ...), .send(), .disconnect(), and reads
// .connected, never anything else from a real ChildProcess. Explicit
// parameter types on the vi.fn() implementation (even though unused) are
// what let TS infer a ForkFn-compatible signature instead of a generic
// Mock<Procedure> - a bare `() => ...` implementation isn't specific
// enough for `new ProcessManager(forkFn)` to typecheck.
function fakeForkFn() {
  const children: FakeChild[] = [];
  const forkFn = vi.fn((_modulePath: string, _args: string[], _options: { execArgv: string[] }): ChildProcess => {
    const child = new EventEmitter() as FakeChild;
    child.connected = true;
    child.send = vi.fn();
    child.disconnect = vi.fn(() => {
      child.connected = false;
    });
    child.kill = vi.fn();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  return { forkFn, children };
}

// ProcessManager never reads any field of this itself - it's just handed
// opaquely to child.send()/the recursive restart call, both faked above.
const config = {} as unknown as InstanceConfig;

describe("classifyExit", () => {
  it("treats a clean exit (code 0) as a normal stop, regardless of when it happened", () => {
    expect(classifyExit(0, null)).toEqual({ status: "stopped" });
  });

  it("treats a non-zero exit code as an error with a descriptive message", () => {
    const result = classifyExit(1, null);
    expect(result.status).toBe("error");
    expect(result.lastError).toMatch(/exited unexpectedly \(code 1\)/);
  });

  it("treats a signal-caused termination as an error", () => {
    const result = classifyExit(null, "SIGTERM");
    expect(result.status).toBe("error");
    expect(result.lastError).toMatch(/killed \(signal SIGTERM\)/);
  });

  it("calls out SIGKILL specifically as possibly being an OOM kill", () => {
    const result = classifyExit(null, "SIGKILL");
    expect(result.status).toBe("error");
    expect(result.lastError).toMatch(/possibly out of memory/);
  });

  it("does not mention out-of-memory for a non-SIGKILL signal", () => {
    const result = classifyExit(null, "SIGTERM");
    expect(result.lastError).not.toMatch(/out of memory/);
  });
});

describe("ProcessManager", () => {
  it("reports \"stopped\" for an instance that was never started", () => {
    const pm = new ProcessManager(fakeForkFn().forkFn);
    expect(pm.getStatus("unknown")).toEqual({ status: "stopped" });
  });

  it("transitions starting -> running as the child reports it, and forwards tracked-sensors/push-status", () => {
    const { forkFn, children } = fakeForkFn();
    const pm = new ProcessManager(forkFn);

    pm.start("id1", config);
    expect(pm.getStatus("id1").status).toBe("starting");

    children[0]!.emit("message", { type: "started" });
    expect(pm.getStatus("id1").status).toBe("running");

    children[0]!.emit("message", { type: "push-status", ok: false });
    expect(pm.getStatus("id1").pushDegraded).toBe(true);

    const sensors = [
      {
        assetId: "asset1",
        assetName: "Pump 1",
        protocol: "MODBUS_TCP",
        host: "10.0.0.7",
        port: 502,
        status: "live",
        metrics: [{ dataSourceId: "ds1", metricKey: "flow", label: "Flow", status: "live", lastValueAt: 1000 }],
      },
    ];
    children[0]!.emit("message", { type: "tracked-sensors", sensors });
    expect(pm.getStatus("id1").trackedSensors).toEqual(sensors);
  });

  it("does not fork a second child while already running/starting", () => {
    const { forkFn } = fakeForkFn();
    const pm = new ProcessManager(forkFn);

    pm.start("id1", config);
    pm.start("id1", config);

    expect(forkFn).toHaveBeenCalledTimes(1);
  });

  it("classifies a crash exit as an error, without keepAlive it stays that way", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("id1", config);

      children[0]!.emit("exit", 1, null);
      expect(pm.getStatus("id1").status).toBe("error");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(forkFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-restarts a keepAlive instance after it crashes, once the cooldown elapses", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("bridge", config, { keepAlive: true });

      children[0]!.emit("exit", 1, null);
      expect(pm.getStatus("bridge").status).toBe("error");
      expect(forkFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);

      expect(forkFn).toHaveBeenCalledTimes(2);
      expect(pm.getStatus("bridge").status).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a keepAlive instance on a clean, intentional exit (code 0)", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("bridge", config, { keepAlive: true });

      children[0]!.emit("exit", 0, null);
      expect(pm.getStatus("bridge").status).toBe("stopped");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(forkFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending auto-restart if stop() is called during the cooldown", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("bridge", config, { keepAlive: true });
      children[0]!.emit("exit", 1, null);

      void pm.stop("bridge");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(forkFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() disconnects the child if still connected, and is a no-op otherwise", async () => {
    const { forkFn, children } = fakeForkFn();
    const pm = new ProcessManager(forkFn);
    pm.start("id1", config);

    void pm.stop("id1");
    expect(children[0]!.disconnect).toHaveBeenCalledTimes(1);

    await expect(pm.stop("does-not-exist")).resolves.toBeUndefined();
    // A second stop() on the same child neither throws nor disconnects again.
    void pm.stop("id1");
    expect(children[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it("restart() stops a connected instance, waits for it to actually exit, then starts fresh with new config", async () => {
    const { forkFn, children } = fakeForkFn();
    const pm = new ProcessManager(forkFn);
    pm.start("bridge", config, { keepAlive: true });
    children[0]!.emit("message", { type: "started" });

    const restartPromise = pm.restart("bridge", config, { keepAlive: true });
    expect(children[0]!.disconnect).toHaveBeenCalledTimes(1);
    // Still waiting on the real "exit" event - a naive stop()-then-start()
    // would have already forked a second child here and hit start()'s
    // isRunning() no-op guard instead.
    expect(forkFn).toHaveBeenCalledTimes(1);

    children[0]!.emit("exit", 0, null);
    await restartPromise;

    expect(forkFn).toHaveBeenCalledTimes(2);
    expect(pm.getStatus("bridge").status).toBe("starting");
  });

  it("restart() starts directly, without waiting for an exit, when nothing is currently running", async () => {
    const { forkFn } = fakeForkFn();
    const pm = new ProcessManager(forkFn);

    await pm.restart("bridge", config, { keepAlive: true });

    expect(forkFn).toHaveBeenCalledTimes(1);
  });

  it("ignores an IPC message that does not match the contract, and forwards only the validated fields", () => {
    const { forkFn, children } = fakeForkFn();
    const pm = new ProcessManager(forkFn);
    pm.start("id1", config);

    children[0]!.emit("message", { type: "error", error: { nested: "object" } });
    expect(pm.getStatus("id1").status).toBe("starting");

    children[0]!.emit("message", "not even an object");
    children[0]!.emit("message", { type: "tracked-sensors", sensors: [{ assetId: "a", status: "weird" }] });
    expect(pm.getStatus("id1").trackedSensors).toBeUndefined();

    children[0]!.emit("message", {
      type: "tracked-sensors",
      sensors: [{ assetId: "a", assetName: "AF2", protocol: "MQTT", status: "live", extra: "dropped" }],
    });
    // `metrics` defaults to [] when a snapshot omits it, so an older child
    // that never sent it still parses - and `extra` is dropped as before.
    expect(pm.getStatus("id1").trackedSensors).toEqual([
      { assetId: "a", assetName: "AF2", protocol: "MQTT", host: undefined, port: undefined, status: "live", metrics: [] },
    ]);
  });

  it("forks the child with a picked environment, never the parent's whole one", () => {
    const { forkFn } = fakeForkFn();
    const pm = new ProcessManager(forkFn);
    pm.start("id1", config);

    const options = forkFn.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toBeDefined();
    expect(Object.keys(options.env!).every((key) => ["PATH", "HOME", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "FG_BIND_HOST", "FG_LOG_LEVEL"].includes(key))).toBe(true);
    expect(childEnv({ PATH: "/bin", FG_KEY_AF2: "gw_secret", FG_BIND_HOST: "0.0.0.0" })).toEqual({ PATH: "/bin", FG_BIND_HOST: "0.0.0.0" });
  });

  it("hands the discovery limit down to every instance (R07)", () => {
    expect(childEnv({ FG_DISCOVERY_ALLOWED_CIDRS: "10.20.30.0/24" })).toEqual({ FG_DISCOVERY_ALLOWED_CIDRS: "10.20.30.0/24" });
  });

  it("stopAll() disconnects every managed child, cancels pending restarts, and waits for the exits (bounded)", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("bridge", config, { keepAlive: true });
      pm.start("simulated", config);
      children[0]!.emit("exit", 1, null); // schedules a pending restart for "bridge"

      let settled = false;
      const stopping = pm.stopAll().then(() => {
        settled = true;
      });
      expect(children[1]!.disconnect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);

      children[1]!.emit("exit", 0, null);
      await stopping;
      expect(settled).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(forkFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escalates a stop that the child ignores: SIGTERM after 5 s, SIGKILL after 8 s, caller released by 10 s (review M-2)", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("id1", config);
      const child = children[0]!;

      let settled = false;
      void pm.stop("id1").then(() => {
        settled = true;
      });
      expect(child.disconnect).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(3000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escalate once the child has exited on its own", async () => {
    vi.useFakeTimers();
    try {
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("id1", config);
      const stopping = pm.stop("id1");
      children[0]!.emit("exit", 0, null);
      await stopping;

      await vi.advanceTimersByTimeAsync(20_000);
      expect(children[0]!.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off between keepAlive restarts (5 s, 10 s, 20 s ...) and shows the count and next attempt (review M-3)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-15T08:00:00Z"));
      const { forkFn, children } = fakeForkFn();
      const pm = new ProcessManager(forkFn);
      pm.start("bridge", config, { keepAlive: true });

      children[0]!.emit("exit", 1, null);
      expect(pm.getStatus("bridge")).toMatchObject({ status: "error", restartCount: 1, nextRestartAt: "2026-09-15T08:00:05.000Z" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(forkFn).toHaveBeenCalledTimes(2);

      children[1]!.emit("exit", 1, null);
      expect(pm.getStatus("bridge").restartCount).toBe(2);
      await vi.advanceTimersByTimeAsync(9999);
      expect(forkFn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(forkFn).toHaveBeenCalledTimes(3);

      children[2]!.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(forkFn).toHaveBeenCalledTimes(4);

      // A child that then stays up for ten minutes resets the ladder.
      children[3]!.emit("message", { type: "started" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      children[3]!.emit("exit", 1, null);
      expect(pm.getStatus("bridge").restartCount).toBe(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(forkFn).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remove() stops the child and forgets the instance (review N-6)", async () => {
    const { forkFn, children } = fakeForkFn();
    const pm = new ProcessManager(forkFn);
    pm.start("id1", config);
    children[0]!.emit("message", { type: "started" });

    const removing = pm.remove("id1");
    children[0]!.emit("exit", 0, null);
    await removing;

    expect(pm.getStatus("id1")).toEqual({ status: "stopped" });
    expect(pm.isRunning("id1")).toBe(false);
  });
});
