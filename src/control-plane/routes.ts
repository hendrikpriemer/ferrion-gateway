import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { nextFreePort } from "../../fleet/port-allocator.js";
import {
  aggregationStrategySchema,
  DEVICE_TEMPLATE_IDS,
  envLogLevel,
  ferrionBaseUrlSchema,
  MIN_PUSH_INTERVAL_MS,
  pollingSchema,
  resilienceSchema,
  type DeviceTemplateId,
  type InstanceConfig,
  type Ports,
} from "../config/schema.js";
import { DEVICE_TEMPLATES } from "../device-catalog/known-device-templates.js";
import { getAppInfo } from "./app-info.js";
import { checkFerrionConnectivity } from "./ferrion-connectivity.js";
import { InstanceStore, type InstanceRecord } from "./instance-store.js";
import { ProcessManager } from "./process-manager.js";
import { SettingsStore, type FerrionSettings } from "./settings-store.js";
import { isCrossSiteWrite } from "./csrf-guard.js";

// The Web UI's "Erweitert" section - a sparse subset of pollingSchema, not
// every field (commandsIntervalMs/dataSourcesIntervalMs stay
// config-file-only, less central to the "fast sensor, aggregated push" use
// case this exists for). Omitted fields fall back to pollingSchema's own
// defaults in toInstanceConfig() below.
const pollingOverridesSchema = z.object({
  readingIntervalMs: z.coerce.number().int().positive().optional(),
  readingsPushIntervalMs: z.coerce.number().int().min(MIN_PUSH_INTERVAL_MS).optional(),
  aggregation: aggregationStrategySchema.optional(),
});

// The dedicated bridge-settings panel (see the PUT
// /api/instances/:id/bridge-settings handler below) - deliberately its own
// schema, not an extension of pollingOverridesSchema above, since that one
// stays scoped to the simulated-instance "Erweitert" form's narrower field
// set. This exposes every pollingSchema/resilienceSchema field, since the
// bridge is the one instance whose settings previously had no UI at all.
const bridgeSettingsSchema = z.object({
  polling: z
    .object({
      commandsIntervalMs: z.coerce.number().int().positive().optional(),
      dataSourcesIntervalMs: z.coerce.number().int().positive().optional(),
      readingIntervalMs: z.coerce.number().int().positive().optional(),
      readingsPushIntervalMs: z.coerce.number().int().min(MIN_PUSH_INTERVAL_MS).optional(),
      aggregation: aggregationStrategySchema.optional(),
    })
    .optional(),
  resilience: z
    .object({
      httpRequestTimeoutMs: z.coerce.number().int().positive().optional(),
      readingBufferMaxSize: z.coerce.number().int().positive().max(25_000).optional(),
    })
    .optional(),
});

const createInstanceSchema = z.object({
  instanceName: z.string().min(1),
  templateId: z.enum(DEVICE_TEMPLATE_IDS),
  serialNumber: z.string().min(1).default("1"),
  polling: pollingOverridesSchema.optional(),
});

// Reused for both create and update - both take the exact same
// user-facing fields.
const upsertInstanceSchema = createInstanceSchema;

// Ports must stay collision-free against every OTHER instance already in
// the store: the smallest free port for the template's protocol, judged by
// the ports the records actually hold (not by replaying the fleet
// sequence, which after a deletion handed out a remaining instance's port
// - see port-allocator.ts's nextFreePort()). `excludeId` leaves the
// instance being edited out of that baseline, so editing it doesn't
// collide with its own current port.
function allocatePortsFor(store: InstanceStore, templateId: DeviceTemplateId, excludeId?: string): Ports {
  const usedPorts = store
    .list()
    .filter((record) => record.id !== excludeId)
    .map((record) => record.ports);
  return nextFreePort(templateId, usedPorts);
}

