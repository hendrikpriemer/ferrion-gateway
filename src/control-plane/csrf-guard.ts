/**
 * Rejects cross-site state-changing requests to the control plane.
 *
 * Background. The control plane is unauthenticated by design and binds to
 * loopback (README "Security model") - the trust boundary is "same machine,
 * like editing a local config file". A local pentest (2026-09-12) showed
 * that boundary has a hole a config file does not: a web page the user
 * visits, while the gateway runs on their machine, can POST to the
 * state-changing routes. `readJsonBody` parses regardless of `Content-Type`,
 * so a `text/plain` form/fetch - a "simple request" that needs no CORS
 * preflight - reaches them. Confirmed: `POST /api/instances` with a foreign
 * Origin created an instance.
 *
 * This does not add authentication. It restores the boundary the model
 * already assumes, by telling apart the two sources the model conflates:
 *
 * - The gateway's own UI and command-line tools (curl, scripts) - allowed.
 * - Another website's script running in the same browser - rejected.
 *
 * Browsers make that distinction available and unforgeable through Fetch
 * Metadata: every request carries `Sec-Fetch-Site`, and page scripts cannot
 * set it. A same-origin write from the real UI reads `same-origin`; a CSRF
 * write from elsewhere reads `cross-site` (or `same-site`). A non-browser
 * client sends no such header at all, which is exactly the "local tool"
 * case the trust model means to keep working - so an absent header is
 * allowed, and `Origin` is checked as a fallback for the rare browser that
 * omits Fetch Metadata.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Headers = {
  "sec-fetch-site"?: string | string[];
  origin?: string | string[];
  host?: string | string[];
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when this request must be refused as a cross-site write. Reads only
 * headers and the method, so it is unit-testable without a socket.
 */
export function isCrossSiteWrite(method: string | undefined, headers: Headers): boolean {
  // Reads never change state; the CSRF concern does not apply, and blocking
  // them would break ordinary same-machine use.
  if (SAFE_METHODS.has((method ?? "GET").toUpperCase())) {
    return false;
  }

  const secFetchSite = first(headers["sec-fetch-site"]);
  if (secFetchSite !== undefined) {
    // Present on every request from a current browser and not settable by
    // page scripts. Only a same-origin write is the real UI; `same-site`,
    // `cross-site` and `none` are not, and `none` cannot be a legitimate
    // write from this UI anyway (it means a top-level user navigation).
    return secFetchSite !== "same-origin";
  }

  // No Fetch Metadata: either a non-browser client (allowed - the "local
  // tool" case) or an old browser. If such a browser sent an `Origin` that
  // does not match this host, it is cross-origin and refused; otherwise the
  // request is treated as a local tool and allowed.
  const origin = first(headers["origin"]);
  if (origin !== undefined && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      // An unparseable Origin is not something a legitimate tool sends.
      return true;
    }
    const host = first(headers["host"]);
    return originHost !== host;
  }

  return false;
}
