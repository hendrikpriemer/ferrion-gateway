import path from "node:path";
import { loadFleetConfig } from "../src/config/load-fleet-config.js";
import type { InstanceConfig } from "../src/config/schema.js";
import { ProcessManager } from "../src/control-plane/process-manager.js";
import { allocatePorts } from "./port-allocator.js";

// Headless CLI alternative to the control-plane's Web UI (see the plan) -
// reads a fleet.config.json and spawns one child process per instance,
// through the very same ProcessManager the control-plane uses (fork with a
// filtered environment, validated IPC, stop with escalation). It used to
// fork on its own and disconnect() children without a `connected` guard,
// which threw ERR_IPC_DISCONNECTED in the signal handler once one child
// had already died (review 2026-09, N-7). Useful for scripted/CI-style
// bulk starts; the Web UI is the primary day-to-day workflow.

const fleetConfigPath = path.resolve(process.argv[2] ?? "fleet.config.json");
const fleet = loadFleetConfig(fleetConfigPath);

// A bridge-only entry (no device - see schema.ts's fleetEntrySchema.device
// doc comment) contributes `undefined` here, which allocatePorts() itself
// resolves to `{}` at that same index without consuming a protocol port
// slot - see its own doc comment for why index alignment matters here.
const allocatedPorts = allocatePorts(fleet.instances.map((instance) => instance.device?.templateId));

const processManager = new ProcessManager(undefined, {
  onEvent: (instanceName, event) => {
    if (event.type === "exit") {
      console.log(`[${instanceName}] exited with code ${event.code}${event.signal ? ` (signal ${event.signal})` : ""}`);
    } else {
      console.log(`[${instanceName}]`, event);
    }
  },
});

fleet.instances.forEach((entry, index) => {
  const config: InstanceConfig = {
    instanceName: entry.instanceName,
    ferrion: {
      baseUrl: fleet.ferrion.baseUrl,
      apiKey: entry.apiKey,
      rejectUnauthorized: fleet.ferrion.rejectUnauthorized,
    },
    device: entry.device,
    ports: { ...allocatedPorts[index], ...entry.ports },
    polling: fleet.polling,
    resilience: fleet.resilience,
    logLevel: fleet.logLevel,
    // The fleet launcher never runs a separate bridge singleton (that's
    // control-plane-only, see control-plane/routes.ts's toInstanceConfig())
    // - every fleet-launched instance stays self-contained and reads its
    // own device/data sources, same as before this field existed.
    runReadingLoop: true,
  };
  processManager.start(entry.instanceName, config);
});

console.log(`Started ${fleet.instances.length} instance(s) from ${fleetConfigPath}. Press Ctrl+C to stop all.`);

async function shutdownAll(): Promise<void> {
  console.log("Shutting down all instances...");
  await processManager.stopAll();
  process.exit(0);
}

process.on("SIGINT", () => void shutdownAll());
process.on("SIGTERM", () => void shutdownAll());
