import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "../../test/fixtures/test-tls-cert.js";
import { GatewayApiError, HttpClient } from "./http-client.js";

function listen(server: HttpServer | HttpsServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("HttpClient", () => {
  let server: HttpServer | HttpsServer | undefined;

  afterEach(async () => {
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it("sends the Bearer header and returns the parsed JSON body on success", async () => {
    let seenAuthHeader: string | undefined;
    server = createHttpServer((req, res) => {
      seenAuthHeader = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commands: [] }));
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_test123" });
    const result = await client.request<{ commands: unknown[] }>("/api/gateway/commands");

    expect(result).toEqual({ commands: [] });
    expect(seenAuthHeader).toBe("Bearer gw_test123");
  });

  it("joins the base URL and path regardless of a trailing/leading slash", async () => {
    let seenPath: string | undefined;
    server = createHttpServer((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}/`, apiKey: "gw_test123" });
    await client.request("api/gateway/readings");

    expect(seenPath).toBe("/api/gateway/readings");
  });

  it("sends a JSON body with Content-Type for POST requests", async () => {
    let seenBody: unknown;
    let seenContentType: string | undefined;
    server = createHttpServer((req, res) => {
      seenContentType = req.headers["content-type"];
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seenBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_test123" });
    await client.request("/api/gateway/commands/abc/result", {
      method: "POST",
      body: { status: "COMPLETED", result: { ok: true } },
    });

    expect(seenContentType).toBe("application/json");
    expect(seenBody).toEqual({ status: "COMPLETED", result: { ok: true } });
  });

  it("throws a GatewayApiError with the response status on a non-2xx response", async () => {
    server = createHttpServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "wrong-key" });

    await expect(client.request("/api/gateway/commands")).rejects.toMatchObject({
      name: "GatewayApiError",
      status: 401,
    });
  });

  it("throws a GatewayApiError when the server is unreachable", async () => {
    // Nothing is listening on this port - bind-then-close to get a free one.
    const probe = createHttpServer();
    const port = await listen(probe);
    await close(probe);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_test123" });

    await expect(client.request("/api/gateway/commands")).rejects.toBeInstanceOf(GatewayApiError);
  });

  it("rejects a self-signed cert by default (rejectUnauthorized defaults to true)", async () => {
    server = createHttpsServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `https://127.0.0.1:${port}`, apiKey: "gw_test123" });

    await expect(client.request("/api/gateway/commands")).rejects.toBeInstanceOf(GatewayApiError);
  });

  it("accepts a self-signed cert when rejectUnauthorized is explicitly false", async () => {
    server = createHttpsServer({ cert: TEST_TLS_CERT, key: TEST_TLS_KEY }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);

    const client = new HttpClient({
      baseUrl: `https://127.0.0.1:${port}`,
      apiKey: "gw_test123",
      rejectUnauthorized: false,
    });

    await expect(client.request("/api/gateway/commands")).resolves.toEqual({ ok: true });
  });

  it("aborts and throws a GatewayApiError when the server accepts the connection but never responds", async () => {
    server = createHttpServer(() => {
      // Deliberately never calls res.end() - simulates a stalled platform
      // connection (TCP/TLS fine, response never arrives).
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_test123", requestTimeoutMs: 50 });

    await expect(client.request("/api/gateway/commands")).rejects.toMatchObject({
      name: "GatewayApiError",
      message: expect.stringContaining("timed out after 50ms"),
    });
  });

  it("still succeeds well within a generous timeout (regression guard for the added signal option)", async () => {
    server = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);

    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_test123", requestTimeoutMs: 5000 });

    await expect(client.request("/api/gateway/commands")).resolves.toEqual({ ok: true });
  });
});
