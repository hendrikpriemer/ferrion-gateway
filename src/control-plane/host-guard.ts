/**
 * Refuses requests whose `Host` header names anything but this machine.
 *
 * The control plane is unauthenticated and bound to loopback (README
 * "Security model"); csrf-guard.ts keeps other websites from *writing* to
 * it. Both rest on the browser knowing the request is cross-site - and DNS
 * rebinding takes that knowledge away: a page served from
 * `http://evil.example:4000` whose DNS record then flips to 127.0.0.1 is,
 * to the browser, same-origin with this API. `Sec-Fetch-Site: same-origin`
 * passes the CSRF guard, responses are readable, and `PUT /api/settings`
 * without an apiKey reuses the stored key (review 2026-09, H-1).
 *
 * What the browser cannot forge is the `Host` header: it carries the name
 * the page was loaded from. This machine is only ever addressed as
 * localhost / 127.0.0.1 / [::1] (or, with `network_mode: host`, whatever
 * the operator lists in FG_ALLOWED_HOSTS) - anything else is a request that
 * never meant to reach a gateway and gets 421 Misdirected Request.
 */

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];

export function allowedHostnames(extra: string | undefined = process.env.FG_ALLOWED_HOSTS): Set<string> {
  const names = new Set(LOOPBACK_HOSTNAMES);
  for (const entry of (extra ?? "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** The hostname part of a Host header value: port stripped, IPv6 brackets removed, lower-cased. */
export function hostnameOf(hostHeader: string): string | undefined {
  const value = hostHeader.trim();
  if (!value) return undefined;
  // `[::1]:4000`, `[::1]`
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end).toLowerCase() : undefined;
  }
  // `host:port` - a bare IPv6 without brackets is not a valid Host header
  // and has more than one colon; refuse it rather than guess.
  const parts = value.split(":");
  if (parts.length > 2) return undefined;
  return parts[0]!.toLowerCase() || undefined;
}

export function isForeignHost(hostHeader: string | string[] | undefined, allowed: Set<string>): boolean {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (raw === undefined) {
    // HTTP/1.1 requires Host; a request without one is not from a browser
    // that loaded our page, nor from any tool worth accommodating.
    return true;
  }
  const hostname = hostnameOf(raw);
  return hostname === undefined || !allowed.has(hostname);
}
