import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayApiError, HttpClient } from "./http-client.js";

describe("HttpClient Retry-After (review 2026-09, M-10)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function serve(status: number, headers: Record<string, string>): Promise<HttpClient> {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ error: "nope" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "gw_x" });
  }

  it("carries a 429's Retry-After seconds as milliseconds on the error", async () => {
    const client = await serve(429, { "retry-after": "3" });
    const error = await client.request("/api/gateway/readings", { method: "POST", body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayApiError);
    expect((error as GatewayApiError).status).toBe(429);
    expect((error as GatewayApiError).retryAfterMs).toBe(3000);
  });

  it("leaves retryAfterMs undefined without the header or with an HTTP-date form", async () => {
    const withoutHeader = await serve(503, {});
    const first = (await withoutHeader.request("/x").catch((e: unknown) => e)) as GatewayApiError;
    expect(first.retryAfterMs).toBeUndefined();

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    const withDate = await serve(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
    const second = (await withDate.request("/x").catch((e: unknown) => e)) as GatewayApiError;
    expect(second.retryAfterMs).toBeUndefined();
  });
});
