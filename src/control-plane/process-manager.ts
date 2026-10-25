import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { InstanceConfig } from "../config/schema.js";
import type { TrackedSensorStatus } from "../gateway/reading-loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const childEntryPath = path.join(__dirname, "..", "..", "fleet", "child-entry.ts");

// Auto-restart of a crashed keepAlive instance: doubling from 5 s up to a
// minute, reset once a child has stayed up for STABLE_RUN_MS. A fixed 5 s
// (the previous behaviour) meant a persistently failing bridge - the OOM
// case the comment below describes - forked a fresh 100-170 MB process
// every 5 s on a device that was already short of memory, with a stack
// trace per round in the log (review 2026-09, M-3).
const RESTART_BASE_DELAY_MS = 5000;
const RESTART_MAX_DELAY_MS = 60_000;
const STABLE_RUN_MS = 10 * 60_000;

// stop(): disconnect the IPC channel (the child's cue to shut down
// cleanly, see child-entry.ts), then escalate if it does not go - a driver
// hanging in its close() used to leave the child "running" forever, with
// start() refusing to start a new one and restart() waiting for an exit
// that never came (review 2026-09, M-2). The hard cap bounds the *caller's*
// wait even if SIGKILL itself fails.
const STOP_SIGTERM_AFTER_MS = 5000;
const STOP_SIGKILL_AFTER_MS = 8000;
const STOP_HARD_CAP_MS = 10_000;

export type InstanceStatus = "stopped" | "starting" | "running" | "error";

export interface InstanceStatusSnapshot {
  status: InstanceStatus;
  lastError?: string;
  lastEventAt?: string;
  // True while the instance is up but its last attempt to push readings to
  // ferrion failed (see app.ts's onPushStatusChange) - distinct from
  // status:"error", which means the process itself is down. A running
  // instance that can't reach ferrion looks identical to a healthy one
  // without this: the failure was only ever visible in its log.
  pushDegraded?: boolean;
  // Which real physical sensors this instance is currently bridging, and
  // whether each is live/stale/erroring - see app.ts's
  // onTrackedSensorsChange and gateway/reading-loop.ts's
  // getTrackedSensors(). Only ever populated for a bridge-only instance in
  // practice (a simulated instance's ReadingLoop tracks the exact same
  // real data sources too, per ferrion's own API-key-not-instance
  // scoping - see routes.ts's ensureBridgeInstance() doc comment - but
  // the Web UI only ever renders this for the bridge card).
  trackedSensors?: TrackedSensorStatus[];
  // How many keepAlive auto-restarts this instance has been through since
  // it last ran stably, and when the next one is due - so the UI can say
  // "5th restart in 40 s" instead of "error".
  restartCount?: number;
  nextRestartAt?: string;
}

interface ManagedProcess {
  child: ChildProcess;
  status: InstanceStatus;
  lastError?: string;
  lastEventAt: string;
  pushDegraded?: boolean;
  trackedSensors?: TrackedSensorStatus[];
  // Pending auto-restart after an unexpected exit (see start()'s
  // keepAlive option) - cancelled by stop() so a restart scheduled just
  // before an intentional stop doesn't fire anyway.
  restartTimer?: NodeJS.Timeout;
  nextRestartAt?: string;
  restartCount: number;
  startedAt: number;
  exited: boolean;
  escalationTimers: NodeJS.Timeout[];
}

export interface ExitClassification {
  status: "stopped" | "error";
  lastError?: string;
}

export interface StartOptions {
  // Auto-respawns the child (with backoff, see RESTART_BASE_DELAY_MS) if
  // it exits with an unexpected/crash status - see start()'s exit handler.
  // Used for the bridge-only instance (routes.ts's ensureBridgeInstance()),
  // which is deliberately not manually stoppable from the Web UI and
  // therefore needs to heal itself from a crash instead of sitting dark
  // until someone notices.
  keepAlive?: boolean;
}

// A clean stop() disconnects the IPC channel, which child-entry.ts treats
// as its cue to shut down gracefully and always exits 0 - whether that
// happens before or after the instance finished starting. Anything else
// (a crash, or a kill from outside - e.g. the OOM killer, observed live:
// 12 of 30 simulated instances never came up on a 2GB-constrained
// container, each silently reverting to "stopped" with zero explanation
// before this fix) is a real failure the UI should actually surface, not
// hide. Pulled out as a pure function so this classification is
// unit-testable without forking a real process.
export function classifyExit(code: number | null, signal: NodeJS.Signals | null): ExitClassification {
  if (code === 0) {
    return { status: "stopped" };
  }
  const lastError = signal
    ? `Process was killed (signal ${signal})${signal === "SIGKILL" ? " - possibly out of memory" : ""}`
    : `Process exited unexpectedly (code ${code})`;
  return { status: "error", lastError };
}