// Secure by default (matches the library-level default in
// ferrion-client/http-client.ts) - a real production ferrion has a
// properly issued certificate, and someone deploying against one
// shouldn't have to know this field exists to get a validated TLS
// connection. Previously defaulted to false, reasoning from ferrion's
// local self-signed-cert dev setup as the common case - but the Web UI's
// settings form had no checkbox for this at all, so that default was
// silently disabling certificate validation for every gateway configured
// through it, dev or not, with no way to even notice. The form now has
// an explicit checkbox (unchecked by default = validated) for the local
// self-signed-cert case instead.
const settingsSchema = z.object({
  baseUrl: ferrionBaseUrlSchema.default("https://localhost:3000"),
  // Optional: omitted entirely on a save that isn't changing the key -
  // see the PUT handler's merge-with-existing logic and redactSettings()
  // below for why the real value is never sent back to the browser to
  // begin with, so the Web UI has nothing to resubmit unless the user is
  // actively typing a new one.
  apiKey: z.string().min(1).optional(),
  rejectUnauthorized: z.boolean().default(true),
});

// GET /api/settings (and PUT's own response) never echo the real apiKey
// back - it's a live credential and this endpoint has no authentication
// of its own (see server.ts's startup warning). hasApiKey lets the Web UI
// show "a key is already configured" without ever holding the plaintext
// value itself unless the user is actively entering a new one.
function redactSettings(settings: FerrionSettings): Omit<FerrionSettings, "apiKey"> & { hasApiKey: boolean } {
  const { apiKey: _apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: true };
}

// Every real payload this API ever receives (settings, instance
// create/update) is a few hundred bytes - generous headroom, not a real
// constraint on legitimate use. This endpoint has no authentication (see
// server.ts), so without a cap, buffering an unbounded request body here
// is a trivial single-request memory-exhaustion DoS against anyone who
// can reach it.
const MAX_REQUEST_BODY_BYTES = 1_000_000;

class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

// Malformed JSON is the caller's mistake, not an internal error: it used to
// fall through to the generic 500 with a stack trace in the log, which a
// caller could also trigger at will (review 2026-09, N-1).
class BadRequestError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    // Deliberately not req.destroy() here - that resets the TCP
    // connection before the 413 response below ever gets a chance to go
    // out, so the caller sees a raw connection error instead of an
    // actual, readable error response. Simply stopping the read (break,
    // then throw) still avoids buffering the rest of an oversized body -
    // Node just leaves the remainder in the OS socket buffer until this
    // response completes and the connection is cleaned up normally.
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestError("Malformed JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function toInstanceConfig(record: InstanceRecord, settings: FerrionSettings): InstanceConfig {
  return {
    instanceName: record.instanceName,
    ferrion: settings,
    device: record.device,
    ports: record.ports,
    // pollingSchema.parse() fills in its own defaults for whichever fields
    // record.polling doesn't set - same call as before for an instance
    // created before the "Erweitert" section existed (record.polling is
    // undefined then, same as pollingSchema.parse({})).
    polling: pollingSchema.parse(record.polling ?? {}),
    // Only ever set via the dedicated bridge-settings route (see the PUT
    // /api/instances/:id/bridge-settings handler below) - resilienceSchema
    // fills in its own defaults for whichever fields record.resilience
    // doesn't set, same as polling above.
    resilience: resilienceSchema.parse(record.resilience ?? {}),
    logLevel: envLogLevel(),
    // false for every simulated (has-a-device) instance - see schema.ts's
    // runReadingLoop doc comment: the control-plane always also runs the
    // bridge singleton (no device, so this stays true for it) under the
    // same shared API key, which already discovers/reads/pushes every
    // data source including ones pointing at a simulated instance's own
    // local protocol server. A simulated instance's job here is only to
    // run that local server - not to also read it itself.
    runReadingLoop: !record.device,
  };
}

// Instance records carry no secret - the ferrion API key lives only in
// settings-store and is never part of an InstanceRecord - so this is safe
// to return as-is. (An earlier version of this comment claimed the API key
// was "returned in full" here; it never was, and a 2026-09-12 audit
// confirmed GET /api/instances contains no key field.)
function serializeInstance(record: InstanceRecord, processManager: ProcessManager) {
  return { ...record, ...processManager.getStatus(record.id) };
}

const BRIDGE_INSTANCE_NAME = "bridge";

