import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBridgeInstance, handleApiRequest, resumeAutoStartInstances } from "./routes.js";
import { InstanceStore } from "./instance-store.js";
import { SettingsStore } from "./settings-store.js";
import type { InstanceStatus, InstanceStatusSnapshot, ProcessManager } from "./process-manager.js";

function fakeProcessManager(overrides: Partial<ProcessManager> = {}): ProcessManager {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({ status: "stopped" }),
    stopAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProcessManager;
}

interface TestContext {
  baseUrl: string;
  store: InstanceStore;
  settingsStore: SettingsStore;
  processManager: ProcessManager;
}

function startTestServer(processManager: ProcessManager): Promise<{ server: Server; context: TestContext }> {
  const dir = mkdtempSync(join(tmpdir(), "ferrion-gateway-routes-test-"));
  const store = new InstanceStore(join(dir, "instances.json"));
  const settingsStore = new SettingsStore(join(dir, "settings.json"));

  const server = createServer((req, res) => {
    void handleApiRequest(req, res, store, processManager, settingsStore).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, context: { baseUrl: `http://127.0.0.1:${port}`, store, settingsStore, processManager } });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function errorBody(response: Response): Promise<{ error: string }> {
  return (await response.json()) as { error: string };
}

interface TestInstanceRecord {
  id: string;
  instanceName: string;
  // Absent for a bridge-only instance (no local simulated device) - see
  // instance-store.ts's InstanceRecord.device doc comment.
  device?: { templateId: string; serialNumber: string };
  ports: Record<string, number>;
  polling?: { readingIntervalMs?: number; readingsPushIntervalMs?: number; aggregation?: string };
  status: string;
  lastEventAt?: string;
  autoStart?: boolean;
}

async function createInstance(
  baseUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<TestInstanceRecord> {
  const response = await fetch(`${baseUrl}/api/instances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceName: "test-instance",
      templateId: "aventics-ds1-modbus-tcp",
      serialNumber: "1",
      ...overrides,
    }),
  });
  return (await response.json()) as TestInstanceRecord;
}


describe("handleApiRequest", () => {
  let server: Server;
  let ctx: TestContext;

  beforeEach(async () => {
    const started = await startTestServer(fakeProcessManager());
    server = started.server;
    ctx = started.context;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns false (unhandled) for paths outside /api", async () => {
    const response = await fetch(`${ctx.baseUrl}/index.html`);
    expect(response.status).toBe(404);
  });

  describe("GET /api/about", () => {
    it("returns name/version/contact, version matching the real package.json", async () => {
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
        version: string;
      };
      const response = await fetch(`${ctx.baseUrl}/api/about`);
      const body = (await response.json()) as {
        name: string;
        version: string;
        description: { de: string; en: string };
        contact: { name: string; street: string; postalCode: string; city: string; country: string };
      };
      expect(response.status).toBe(200);
      expect(body.name).toBe("ferrion Gateway");
      expect(body.version).toBe(pkg.version);
      expect(body.description.de.length).toBeGreaterThan(0);
      expect(body.description.en.length).toBeGreaterThan(0);
      expect(body.contact).toEqual(
        expect.objectContaining({ name: expect.any(String), city: expect.any(String) }),
      );
    });
  });

  describe("GET /api/health", () => {
    it("is ok while ferrion is not configured, whatever the bridge is doing", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", configured: false, bridge: "stopped" });
    });

    it("is ok while the configured bridge runs, and 503 once it sits in error", async () => {
      const statuses: Record<string, { status: InstanceStatus }> = {};
      const processManager = fakeProcessManager({
        getStatus: vi.fn((id: string): InstanceStatusSnapshot => statuses[id] ?? { status: "stopped" }),
      });
      const started = await startTestServer(processManager);
      try {
        ensureBridgeInstance(started.context.store);
        const bridge = started.context.store.list().find((record) => !record.device)!;
        started.context.settingsStore.save({ baseUrl: "https://ferrion.example", apiKey: "gw_x", rejectUnauthorized: true });

        statuses[bridge.id] = { status: "running" };
        expect((await fetch(`${started.context.baseUrl}/api/health`)).status).toBe(200);

        statuses[bridge.id] = { status: "error" };
        const degraded = await fetch(`${started.context.baseUrl}/api/health`);
        expect(degraded.status).toBe(503);
        expect(await degraded.json()).toEqual({ status: "degraded", configured: true, bridge: "error" });
      } finally {
        await closeServer(started.server);
      }
    });
  });

  describe("GET /api/templates", () => {
    it("lists the device catalog with id/manufacturer/model/protocol", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/templates`);
      const templates = (await response.json()) as Array<{ id: string; manufacturer: string }>;
      expect(response.status).toBe(200);
      expect(templates.length).toBeGreaterThan(0);
      expect(templates[0]).toEqual(
        expect.objectContaining({ id: expect.any(String), manufacturer: expect.any(String) }),
      );
    });
  });

  describe("/api/settings", () => {
    it("GET returns null before anything has been saved", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings`);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    });

    it("PUT validates, saves, and echoes the settings back without the raw apiKey", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        baseUrl: "https://localhost:3000",
        hasApiKey: true,
        rejectUnauthorized: true,
      });

      const getResponse = await fetch(`${ctx.baseUrl}/api/settings`);
      expect(await getResponse.json()).toEqual({
        baseUrl: "https://localhost:3000",
        hasApiKey: true,
        rejectUnauthorized: true,
      });
      // The real key is still what's actually used to talk to ferrion -
      // only the HTTP response redacts it (this endpoint has no auth of
      // its own, see server.ts).
      expect(ctx.settingsStore.get()?.apiKey).toBe("gw_abc");
    });

    it("PUT rejects a missing apiKey with 400 when nothing was saved before", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000" }),
      });
      expect(response.status).toBe(400);
      expect((await errorBody(response)).error).toBe("API key is required");
    });

    it("PUT rejects a request body over 1MB with 413, without ever finishing the JSON parse", async () => {
      const oversizedApiKey = "x".repeat(1_100_000);
      const response = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: oversizedApiKey }),
      });
      expect(response.status).toBe(413);
      expect((await errorBody(response)).error).toBe("Request body too large");
    });

    it("PUT keeps the previously saved apiKey when the field is omitted", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_original" }),
      });

      const response = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:4000" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        baseUrl: "https://localhost:4000",
        hasApiKey: true,
        rejectUnauthorized: true,
      });
      expect(ctx.settingsStore.get()?.apiKey).toBe("gw_original");
    });

    it("PUT replaces the apiKey when a new one is provided", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_original" }),
      });

      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_new" }),
      });

      expect(ctx.settingsStore.get()?.apiKey).toBe("gw_new");
    });

    it("PUT immediately starts any autoStart:true instance that was only waiting on this connection", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();
      expect(ctx.processManager.start).not.toHaveBeenCalled();

      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });

      expect(ctx.processManager.start).toHaveBeenCalledWith(bridge!.id, expect.anything(), { keepAlive: true });
    });

    it("PUT restarts running and autoStart instances with the new connection when the key or URL changed (review M-4)", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();
      const put = (body: Record<string, unknown>) =>
        fetch(`${ctx.baseUrl}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      await put({ baseUrl: "https://ferrion.example", apiKey: "gw_one" });
      expect(ctx.processManager.restart).not.toHaveBeenCalled();

      await put({ baseUrl: "https://ferrion.example", apiKey: "gw_two" });
      expect(ctx.processManager.restart).toHaveBeenCalledWith(
        bridge!.id,
        expect.objectContaining({ ferrion: expect.objectContaining({ apiKey: "gw_two" }) }),
        { keepAlive: true },
      );

      // Same connection again: nothing to restart.
      vi.mocked(ctx.processManager.restart).mockClear();
      await put({ baseUrl: "https://ferrion.example" });
      expect(ctx.processManager.restart).not.toHaveBeenCalled();
    });

    it("DELETE clears previously saved settings and reports whether anything was cleared", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });

      const response = await fetch(`${ctx.baseUrl}/api/settings`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: true });

      const getResponse = await fetch(`${ctx.baseUrl}/api/settings`);
      expect(await getResponse.json()).toBeNull();
    });

    it("DELETE reports deleted:false when nothing was configured", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings`, { method: "DELETE" });
      expect(await response.json()).toEqual({ deleted: false });
    });

    it("GET /status reports unconfigured before any settings are saved", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings/status`);
      const body = (await response.json()) as { status: string; checkedAt: string };
      expect(response.status).toBe(200);
      expect(body.status).toBe("unconfigured");
      expect(body.checkedAt).toBeTruthy();
    });

    it("GET /status reports unreachable for a configured but unreachable ferrion", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:1", apiKey: "gw_abc" }),
      });

      const response = await fetch(`${ctx.baseUrl}/api/settings/status`);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("unreachable");
    });
  });

  describe("request hygiene (review 2026-09)", () => {
    it("answers malformed JSON with 400, not 500", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{bad",
      });
      expect(response.status).toBe(400);
      expect((await errorBody(response)).error).toMatch(/Malformed JSON/);
    });

    it("refuses a baseUrl that is not http(s) or carries credentials", async () => {
      for (const baseUrl of ["ftp://ferrion.example", "javascript:alert(1)", "https://user:pw@ferrion.example"]) {
        const response = await fetch(`${ctx.baseUrl}/api/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: "gw_x" }),
        });
        expect(response.status, baseUrl).toBe(400);
      }
    });

    it("requires the API key again when the base URL moves to another host, but not for a same-host edit", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://ferrion.example", apiKey: "gw_secret" }),
      });

      const moved = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://attacker.example" }),
      });
      expect(moved.status).toBe(400);
      expect((await errorBody(moved)).error).toMatch(/Re-enter the API key/);
      expect(ctx.settingsStore.get()?.baseUrl).toBe("https://ferrion.example");

      const sameHost = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://ferrion.example/", rejectUnauthorized: false }),
      });
      expect(sameHost.status).toBe(200);
      expect(ctx.settingsStore.get()?.apiKey).toBe("gw_secret");

      const withKey = await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://other.example", apiKey: "gw_new" }),
      });
      expect(withKey.status).toBe(200);
      expect(ctx.settingsStore.get()).toMatchObject({ baseUrl: "https://other.example", apiKey: "gw_new" });
    });
  });

  describe("POST /api/instances", () => {
    it("creates an instance and auto-allocates its port", async () => {
      const record = await createInstance(ctx.baseUrl);
      expect(record.instanceName).toBe("test-instance");
      expect(record.device).toEqual({ templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" });
      expect(record.ports).toEqual({ modbus: 5502 });
      expect(record.status).toBe("stopped");
    });

    it("keeps ports collision-free against instances already in the store", async () => {
      await createInstance(ctx.baseUrl, { instanceName: "first" });
      const second = await createInstance(ctx.baseUrl, { instanceName: "second" });
      expect(second.ports).toEqual({ modbus: 5503 });
    });

    it("never hands a remaining instance's port to a new one after a deletion (review H-6)", async () => {
      const first = await createInstance(ctx.baseUrl, { instanceName: "first" });
      const second = await createInstance(ctx.baseUrl, { instanceName: "second" });
      expect(second.ports).toEqual({ modbus: 5503 });

      await fetch(`${ctx.baseUrl}/api/instances/${first.id}`, { method: "DELETE" });
      const third = await createInstance(ctx.baseUrl, { instanceName: "third" });

      // 5502 is free again, 5503 is still the second instance's.
      expect(third.ports).toEqual({ modbus: 5502 });
      const fourth = await createInstance(ctx.baseUrl, { instanceName: "fourth" });
      expect(fourth.ports).toEqual({ modbus: 5504 });
    });

    it("rejects an unknown templateId with 400", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "x", templateId: "not-a-real-template" }),
      });
      expect(response.status).toBe(400);
    });

    it("persists polling overrides when given", async () => {
      const record = await createInstance(ctx.baseUrl, {
        polling: { readingIntervalMs: 10, readingsPushIntervalMs: 3000, aggregation: "avg" },
      });
      expect(record.polling).toEqual({ readingIntervalMs: 10, readingsPushIntervalMs: 3000, aggregation: "avg" });
    });

    it("leaves polling unset when omitted", async () => {
      const record = await createInstance(ctx.baseUrl);
      expect(record.polling).toBeUndefined();
    });

    it("rejects a non-positive readingIntervalMs with 400", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceName: "x",
          templateId: "aventics-ds1-modbus-tcp",
          polling: { readingIntervalMs: 0 },
        }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects a POST with no templateId - bridge-only instances are never created through this endpoint", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "x" }),
      });
      expect(response.status).toBe(400);
    });

    it("still allocates a fresh port for a new simulated instance while the bridge instance already exists", async () => {
      ensureBridgeInstance(ctx.store);

      const record = await createInstance(ctx.baseUrl, { instanceName: "simulated-1" });

      expect(record.device).toEqual({ templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" });
      expect(record.ports).toEqual({ modbus: 5502 });
    });
  });

  describe("GET /api/instances", () => {
    it("merges each record with its live status from the process manager", async () => {
      const processManager = fakeProcessManager({
        getStatus: vi.fn().mockReturnValue({ status: "running", lastEventAt: "2026-08-16T00:00:00.000Z" }),
      });
      const started = await startTestServer(processManager);
      await closeServer(server);
      server = started.server;
      ctx = started.context;

      await createInstance(ctx.baseUrl);
      const response = await fetch(`${ctx.baseUrl}/api/instances`);
      const { instances } = (await response.json()) as { instances: TestInstanceRecord[] };

      expect(instances).toHaveLength(1);
      const [instance] = instances;
      expect(instance?.status).toBe("running");
      expect(instance?.lastEventAt).toBe("2026-08-16T00:00:00.000Z");
    });
  });

  describe("PUT /api/instances/:id", () => {
    it("updates instanceName/device, keeping the same port when the template is unchanged", async () => {
      const record = await createInstance(ctx.baseUrl, { instanceName: "before" });

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "after", templateId: "aventics-ds1-modbus-tcp", serialNumber: "2" }),
      });
      const updated = (await response.json()) as TestInstanceRecord;

      expect(response.status).toBe(200);
      expect(updated.instanceName).toBe("after");
      expect(updated.device?.serialNumber).toBe("2");
      expect(updated.ports).toEqual({ modbus: 5502 });
      expect(updated.id).toBe(record.id);
    });

    it("re-allocates a port when the template (and therefore protocol) changes", async () => {
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "test-instance", templateId: "aventics-af2-opcua", serialNumber: "10000456" }),
      });
      const updated = (await response.json()) as TestInstanceRecord;

      expect(response.status).toBe(200);
      expect(updated.ports).toEqual({ opcua: 4840 });
    });

    it("does not shuffle another instance's port when editing one instance", async () => {
      const first = await createInstance(ctx.baseUrl, { instanceName: "first" });
      const second = await createInstance(ctx.baseUrl, {
        instanceName: "second",
        templateId: "aventics-af2-opcua",
        serialNumber: "1",
      });
      expect(second.ports).toEqual({ opcua: 4840 });

      await fetch(`${ctx.baseUrl}/api/instances/${first.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "first-renamed", templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" }),
      });

      expect(ctx.store.get(second.id)?.ports).toEqual({ opcua: 4840 });
    });

    it("returns 404 for an unknown id", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances/does-not-exist`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "x", templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" }),
      });
      expect(response.status).toBe(404);
    });

    it("returns 400 and does not modify the record if the instance is currently running", async () => {
      const started = await startTestServer(fakeProcessManager({ isRunning: vi.fn().mockReturnValue(true) }));
      await closeServer(server);
      server = started.server;
      ctx = started.context;
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "renamed", templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" }),
      });

      expect(response.status).toBe(400);
      expect((await errorBody(response)).error).toMatch(/Stop the instance/);
      expect(ctx.store.get(record.id)?.instanceName).toBe("test-instance");
    });

    it("rejects editing the bridge instance with 400", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "renamed", templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" }),
      });

      expect(response.status).toBe(400);
      expect(ctx.store.get(bridge!.id)?.instanceName).toBe("bridge");
    });

    it("still edits a simulated instance's port allocation correctly while the bridge instance exists", async () => {
      ensureBridgeInstance(ctx.store);
      const record = await createInstance(ctx.baseUrl, { instanceName: "simulated-1" });

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceName: "simulated-1", templateId: "aventics-af2-opcua", serialNumber: "1" }),
      });
      const updated = (await response.json()) as TestInstanceRecord;

      expect(response.status).toBe(200);
      expect(updated.ports).toEqual({ opcua: 4840 });
    });
  });

  describe("PUT /api/instances/:id/bridge-settings", () => {
    it("returns 404 for an unknown id", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances/does-not-exist/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
    });

    it("returns 400 for a simulated (non-bridge) instance, leaving it untouched", async () => {
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resilience: { readingBufferMaxSize: 500 } }),
      });

      expect(response.status).toBe(400);
      expect((await errorBody(response)).error).toMatch(/only applies to the bridge instance/);
      expect(ctx.store.get(record.id)?.resilience).toBeUndefined();
    });

    it("rejects a readingBufferMaxSize above ferrion's per-push cap of 25 000", async () => {
      ensureBridgeInstance(ctx.store);
      const bridge = ctx.store.list().find((record) => !record.device)!;
      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resilience: { readingBufferMaxSize: 30_000 } }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for an invalid body", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resilience: { readingBufferMaxSize: -1 } }),
      });

      expect(response.status).toBe(400);
    });

    it("persists polling and resilience overrides for the bridge instance", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          polling: { readingIntervalMs: 1000, aggregation: "avg" },
          resilience: { httpRequestTimeoutMs: 5000, readingBufferMaxSize: 500 },
        }),
      });
      const updated = (await response.json()) as TestInstanceRecord;

      expect(response.status).toBe(200);
      expect(updated.polling).toEqual({ readingIntervalMs: 1000, aggregation: "avg" });
      expect(ctx.store.get(bridge!.id)?.resilience).toEqual({ httpRequestTimeoutMs: 5000, readingBufferMaxSize: 500 });
    });

    it("does not restart the process manager when ferrion settings aren't configured yet", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resilience: { readingBufferMaxSize: 500 } }),
      });

      expect(ctx.processManager.restart).not.toHaveBeenCalled();
    });

    it("restarts the bridge process with keepAlive so the new settings actually take effect", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/bridge-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resilience: { readingBufferMaxSize: 500 } }),
      });

      expect(ctx.processManager.restart).toHaveBeenCalledWith(
        bridge!.id,
        expect.objectContaining({
          resilience: expect.objectContaining({ readingBufferMaxSize: 500 }),
        }),
        { keepAlive: true },
      );
    });
  });

  describe("DELETE /api/instances/:id", () => {
    it("stops and removes an existing instance", async () => {
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}`, { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removed: true });
      expect(ctx.processManager.remove).toHaveBeenCalledWith(record.id);
      expect(ctx.store.get(record.id)).toBeUndefined();
    });

    it("returns 404 for an unknown id", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances/does-not-exist`, { method: "DELETE" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Instance not found" });
    });

    it("rejects deleting the bridge instance with 400, leaving it in place", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}`, { method: "DELETE" });

      expect(response.status).toBe(400);
      expect(ctx.processManager.stop).not.toHaveBeenCalled();
      expect(ctx.store.get(bridge!.id)).toBeDefined();
    });
  });

  describe("POST /api/instances/:id/start", () => {
    it("returns 400 without touching the process manager when settings aren't configured yet", async () => {
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      expect(response.status).toBe(400);
      expect((await errorBody(response)).error).toMatch(/settings not configured/);
      expect(ctx.processManager.start).not.toHaveBeenCalled();
    });

    it("starts the instance with the saved ferrion settings once configured", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      expect(response.status).toBe(200);
      expect(ctx.processManager.start).toHaveBeenCalledWith(
        record.id,
        expect.objectContaining({
          instanceName: "test-instance",
          ferrion: { baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: true },
          device: { templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" },
          ports: { modbus: 5502 },
        }),
        { keepAlive: false },
      );
    });

    it("marks the record autoStart:true, so it resumes after a control-plane restart", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);

      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      expect(ctx.store.get(record.id)?.autoStart).toBe(true);
    });

    it("echoes the just-updated autoStart:true in the response body, not the pre-request value", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);
      expect(record.autoStart).toBeFalsy();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });
      const body = (await response.json()) as TestInstanceRecord;

      expect(body.autoStart).toBe(true);
    });

    it("returns 404 for an unknown instance id", async () => {
      const response = await fetch(`${ctx.baseUrl}/api/instances/does-not-exist/start`, { method: "POST" });
      expect(response.status).toBe(404);
    });

    it("starts a simulated instance without keepAlive, but the bridge instance with keepAlive - so it self-heals from a crash", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list().filter((r) => !r.device);

      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });
      await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/start`, { method: "POST" });

      expect(ctx.processManager.start).toHaveBeenCalledWith(record.id, expect.anything(), { keepAlive: false });
      expect(ctx.processManager.start).toHaveBeenCalledWith(bridge!.id, expect.anything(), { keepAlive: true });
    });

    it("disables a simulated instance's own reading loop, but keeps it enabled for the bridge instance", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list().filter((r) => !r.device);

      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });
      await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/start`, { method: "POST" });

      // The control-plane's bridge singleton already discovers/reads/pushes
      // every data source under the shared API key (including ones
      // pointing at a simulated instance's own local protocol server) - a
      // simulated instance running its own reading loop too would
      // redundantly re-push the exact same readings (confirmed live: this
      // caused near-duplicate, irregularly-timed readings for one data
      // source, which broke the "Daten" tab chart's gap-highlighting).
      expect(ctx.processManager.start).toHaveBeenCalledWith(
        record.id,
        expect.objectContaining({ runReadingLoop: false }),
        { keepAlive: false },
      );
      expect(ctx.processManager.start).toHaveBeenCalledWith(
        bridge!.id,
        expect.objectContaining({ runReadingLoop: true }),
        { keepAlive: true },
      );
    });

    it("merges an instance's polling overrides into the config, defaulting anything unset", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl, { polling: { readingIntervalMs: 10, aggregation: "avg" } });

      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      expect(ctx.processManager.start).toHaveBeenCalledWith(
        record.id,
        expect.objectContaining({
          polling: expect.objectContaining({
            readingIntervalMs: 10,
            aggregation: "avg",
            readingsPushIntervalMs: 5000,
          }),
        }),
        { keepAlive: false },
      );
    });
  });

  describe("POST /api/instances/:id/stop", () => {
    it("stops the instance without requiring settings to be configured", async () => {
      const record = await createInstance(ctx.baseUrl);

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/stop`, { method: "POST" });

      expect(response.status).toBe(200);
      expect(ctx.processManager.stop).toHaveBeenCalledWith(record.id);
    });

    it("marks the record autoStart:false, so it does not resume after a control-plane restart", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);
      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/stop`, { method: "POST" });

      expect(ctx.store.get(record.id)?.autoStart).toBe(false);
    });

    it("echoes the just-updated autoStart:false in the response body, not the pre-request value", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const record = await createInstance(ctx.baseUrl);
      await fetch(`${ctx.baseUrl}/api/instances/${record.id}/start`, { method: "POST" });

      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/stop`, { method: "POST" });
      const body = (await response.json()) as TestInstanceRecord;

      expect(body.autoStart).toBe(false);
    });

    it("rejects stopping the bridge instance with 400, leaving autoStart:true", async () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();

      const response = await fetch(`${ctx.baseUrl}/api/instances/${bridge!.id}/stop`, { method: "POST" });

      expect(response.status).toBe(400);
      expect(ctx.processManager.stop).not.toHaveBeenCalled();
      expect(ctx.store.get(bridge!.id)?.autoStart).toBe(true);
    });
  });

  describe("ensureBridgeInstance", () => {
    it("creates exactly one bridge record (no device, empty ports, autoStart:true) when none exists", () => {
      ensureBridgeInstance(ctx.store);

      const records = ctx.store.list();
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual(
        expect.objectContaining({ instanceName: "bridge", ports: {}, autoStart: true }),
      );
      expect(records[0]?.device).toBeUndefined();
    });

    it("is idempotent - a second call does not create a second bridge record", () => {
      ensureBridgeInstance(ctx.store);
      ensureBridgeInstance(ctx.store);

      expect(ctx.store.list().filter((r) => !r.device)).toHaveLength(1);
    });

    it("forces autoStart back to true if the existing bridge record somehow had it set to false", () => {
      ensureBridgeInstance(ctx.store);
      const [bridge] = ctx.store.list();
      ctx.store.setAutoStart(bridge!.id, false);

      ensureBridgeInstance(ctx.store);

      expect(ctx.store.get(bridge!.id)?.autoStart).toBe(true);
    });

    it("does not touch other (simulated) instances already in the store", async () => {
      const simulated = await createInstance(ctx.baseUrl);

      ensureBridgeInstance(ctx.store);

      expect(ctx.store.get(simulated.id)).toBeDefined();
      expect(ctx.store.list()).toHaveLength(2);
    });
  });

  describe("resumeAutoStartInstances", () => {
    it("does nothing when ferrion settings aren't configured yet", async () => {
      await createInstance(ctx.baseUrl);

      resumeAutoStartInstances(ctx.store, ctx.processManager, ctx.settingsStore);

      expect(ctx.processManager.start).not.toHaveBeenCalled();
    });

    it("starts only the records marked autoStart:true, with the current ferrion settings", async () => {
      await fetch(`${ctx.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://localhost:3000", apiKey: "gw_abc" }),
      });
      const started = await createInstance(ctx.baseUrl, { instanceName: "was-running" });
      const stopped = await createInstance(ctx.baseUrl, { instanceName: "was-stopped" });
      ctx.store.setAutoStart(started.id, true);
      ctx.store.setAutoStart(stopped.id, false);

      resumeAutoStartInstances(ctx.store, ctx.processManager, ctx.settingsStore);

      expect(ctx.processManager.start).toHaveBeenCalledTimes(1);
      expect(ctx.processManager.start).toHaveBeenCalledWith(
        started.id,
        expect.objectContaining({ instanceName: "was-running" }),
        { keepAlive: false },
      );
    });
  });

  describe("unmatched /api/instances paths", () => {
    it("returns 404 for an unsupported method/path combination", async () => {
      const record = await createInstance(ctx.baseUrl);
      const response = await fetch(`${ctx.baseUrl}/api/instances/${record.id}/restart`, { method: "POST" });
      expect(response.status).toBe(404);
    });
  });
});