// What a child may tell us over IPC. Own code on both ends, but `lastError`
// ends up in the Web UI and `sensors` drives a table there - a cast is not
// a contract (review 2026-09, N-11). Anything else is logged and dropped.
const childMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("error"), error: z.string().max(2000) }),
  z.object({ type: z.literal("push-status"), ok: z.boolean() }),
  z.object({
    type: z.literal("tracked-sensors"),
    sensors: z.array(
      z.object({
        assetId: z.string(),
        assetName: z.string(),
        protocol: z.enum(["OPC_UA", "MODBUS_TCP", "MQTT"]),
        host: z.string().optional(),
        port: z.union([z.string(), z.number()]).optional(),
        status: z.enum(["live", "stale", "error"]),
        metrics: z
          .array(
            z.object({
              dataSourceId: z.string(),
              metricKey: z.string(),
              label: z.string(),
              status: z.enum(["live", "stale", "error"]),
              lastValueAt: z.number().nullable(),
            }),
          )
          .default([]),
      }),
    ),
  }),
]);

export type ChildEvent =
  | z.infer<typeof childMessageSchema>
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

// A forked child inherits the whole parent environment unless told
// otherwise - in the fleet launcher that meant every instance's FG_KEY_*
// in every child's /proc/<pid>/environ, even though the key itself is
// handed over by IPC precisely to keep it out of the process table
// (review 2026-09, N-12). Only what a child demonstrably reads.
// FG_DISCOVERY_ALLOWED_CIDRS: the instance that picks up a DISCOVER_DEVICES
// command scans within it (R07); without it here every child would have no
// limit and refuse every scan.
const CHILD_ENV_KEYS = ["PATH", "HOME", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "FG_BIND_HOST", "FG_LOG_LEVEL", "FG_DISCOVERY_ALLOWED_CIDRS"] as const;

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function restartDelayMs(restartCount: number): number {
  return Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** restartCount);
}

