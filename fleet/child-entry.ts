import { startInstance, type RunningInstance } from "../src/app.js";
import { instanceConfigSchema } from "../src/config/schema.js";
import { errorMessage } from "../src/util/error-message.js";

// Entry point every spawned/forked child runs (see fleet/launcher.ts and
// the control-plane's process-manager.ts) - receives its InstanceConfig
// over IPC rather than argv, so a plaintext ferrion API key never shows up
// in `ps` output on this machine.

let runningInstance: RunningInstance | undefined;
let starting = false;

// A driver that never returns from its close() (an OPC UA session close
// against a device that stopped answering, a Modbus socket in limbo) must
// not keep this process alive past the parent's patience - the parent
// escalates to SIGTERM/SIGKILL (process-manager.ts), but an orderly exit
// with a reason is better than a kill.
const SHUTDOWN_TIMEOUT_MS = 8000;

async function shutdown(): Promise<void> {
  if (runningInstance) {
    const timeout = setTimeout(() => {
      console.error(`[child-entry] stop() did not finish within ${SHUTDOWN_TIMEOUT_MS} ms - exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();
    try {
      await runningInstance.stop();
    } catch (error) {
      // A failing stop (a driver that will not close, a buffer file that
      // cannot be written) must still end the process - the parent is
      // waiting for the exit, and exit 1 tells it something was wrong.
      console.error("[child-entry] stop() failed during shutdown", error);
      process.exit(1);
    }
  }
  process.exit(0);
}

// Node's default for an unhandled rejection is to exit with a stack trace
// on stderr and nothing else - the parent then only sees "exited
// unexpectedly (code 1)". One line saying what it was, then the same exit,
// so keepAlive still restarts the instance (review 2026-09, H-4).
process.on("unhandledRejection", (reason) => {
  console.error("[child-entry] unhandled rejection - exiting", reason);
  process.exit(1);
});

// The parent can disconnect (Stop clicked) while startInstance() is still
// in flight - process.send() on an already-torn-down IPC channel throws
// and crashes the child instead of just letting it exit, so every send is
// guarded by process.connected.
function sendIfConnected(message: unknown): void {
  if (process.connected) {
    process.send?.(message);
  }
}

process.once("message", (message: unknown) => {
  if (starting) return;
  starting = true;
  // Validated, not cast: the parent is our own code, but a config that
  // slipped through unvalidated would fail somewhere deep inside a driver
  // with a far less useful message than this one.
  const parsed = instanceConfigSchema.safeParse(message);
  if (!parsed.success) {
    sendIfConnected({ type: "error", error: `Invalid instance config over IPC: ${parsed.error.message}` });
    process.exit(1);
  }
  const config = parsed.data;
  startInstance(config)
    .then((instance) => {
      runningInstance = instance;
      sendIfConnected({ type: "started", instanceName: config.instanceName });
    })
    .catch((error: unknown) => {
      sendIfConnected({
        type: "error",
        instanceName: config.instanceName,
        error: errorMessage(error),
      });
      process.exit(1);
    });
});

process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