// Called once at control-plane boot (see server.ts), before
// resumeAutoStartInstances() below so the record it creates/fixes up is
// already there for that same boot cycle to start. A bridge-only instance
// (no device - see instance-store.ts's InstanceRecord.device doc comment)
// is meant to be a singleton: every instance under the same ferrion API
// key gets the identical full data-source list from
// GET /api/gateway/data-sources (scoped by gateway, not by local
// instance), so two bridge-only instances running at once would
// redundantly double-connect to the same real hardware. Rather than the
// Web UI merely discouraging a second one, this makes it structurally
// impossible: bridge-only instances are never created through the normal
// POST /api/instances path at all (see createInstanceSchema.templateId's
// return to being required) - this function is the only thing that ever
// creates one. Self-healing: if the record is ever deleted out from
// under this (e.g. manual data/instances.json editing), it's recreated
// on the next boot.
export function ensureBridgeInstance(store: InstanceStore): void {
  const existing = store.list().find((record) => !record.device);
  if (existing) {
    if (!existing.autoStart) store.setAutoStart(existing.id, true);
    return;
  }
  store.create({ instanceName: BRIDGE_INSTANCE_NAME, ports: {}, autoStart: true });
}

// Called once at control-plane boot (see server.ts), and again after
// PUT /api/settings below - ProcessManager's own state is runtime-only
// (see its doc comment), so without this, every instance that was
// intentionally running sits idle after a control-plane restart/redeploy,
// or after a first-time ferrion connection setup, until someone notices
// and clicks Start again, even though its config never changed. Silently
// does nothing if ferrion settings aren't configured yet - matches the
// /start handler's own guard, and there's nothing useful to start without
// them anyway.
export function resumeAutoStartInstances(
  store: InstanceStore,
  processManager: ProcessManager,
  settingsStore: SettingsStore,
): void {
  const settings = settingsStore.get();
  if (!settings) return;
  for (const record of store.list()) {
    if (record.autoStart) {
      processManager.start(record.id, toInstanceConfig(record, settings), { keepAlive: !record.device });
    }
  }
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: InstanceStore,
  processManager: ProcessManager,
  settingsStore: SettingsStore,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] !== "api") {
    return false;
  }

  // Refuse a cross-site browser write before it reaches any handler - see
  // csrf-guard.ts. Non-browser callers and the same-origin UI pass through.
  if (isCrossSiteWrite(req.method, req.headers)) {
    sendJson(res, 403, { error: "Cross-site request blocked" });
    return true;
  }

  try {
    if (segments[1] === "settings" && segments.length === 2 && req.method === "GET") {
      const settings = settingsStore.get();
      sendJson(res, 200, settings ? redactSettings(settings) : null);
      return true;
    }

    if (segments[1] === "settings" && segments.length === 2 && req.method === "PUT") {
      const parsed = settingsSchema.parse(await readJsonBody(req));
      const existing = settingsStore.get();
      const apiKey = parsed.apiKey ?? existing?.apiKey;
      if (!apiKey) {
        sendJson(res, 400, { error: "API key is required" });
        return true;
      }
      // Pointing the stored key at a *different* host requires typing the
      // key again: whoever can reach this route without knowing the key
      // (a cross-site or DNS-rebinding page, see host-guard.ts) can then
      // not turn it into a key exfiltration. Private/on-prem ferrion hosts
      // stay fully allowed - this asks for the key, not for a public name.
      // Hostname, not host: a port change on the same machine is a
      // deployment detail, not a new recipient.
      if (
        existing &&
        parsed.apiKey === undefined &&
        new URL(parsed.baseUrl).hostname !== new URL(existing.baseUrl).hostname
      ) {
        sendJson(res, 400, { error: "Re-enter the API key when changing the base URL" });
        return true;
      }
      const toSave: FerrionSettings = { baseUrl: parsed.baseUrl, apiKey, rejectUnauthorized: parsed.rejectUnauthorized };
      settingsStore.save(toSave);
      const connectionChanged =
        existing !== undefined &&
        (existing.baseUrl !== toSave.baseUrl ||
          existing.apiKey !== toSave.apiKey ||
          existing.rejectUnauthorized !== toSave.rejectUnauthorized);
      if (connectionChanged) {
        // Config is construction-time-only for a running instance (see
        // ProcessManager.restart()), and the bridge can never be stopped by
        // hand - so a rotated key or a moved ferrion used to reach the
        // running bridge only after a control-plane restart, while the
        // status indicator (checked with the *new* settings) already said
        // "connected" (review 2026-09, M-4). Restarted one after another,
        // not in parallel - every one of them shares the device.
        for (const record of store.list()) {
          if (record.autoStart || processManager.isRunning(record.id)) {
            await processManager.restart(record.id, toInstanceConfig(record, toSave), { keepAlive: !record.device });
          }
        }
      } else {
        // Starts anything left waiting on a ferrion connection that didn't
        // exist yet at boot (most notably the bridge instance on a brand
        // new setup) - without this, a fresh autoStart:true record only
        // ever starts on the *next* control-plane restart.
        resumeAutoStartInstances(store, processManager, settingsStore);
      }
      sendJson(res, 200, redactSettings(toSave));
      return true;
    }

    if (segments[1] === "settings" && segments.length === 2 && req.method === "DELETE") {
      const deleted = settingsStore.clear();
      sendJson(res, 200, { deleted });
      return true;
    }

    if (segments[1] === "settings" && segments[2] === "status" && segments.length === 3 && req.method === "GET") {
      const settings = settingsStore.get();
      if (!settings) {
        sendJson(res, 200, { status: "unconfigured", checkedAt: new Date().toISOString() });
        return true;
      }
      const result = await checkFerrionConnectivity(settings);
      sendJson(res, 200, result);
      return true;
    }

    // Container HEALTHCHECK target (see Dockerfile). "ok" while ferrion is
    // not configured yet (nothing can be wrong that this could report) and
    // while the bridge instance is running or starting; 503 once the bridge
    // sits in "error" - the one state that means no readings are flowing
    // and the keepAlive restarts are not getting it back. Deliberately not
    // "any simulated instance in error": those are test fixtures a user
    // starts and stops by hand.
    if (segments[1] === "health" && segments.length === 2 && req.method === "GET") {
      const bridge = store.list().find((record) => !record.device);
      const bridgeStatus = bridge ? processManager.getStatus(bridge.id).status : "stopped";
      const configured = settingsStore.get() !== undefined;
      const healthy = !configured || bridgeStatus !== "error";
      sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded", configured, bridge: bridgeStatus });
      return true;
    }

    if (segments[1] === "about" && segments.length === 2 && req.method === "GET") {
      sendJson(res, 200, getAppInfo());
      return true;
    }

    if (segments[1] === "templates" && segments.length === 2 && req.method === "GET") {
      sendJson(
        res,
        200,
        DEVICE_TEMPLATES.map((template) => ({
          id: template.id,
          manufacturer: template.manufacturer,
          model: template.model,
          protocol: template.protocol,
        })),
      );
      return true;
    }

    if (segments[1] !== "instances") {
      return false;
    }

    if (segments.length === 2 && req.method === "GET") {
      sendJson(res, 200, { instances: store.list().map((record) => serializeInstance(record, processManager)) });
      return true;
    }

    if (segments.length === 2 && req.method === "POST") {
      const parsed = createInstanceSchema.parse(await readJsonBody(req));
      const ports = allocatePortsFor(store, parsed.templateId);

      const record = store.create({
        instanceName: parsed.instanceName,
        device: { templateId: parsed.templateId, serialNumber: parsed.serialNumber },
        ports,
        polling: parsed.polling,
      });
      sendJson(res, 201, serializeInstance(record, processManager));
      return true;
    }

    if (segments.length === 3 && req.method === "PUT") {
      const id = segments[2] as string;
      const existing = store.get(id);
      if (!existing) {
        sendJson(res, 404, { error: "Instance not found" });
        return true;
      }
      if (!existing.device) {
        sendJson(res, 400, { error: "The bridge instance is managed automatically and cannot be edited" });
        return true;
      }
      if (processManager.isRunning(id)) {
        sendJson(res, 400, { error: "Stop the instance before editing it" });
        return true;
      }

      const parsed = upsertInstanceSchema.parse(await readJsonBody(req));
      // Every template maps to exactly one protocol, so any templateId
      // change is also a protocol change - the old port no longer applies
      // and a fresh one must be allocated. Keep the current port
      // untouched if the template didn't change, so re-saving the same
      // instance never shuffles an unrelated instance's port.
      const ports =
        parsed.templateId === existing.device.templateId
          ? existing.ports
          : allocatePortsFor(store, parsed.templateId, id);

      const record = store.update(id, {
        instanceName: parsed.instanceName,
        device: { templateId: parsed.templateId, serialNumber: parsed.serialNumber },
        ports,
        polling: parsed.polling,
      });
      if (!record) {
        sendJson(res, 500, { error: "Failed to update instance" });
        return true;
      }
      sendJson(res, 200, serializeInstance(record, processManager));
      return true;
    }

    if (segments.length === 4 && segments[3] === "bridge-settings" && req.method === "PUT") {
      const id = segments[2] as string;
      const existing = store.get(id);
      if (!existing) {
        sendJson(res, 404, { error: "Instance not found" });
        return true;
      }
      if (existing.device) {
        sendJson(res, 400, { error: "This endpoint only applies to the bridge instance" });
        return true;
      }

      const parsed = bridgeSettingsSchema.parse(await readJsonBody(req));
      const record = store.updateSettings(id, { polling: parsed.polling, resilience: parsed.resilience });
      if (!record) {
        sendJson(res, 500, { error: "Failed to update instance" });
        return true;
      }

      // The bridge can never be manually stopped (see the DELETE/stop
      // handlers below), and config only ever takes effect at a process's
      // construction time (see ProcessManager.restart()'s doc comment) -
      // without this, a saved setting would silently not apply until the
      // next control-plane restart. Nothing to restart if ferrion isn't
      // configured yet - resumeAutoStartInstances() will pick up the new
      // settings whenever it does eventually start.
      const settings = settingsStore.get();
      if (settings) {
        await processManager.restart(id, toInstanceConfig(record, settings), { keepAlive: true });
      }

      sendJson(res, 200, serializeInstance(record, processManager));
      return true;
    }

    if (segments.length === 3 && req.method === "DELETE") {
      const id = segments[2] as string;
      const existing = store.get(id);
      if (!existing) {
        sendJson(res, 404, { error: "Instance not found" });
        return true;
      }
      if (!existing.device) {
        sendJson(res, 400, { error: "The bridge instance is managed automatically and cannot be deleted" });
        return true;
      }
      await processManager.remove(id);
      const removed = store.remove(id);
      sendJson(res, removed ? 200 : 404, { removed });
      return true;
    }

    if (segments.length === 4 && (segments[3] === "start" || segments[3] === "stop") && req.method === "POST") {
      const id = segments[2] as string;
      const record = store.get(id);
      if (!record) {
        sendJson(res, 404, { error: "Instance not found" });
        return true;
      }
      let updated: InstanceRecord = record;
      if (segments[3] === "start") {
        const settings = settingsStore.get();
        if (!settings) {
          sendJson(res, 400, { error: "ferrion settings not configured yet - set the API key first" });
          return true;
        }
        processManager.start(id, toInstanceConfig(record, settings), { keepAlive: !record.device });
        updated = store.setAutoStart(id, true) ?? record;
      } else {
        if (!record.device) {
          sendJson(res, 400, { error: "The bridge instance is managed automatically and cannot be stopped" });
          return true;
        }
        // Awaited: the response then reflects an instance that has actually
        // exited (bounded by stop()'s own escalation), not one still going.
        await processManager.stop(id);
        updated = store.setAutoStart(id, false) ?? record;
      }
      // Not the stale `record` captured above: setAutoStart() already
      // returns the post-update record, so the response's `autoStart`
      // reflects what was actually just persisted, not what was true
      // before this request.
      sendJson(res, 200, serializeInstance(updated, processManager));
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendJson(res, 400, { error: "Invalid request", details: error.issues });
      return true;
    }
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: error.message });
      return true;
    }
    if (error instanceof BadRequestError) {
      sendJson(res, 400, { error: error.message });
      return true;
    }
    // Detail to the server log, not the client: an internal error message
    // can carry file paths or library internals, and the caller can act on
    // none of it. The specific, actionable errors (validation, payload size)
    // are already returned above.
    console.error("[control-plane] unhandled error", error);
    sendJson(res, 500, { error: "Internal error" });
    return true;
  }
}
