import { describe, expect, it, vi } from "vitest";
import { checkFerrionConnectivity } from "./ferrion-connectivity.js";

const settings = { baseUrl: "https://localhost:3000", apiKey: "gw_abc", rejectUnauthorized: false };

describe("checkFerrionConnectivity", () => {
  it("reports connected for a successful response, including the gateway's own name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ gatewayName: "Site A Gateway", commands: [] }),
    });

    const result = await checkFerrionConnectivity(settings, fetchImpl);

    expect(result.status).toBe("connected");
    expect(result.error).toBeUndefined();
    expect(result.gatewayName).toBe("Site A Gateway");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://localhost:3000/api/gateway/commands",
      expect.objectContaining({ headers: { Authorization: "Bearer gw_abc" } }),
    );
  });

  it("leaves gatewayName undefined (without failing the check) if the response body isn't the expected shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    });

    const result = await checkFerrionConnectivity(settings, fetchImpl);

    expect(result.status).toBe("connected");
    expect(result.gatewayName).toBeUndefined();
  });

  it("reports unauthorized for a 401 response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers(), text: vi.fn().mockResolvedValue("") });

    const result = await checkFerrionConnectivity(settings, fetchImpl);

    expect(result.status).toBe("unauthorized");
  });

  it("reports unreachable for any other non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers(), text: vi.fn().mockResolvedValue("") });

    const result = await checkFerrionConnectivity(settings, fetchImpl);

    expect(result.status).toBe("unreachable");
    expect(result.error).toMatch(/500/);
  });

  it("reports unreachable when the request itself throws (connection refused, timeout, ...)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await checkFerrionConnectivity(settings, fetchImpl);

    expect(result.status).toBe("unreachable");
    // HttpClient's wording, which names the URL as well - more useful in the
    // UI than the bare cause.
    expect(result.error).toMatch(/fetch failed/);
  });

  it("strips a trailing slash from baseUrl before building the check URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });

    await checkFerrionConnectivity({ ...settings, baseUrl: "https://localhost:3000/" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://localhost:3000/api/gateway/commands", expect.anything());
  });
});
