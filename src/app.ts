import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstanceConfig } from "./config/schema.js";
import { DeviceSimulator } from "./drivers/simulated/device-simulator.js";
import { GatewayApi } from "./ferrion-client/gateway-api.js";
import { HttpClient } from "./ferrion-client/http-client.js";
import { CommandLoop } from "./gateway/command-loop.js";
import { formatCidr } from "./discovery/ipv4.js";
import { DISCOVERY_LIMIT_ENV, readDiscoveryLimit } from "./discovery/scan-request.js";
import { bufferFileNameFor, ReadingBufferStore } from "./gateway/reading-buffer-store.js";
import { ReadingLoop } from "./gateway/reading-loop.js";
import { createLogger, type Logger } from "./logging/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This package's version, for ferrion (R07). Undefined rather than a crash
// when package.json cannot be read - the version is information, not a
// precondition for bridging.
function readOwnVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export interface RunningInstance {
  logger: Logger;
  stop(): Promise<void>;
}

// Wires Config+Client+Simulator+Loops for ONE instance - the single-
// instance building block both index.ts (standalone CLI) and
// fleet/child-entry.ts (spawned by the control-plane/launcher) use.
export async function startInstance(config: InstanceConfig): Promise<RunningInstance> {
  const logger = createLogger(config.instanceName, config.logLevel);

  // Plain http: to anything but this machine sends the API key as a
  // cleartext Bearer header across the network. Allowed (a ferrion behind
  // a TLS-terminating proxy on the same host is a real setup), but never
  // silently (review 2026-09, N-10).
  const ferrionUrl = new URL(config.ferrion.baseUrl);
  if (ferrionUrl.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(ferrionUrl.hostname)) {
    logger.warn({ baseUrl: config.ferrion.baseUrl }, "ferrion base URL is plain http - the API key travels unencrypted");
  }

  const httpClient = new HttpClient({
    baseUrl: config.ferrion.baseUrl,
    apiKey: config.ferrion.apiKey,
    rejectUnauthorized: config.ferrion.rejectUnauthorized,
    requestTimeoutMs: config.resilience.httpRequestTimeoutMs,
  });
  // Read once: the limit is the operator's, fixed for the life of the
  // process (R07, decision 8).
  const discoveryLimit = readDiscoveryLimit();
  if (discoveryLimit.invalid.length > 0) {
    logger.warn({ invalid: discoveryLimit.invalid }, `${DISCOVERY_LIMIT_ENV}: entries ignored, not IPv4 networks`);
  }
  const discoveryLimitText = discoveryLimit.cidrs.map(formatCidr);
  logger.info({ discoveryLimit: discoveryLimitText }, discoveryLimitText.length > 0 ? "Device discovery allowed within limit" : "Device discovery disabled (no limit set)");
  const api = new GatewayApi(httpClient, { version: readOwnVersion(), discoveryLimit: discoveryLimitText });

  // data/ is the same Docker-volume-mounted directory instance-store.ts
  // and settings-store.ts already persist to (see docker-compose.yml) -
  // survives a container restart without any deploy changes.
  const bufferStore = new ReadingBufferStore(
    path.join(__dirname, "..", "data", "reading-buffers", bufferFileNameFor(config.instanceName)),
  );

  // Absent for a bridge-only instance - one that only bridges real
  // hardware whose connection details live entirely in ferrion's own
  // data-source config (see config/schema.ts's instanceConfigSchema.device
  // doc comment). readingLoop below never reads `simulator`/`config.device`/
  // `config.ports` at all - it's fully driven by whatever data sources
  // ferrion assigns to this instance's own API key, so skipping the
  // simulator here has no effect on real-hardware bridging.
  let simulator: DeviceSimulator | undefined;
  if (config.device) {
    simulator = new DeviceSimulator({
      templateId: config.device.templateId,
      serialNumber: config.device.serialNumber,
      ports: config.ports,
    });
    await simulator.start();
    logger.info({ device: config.device, ports: config.ports }, "Simulated device started");
  } else {
    logger.info("Bridge-only instance (no simulated device) - only bridging ferrion-assigned data sources");
  }

  const commandLoop = new CommandLoop(api, { intervalMs: config.polling.commandsIntervalMs, logger, discoveryLimit });
  commandLoop.start();

  // See schema.ts's runReadingLoop doc comment: false for a control-plane-
  // managed simulated instance, since the control-plane's always-running
  // bridge singleton already discovers/reads/pushes every data source
  // under the same (shared-per-gateway) API key - running this instance's
  // own copy of the same loop would just redundantly re-push the exact
  // same readings the bridge already sends.
  let readingLoop: ReadingLoop | undefined;
  if (config.runReadingLoop) {
    readingLoop = new ReadingLoop(api, {
      discoveryIntervalMs: config.polling.dataSourcesIntervalMs,
      readIntervalMs: config.polling.readingIntervalMs,
      pushIntervalMs: config.polling.readingsPushIntervalMs,
      aggregationStrategy: config.polling.aggregation,
      bufferMaxSize: config.resilience.readingBufferMaxSize,
      bufferStore,
      logger,
      // process.send only exists when actually forked (control-plane/fleet
      // launcher); the standalone `npm run dev` CLI entry has no parent to
      // report to, so this is a no-op there. Guarded by process.connected the
      // same way fleet/child-entry.ts's sendIfConnected() is - a push status
      // change can fire after the parent already disconnected (Stop clicked
      // mid-flight), and send() on a torn-down channel throws.
      onPushStatusChange: (ok) => {
        if (process.connected) process.send?.({ type: "push-status", ok });
      },
      // Same process.connected guard as onPushStatusChange above - powers
      // the Web UI's tracked-sensors table (control-plane/process-manager.ts,
      // public/app.js) with which real sensors this instance is currently
      // bridging and whether each is live/stale/erroring.
      onTrackedSensorsChange: (sensors) => {
        if (process.connected) process.send?.({ type: "tracked-sensors", sensors });
      },
    });
    readingLoop.start();
  } else {
    logger.info("Own reading loop disabled - relying on the control-plane's bridge instance instead");
  }

  logger.info("Gateway instance started");

  return {
    logger,
    async stop() {
      commandLoop.stop();
      if (readingLoop) await readingLoop.stop();
      if (simulator) await simulator.stop();
      logger.info("Gateway instance stopped");
    },
  };
}
