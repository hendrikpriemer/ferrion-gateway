import { Agent, fetch as undiciFetch } from "undici";

export class GatewayApiError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  // From a 429's Retry-After header (seconds form only), so the reading
  // loop can pace its retry the way ferrion asked instead of guessing.
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, cause?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = "GatewayApiError";
    this.status = status;
    this.cause = cause;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

// A platform connection that accepts the TCP/TLS handshake but then stalls
// mid-request would otherwise block whichever fixed-interval loop tick made
// the call for however long undici's own defaults allow (multiple minutes) -
// schedulePush()/scheduleDiscovery() in reading-loop.ts and command-loop.ts's
// tick() only schedule their next run in a finally() after the current one
// settles, so a single hang stalls that entire loop's cadence, not just one
// request.
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  // false for ferrion's local self-signed dev cert - per-instance, not the
  // process-wide NODE_TLS_REJECT_UNAUTHORIZED=0 sledgehammer ferrion itself
  // uses in dev.
  rejectUnauthorized?: boolean;
  requestTimeoutMs?: number;
  fetchImpl?: typeof undiciFetch;
}

interface RequestInit {
  method?: string;
  body?: unknown;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly dispatcher: Agent | undefined;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof undiciFetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
    this.dispatcher =
      options.rejectUnauthorized === false ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const hasBody = init.body !== undefined;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body: hasBody ? JSON.stringify(init.body) : undefined,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      const message = timedOut
        ? `Request to ${url} timed out after ${this.requestTimeoutMs}ms`
        : `Request to ${url} failed: ${(cause as Error).message}`;
      throw new GatewayApiError(message, undefined, cause);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GatewayApiError(
        `Request to ${url} returned ${response.status}: ${text}`,
        response.status,
        undefined,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }

    return (await response.json()) as T;
  }
}
