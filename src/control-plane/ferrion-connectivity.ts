import type { fetch as undiciFetch } from "undici";
import { GatewayApiError, HttpClient } from "../ferrion-client/http-client.js";
import { errorMessage } from "../util/error-message.js";
import type { FerrionSettings } from "./settings-store.js";

export type ConnectivityStatus = "unconfigured" | "connected" | "unauthorized" | "unreachable";

export interface ConnectivityCheckResult {
  status: ConnectivityStatus;
  checkedAt: string;
  error?: string;
  // The gateway's own name as assigned in ferrion (Settings → Gateways) -
  // only ever set alongside status:"connected", since it comes from the
  // same successful response that confirms the API key is valid.
  gatewayName?: string;
}

const CHECK_TIMEOUT_MS = 5000;

function extractGatewayName(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "gatewayName" in body) {
    const value: unknown = body.gatewayName;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

// One HttpClient per settings snapshot, not one per check: the client owns
// the undici Agent that skips certificate validation when the operator
// asked for that, and a new Agent every 15 s (the UI's poll) was never
// closed (review 2026-09, N-2).
let cached: { key: string; client: HttpClient } | undefined;

function clientFor(settings: FerrionSettings, fetchImpl: typeof undiciFetch | undefined): HttpClient {
  const key = `${settings.baseUrl}|${settings.apiKey}|${String(settings.rejectUnauthorized)}|${fetchImpl ? "custom" : "default"}`;
  if (cached?.key === key && fetchImpl === undefined) return cached.client;
  const client = new HttpClient({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    rejectUnauthorized: settings.rejectUnauthorized,
    requestTimeoutMs: CHECK_TIMEOUT_MS,
    fetchImpl,
  });
  if (fetchImpl === undefined) cached = { key, client };
  return client;
}

// A bounded-latency reachability check for the control-plane's own
// "connected" indicator, through the same HttpClient the real loops use
// (it used to rebuild that client's Bearer/Agent/timeout handling inline).
// Hits the same GET /api/gateway/commands endpoint a running instance
// polls, so "connected" here means exactly what it would for an actual
// instance: valid API key, reachable server - not just "the URL responds
// to anything".
export async function checkFerrionConnectivity(
  settings: FerrionSettings,
  fetchImpl?: typeof undiciFetch,
): Promise<ConnectivityCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    const body = await clientFor(settings, fetchImpl).request<unknown>("/api/gateway/commands");
    return { status: "connected", checkedAt, gatewayName: extractGatewayName(body) };
  } catch (error) {
    if (error instanceof GatewayApiError) {
      if (error.status === 401) {
        return { status: "unauthorized", checkedAt, error: "Invalid API key" };
      }
      if (error.status !== undefined) {
        return { status: "unreachable", checkedAt, error: `Server responded with ${error.status}` };
      }
      return { status: "unreachable", checkedAt, error: errorMessage(error) };
    }
    // Anything else is HttpClient failing to parse a 2xx body: the server
    // answered and accepted the key, only the name is missing - a
    // malformed body must not turn a genuinely successful check into a
    // failure. The name is a nice-to-have on top of "connected".
    return { status: "connected", checkedAt };
  }
}
