import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "./gateway-api.js";
import type { HttpClient } from "./http-client.js";

function fakeHttpClient(request: (path: string, init?: unknown) => Promise<unknown>): HttpClient {
  return { request } as unknown as HttpClient;
}

describe("GatewayApi", () => {
  it("fetchCommands unwraps the {commands} envelope", async () => {
    const request = vi.fn().mockResolvedValue({ commands: [{ id: "c1", type: "TEST_CONNECTION", payload: {} }] });
    const api = new GatewayApi(fakeHttpClient(request));

    const commands = await api.fetchCommands();

    expect(commands).toEqual([{ id: "c1", type: "TEST_CONNECTION", payload: {} }]);
    expect(request).toHaveBeenCalledWith("/api/gateway/commands?capabilities=TEST_CONNECTION%2CBROWSE_DATA_POINTS%2CDISCOVER_DEVICES");
  });

  it("tells ferrion its version and the command types it can run with every poll (R07)", async () => {
    const request = vi.fn().mockResolvedValue({ commands: [] });
    const api = new GatewayApi(fakeHttpClient(request), { version: "0.1.54" });

    await api.fetchCommands();

    const [path] = request.mock.calls[0] as [string];
    const query = new URL(path, "http://ferrion.test").searchParams;
    expect(query.get("version")).toBe("0.1.54");
    expect(query.get("capabilities")?.split(",")).toEqual(["TEST_CONNECTION", "BROWSE_DATA_POINTS", "DISCOVER_DEVICES"]);
    expect(query.has("discoveryLimit")).toBe(false);
  });

  it("tells ferrion its discovery limit when one is set (R07)", async () => {
    const request = vi.fn().mockResolvedValue({ commands: [] });
    const api = new GatewayApi(fakeHttpClient(request), { discoveryLimit: ["10.20.30.0/24", "10.0.4.7/32"] });

    await api.fetchCommands();

    const [path] = request.mock.calls[0] as [string];
    expect(new URL(path, "http://ferrion.test").searchParams.get("discoveryLimit")).toBe("10.20.30.0/24,10.0.4.7/32");
  });

  it("leaves an empty discovery limit out", async () => {
    const request = vi.fn().mockResolvedValue({ commands: [] });
    await new GatewayApi(fakeHttpClient(request), { discoveryLimit: [] }).fetchCommands();

    const [path] = request.mock.calls[0] as [string];
    expect(new URL(path, "http://ferrion.test").searchParams.has("discoveryLimit")).toBe(false);
  });

  it("fetchDataSources unwraps the {dataSources} envelope", async () => {
    const request = vi.fn().mockResolvedValue({ dataSources: [] });
    const api = new GatewayApi(fakeHttpClient(request));

    await api.fetchDataSources();

    expect(request).toHaveBeenCalledWith("/api/gateway/data-sources");
  });

  it("pushReadings sends a batch and returns the accepted count", async () => {
    const request = vi.fn().mockResolvedValue({ accepted: 2 });
    const api = new GatewayApi(fakeHttpClient(request));
    const readings = [
      { dataSourceId: "d1", timestamp: "2026-08-14T12:00:00.000Z", value: 1.5 },
      { dataSourceId: "d2", timestamp: "2026-08-14T12:00:00.000Z", value: 2.5 },
    ];

    const accepted = await api.pushReadings(readings);

    expect(accepted).toBe(2);
    expect(request).toHaveBeenCalledWith("/api/gateway/readings", { method: "POST", body: { readings } });
  });

  it("pushReadings skips the request entirely for an empty batch", async () => {
    const request = vi.fn();
    const api = new GatewayApi(fakeHttpClient(request));

    const accepted = await api.pushReadings([]);

    expect(accepted).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("postCommandResult succeeds on the first try without sleeping", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new GatewayApi(fakeHttpClient(request), { sleep });

    await api.postCommandResult("cmd1", { status: "COMPLETED", result: { value: 1 } });

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("postCommandResult retries with backoff and succeeds once the request stops failing", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new GatewayApi(fakeHttpClient(request), { resultRetryAttempts: 3, resultRetryBaseDelayMs: 10, sleep });

    await api.postCommandResult("cmd1", { status: "FAILED", result: { error: "timeout" } });

    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("postCommandResult gives up and throws after exhausting all attempts", async () => {
    const failure = new Error("still down");
    const request = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const api = new GatewayApi(fakeHttpClient(request), { resultRetryAttempts: 3, resultRetryBaseDelayMs: 5, sleep });

    await expect(api.postCommandResult("cmd1", { status: "FAILED" })).rejects.toThrow("still down");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