type ForkFn = (
  modulePath: string,
  args: string[],
  options: { execArgv: string[]; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export interface ProcessManagerOptions {
  // Every validated child message and every exit, for a caller that wants
  // to log them (the fleet launcher) - the control plane reads status
  // snapshots instead.
  onEvent?: (instanceId: string, event: ChildEvent) => void;
}

// child_process.fork() per instance, running the same fleet/child-entry.ts
// the headless launcher uses - status flows back over IPC
// (process.send/on("message")), no extra port needed. Runtime-only: this
// state is not persisted, so a control-plane restart shows every instance
// as stopped until started again (instance-store.ts is what persists
// configuration).
export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  // Injectable so tests can exercise start()/stop()/exit-handling/the
  // keepAlive restart logic against a fake child process, instead of
  // needing to actually fork a real tsx process per test - production
  // code never passes this, it always defaults to the real fork().
  private readonly fork: ForkFn;
  private readonly onEvent: ((instanceId: string, event: ChildEvent) => void) | undefined;

  constructor(forkFn: ForkFn = fork, options: ProcessManagerOptions = {}) {
    this.fork = forkFn;
    this.onEvent = options.onEvent;
  }

  getStatus(instanceId: string): InstanceStatusSnapshot {
    const managed = this.processes.get(instanceId);
    if (!managed) return { status: "stopped" };
    return {
      status: managed.status,
      lastError: managed.lastError,
      lastEventAt: managed.lastEventAt,
      pushDegraded: managed.pushDegraded,
      trackedSensors: managed.trackedSensors,
      ...(managed.restartCount > 0 ? { restartCount: managed.restartCount } : {}),
      ...(managed.nextRestartAt ? { nextRestartAt: managed.nextRestartAt } : {}),
    };
  }

  isRunning(instanceId: string): boolean {
    const status = this.processes.get(instanceId)?.status;
    return status === "running" || status === "starting";
  }

  start(instanceId: string, config: InstanceConfig, options: StartOptions = {}): void {
    if (this.isRunning(instanceId)) return;
    // A pending auto-restart from a previous crash of this same instance
    // (see the exit handler below) would otherwise race this fresh
    // start() and could fork a second child once it eventually fires.
    const previous = this.processes.get(instanceId);
    if (previous) this.clearTimers(previous);

    const child = this.fork(childEntryPath, [], { execArgv: ["--import", "tsx"], env: childEnv() });
    const managed: ManagedProcess = {
      child,
      status: "starting",
      lastEventAt: new Date().toISOString(),
      restartCount: previous?.restartCount ?? 0,
      startedAt: Date.now(),
      exited: false,
      escalationTimers: [],
    };
    this.processes.set(instanceId, managed);

    child.on("message", (message: unknown) => {
      const parsed = childMessageSchema.safeParse(message);
      if (!parsed.success) {
        console.warn(`[process-manager] ignoring malformed IPC message from ${instanceId}`);
        return;
      }
      const event = parsed.data;
      if (event.type === "started") {
        managed.status = "running";
        managed.startedAt = Date.now();
      } else if (event.type === "error") {
        managed.status = "error";
        managed.lastError = event.error;
      } else if (event.type === "push-status") {
        managed.pushDegraded = !event.ok;
      } else {
        managed.trackedSensors = event.sensors.map(
          (sensor): TrackedSensorStatus => ({
            assetId: sensor.assetId,
            assetName: sensor.assetName,
            protocol: sensor.protocol,
            host: sensor.host,
            port: sensor.port,
            status: sensor.status,
            metrics: sensor.metrics,
          }),
        );
      }
      managed.lastEventAt = new Date().toISOString();
      this.onEvent?.(instanceId, event);
    });

    child.on("exit", (code, signal) => {
      managed.exited = true;
      this.clearEscalation(managed);
      // Don't overwrite a more specific message a caught startup error
      // already reported via IPC (see child-entry.ts's .catch()).
      if (managed.status !== "error") {
        const outcome = classifyExit(code, signal);
        managed.status = outcome.status;
        managed.lastError = outcome.lastError;
      }
      managed.lastEventAt = new Date().toISOString();
      this.onEvent?.(instanceId, { type: "exit", code, signal });
      // Only for a genuine crash (classifyExit's "error"), never a clean
      // exit-code-0 stop - stop()/stopAll() both produce a clean exit via
      // disconnect(), and neither should cause this instance to spring
      // back up (stopAll() in particular runs during a full control-plane
      // shutdown, where respawning anything would be actively wrong).
      if (options.keepAlive && managed.status === "error") {
        if (Date.now() - managed.startedAt >= STABLE_RUN_MS) {
          managed.restartCount = 0;
        }
        const delay = restartDelayMs(managed.restartCount);
        managed.restartCount += 1;
        managed.nextRestartAt = new Date(Date.now() + delay).toISOString();
        managed.restartTimer = setTimeout(() => {
          managed.nextRestartAt = undefined;
          this.start(instanceId, config, options);
        }, delay);
      }
    });

    child.send(config);
  }

  private clearEscalation(managed: ManagedProcess): void {
    for (const timer of managed.escalationTimers) clearTimeout(timer);
    managed.escalationTimers = [];
  }

  private clearTimers(managed: ManagedProcess): void {
    if (managed.restartTimer) clearTimeout(managed.restartTimer);
    managed.restartTimer = undefined;
    managed.nextRestartAt = undefined;
    this.clearEscalation(managed);
  }

  // Resolves once the child has exited (or right away if it never ran /
  // already exited), at the latest after STOP_HARD_CAP_MS.
  stop(instanceId: string): Promise<void> {
    const managed = this.processes.get(instanceId);
    if (!managed) return Promise.resolve();
    // Cancels a pending post-crash auto-restart (see start()'s exit
    // handler) - an explicit stop() must win over a keepAlive respawn
    // that just happened to already be scheduled.
    this.clearTimers(managed);
    if (managed.exited) return Promise.resolve();
    const child = managed.child;
    // disconnect() throws ERR_IPC_DISCONNECTED if the channel is already
    // torn down (e.g. Stop clicked twice, or the child exited on its own).
    if (child.connected) {
      child.disconnect();
    }
    const escalate = (afterMs: number, signal: NodeJS.Signals) => {
      const timer = setTimeout(() => {
        if (!managed.exited) child.kill(signal);
      }, afterMs);
      timer.unref();
      managed.escalationTimers.push(timer);
    };
    escalate(STOP_SIGTERM_AFTER_MS, "SIGTERM");
    escalate(STOP_SIGKILL_AFTER_MS, "SIGKILL");
    return new Promise<void>((resolve) => {
      const cap = setTimeout(resolve, STOP_HARD_CAP_MS);
      cap.unref();
      child.once("exit", () => {
        clearTimeout(cap);
        resolve();
      });
    });
  }

  // Applies a config change to an already-running instance despite config
  // being construction-time-only (each instance's ReadingLoop reads its
  // options once into readonly fields - see gateway/reading-loop.ts). Used
  // by the settings routes, since the bridge instance can never be
  // manually stopped via the normal UI/API, so saving new settings has to
  // restart it itself for those settings to actually take effect. stop()
  // resolving on the real "exit" event is what closes the race a plain
  // stop()-then-start() would have: start()'s isRunning() guard would still
  // see "running"/"starting" until the child's disconnect-triggered exit
  // actually fires. If nothing is running yet (never started, or already
  // exited on its own), start() directly.
  async restart(instanceId: string, config: InstanceConfig, options: StartOptions = {}): Promise<void> {
    await this.stop(instanceId);
    this.start(instanceId, config, options);
  }

  // Stops the child and forgets the instance - a deleted instance used to
  // keep its ManagedProcess (child handle, config with the API key, the
  // exit closure) in the map forever (review 2026-09, N-6).
  async remove(instanceId: string): Promise<void> {
    await this.stop(instanceId);
    this.processes.delete(instanceId);
  }

  // Waits for every child to actually exit (bounded by stop()'s own cap) -
  // the container runtime kills whatever is left the moment PID 1 ends, and
  // a child killed mid-way loses the reading buffer it was about to save
  // and leaves its OPC UA sessions open on the device.
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.processes.keys()].map((instanceId) => this.stop(instanceId)));
  }
}
