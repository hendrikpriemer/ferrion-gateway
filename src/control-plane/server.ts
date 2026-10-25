import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InstanceStore } from "./instance-store.js";
import { ProcessManager } from "./process-manager.js";
import { allowedHostnames, isForeignHost } from "./host-guard.js";
import { ensureBridgeInstance, handleApiRequest, resumeAutoStartInstances } from "./routes.js";
import { resolveRootTextFile } from "./root-text-files.js";
import { SettingsStore } from "./settings-store.js";
import { resolveFontFile } from "./font-files.js";
import { SECURITY_HEADERS } from "./security-headers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "..", "public");
const rootDir = path.join(__dirname, "..", "..");

const dataDir = path.join(__dirname, "..", "..", "data");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const store = new InstanceStore(path.join(dataDir, "instances.json"));
const settingsStore = new SettingsStore(path.join(dataDir, "settings.json"));
const processManager = new ProcessManager();

// Order matters: the bridge record must exist before resume iterates the
// store, so a freshly-created one starts in this same boot cycle instead
// of waiting for the next restart - see routes.ts's own doc comments.
ensureBridgeInstance(store);

// Resumes whatever instances were intentionally running before this
// process started (a previous run's own graceful shutdown() below stops
// everything cleanly, but a crash or `docker compose up` redeploy skips
// that) - see routes.ts's resumeAutoStartInstances() doc comment.
resumeAutoStartInstances(store, processManager, settingsStore);

// Node's built-in http module only, no Express/Fastify/Next.js - a
// handful of JSON routes plus one static page don't need a framework (see
// the plan). 127.0.0.1-only, no auth: the same trust boundary as the
// config files this replaces, not a multi-user system.
// Loopback names plus FG_ALLOWED_HOSTS - see host-guard.ts for the
// DNS-rebinding case this closes. Read once at start, like the port.
const allowedHosts = allowedHostnames();

const server = createServer((req, res) => {
  void (async () => {
    try {
      // Set before any handler writes: writeHead() merges these with
      // whatever a handler adds (see security-headers.ts). no-store on the
      // API keeps a browser from ever serving the redacted-but-still-
      // sensitive settings from cache.
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(name, value);
      }
      if ((req.url ?? "/").startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
      }

      if (isForeignHost(req.headers.host, allowedHosts)) {
        res.writeHead(421, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Misdirected request: this gateway only answers to its own host names" }));
        return;
      }

      const handled = await handleApiRequest(req, res, store, processManager, settingsStore);
      if (handled) return;

      const url = new URL(req.url ?? "/", "http://localhost");

      const rootFile = resolveRootTextFile(url.pathname);
      if (rootFile) {
        const content = await readFile(path.join(rootDir, rootFile));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(content);
        return;
      }

      const fontFile = resolveFontFile(url.pathname);
      if (fontFile) {
        const content = await readFile(fontFile);
        // A day, not "immutable": the URL carries no version, and a package
        // update should reach a browser without a hard reload.
        res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=86400" });
        res.end(content);
        return;
      }

      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.join(publicDir, requestedPath);
      // Separator-guarded: a bare startsWith(publicDir) also passes a sibling
      // like `/app/public-x`, since that string starts with `/app/public`.
      // Requiring the path separator (or an exact match) confines it to the
      // directory itself. No such sibling exists today - this keeps it that
      // way if one is ever added.
      if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const content = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })();
});

const port = Number(process.env.FG_CONTROL_PLANE_PORT ?? 4000);
// 127.0.0.1 by default (this same machine only, matching the "no auth"
// trust boundary below) - overridden to 0.0.0.0 in docker-compose.yml,
// since a container's own 127.0.0.1 is unreachable from outside it no
// matter how Docker publishes the port. When overridden, the trust
// boundary shifts to Docker's own port publishing (see the compose file's
// comments) instead of this bind address.
const host = process.env.FG_BIND_HOST ?? "127.0.0.1";
// Can't reliably infer from in here whether a non-loopback bind is
// actually safe (docker-compose.yml's default 0.0.0.0 is fine precisely
// because the host-side port publish itself is 127.0.0.1-only - this
// process has no visibility into that), so this can't refuse to start
// the way a real auth check could. What it CAN do is make the one
// realistic way this goes wrong impossible to miss: switching to
// `network_mode: host` (the compose file's own recommended production
// deployment shape) without also reverting FG_BIND_HOST puts this
// completely unauthenticated API - including the plaintext ferrion API
// key - on the open network, silently, unless someone happens to notice.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(host)) {
  console.warn(
    "\n" +
      "*".repeat(70) +
      "\n! WARNING: ferrion-gateway control-plane is binding to a non-loopback\n" +
      `! address (${host}), not just this machine.\n` +
      "! This API has NO AUTHENTICATION - anyone who can reach it can point\n" +
      "! the gateway at any ferrion URL (PUT /api/settings), which captures\n" +
      "! the API key on the next push, and can create/start/stop/delete\n" +
      "! instances. (GET /api/settings itself redacts the key.) Only\n" +
      "! intentional with network_mode: host on a trusted,\n" +
      "! isolated site network - if this wasn't deliberate, set FG_BIND_HOST\n" +
      "! back to 127.0.0.1.\n" +
      "*".repeat(70) +
      "\n",
  );
}
server.listen(port, host, () => {
  console.log(`ferrion-gateway control-plane listening on http://${host}:${port}`);
});

// Waits for every child to exit (process-manager.ts stops with escalation,
// so this is bounded) before ending PID 1 - otherwise the container
// runtime SIGKILLs the children mid-save. The cap here is the last line:
// docker-compose.yml's stop_grace_period is set above it.
const SHUTDOWN_HARD_CAP_MS = 15_000;

async function shutdown(): Promise<void> {
  const cap = setTimeout(() => {
    console.error("[control-plane] shutdown timed out waiting for instances - exiting anyway");
    process.exit(0);
  }, SHUTDOWN_HARD_CAP_MS);
  cap.unref();
  await processManager.stopAll();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
