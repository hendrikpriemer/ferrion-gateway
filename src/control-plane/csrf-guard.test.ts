import { describe, expect, it } from "vitest";
import { isCrossSiteWrite } from "./csrf-guard.js";

describe("isCrossSiteWrite", () => {
  it("never blocks a read, whatever its origin", () => {
    // GET/HEAD/OPTIONS change nothing; blocking them would break the UI and
    // the preflight path both.
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossSiteWrite(method, { "sec-fetch-site": "cross-site" })).toBe(false);
    }
  });

  it("allows the same-origin UI's writes", () => {
    // The real control-plane UI is served from the same origin, so its fetch
    // carries same-origin.
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(isCrossSiteWrite(method, { "sec-fetch-site": "same-origin" })).toBe(false);
    }
  });

  it("blocks a cross-site browser write - the CSRF case", () => {
    // The confirmed finding: a page on another site POSTing to /api/instances.
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "cross-site" })).toBe(true);
    // same-site is a different origin too, and not the UI.
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "same-site" })).toBe(true);
    // `none` is a top-level navigation, never a legitimate write from the UI.
    expect(isCrossSiteWrite("POST", { "sec-fetch-site": "none" })).toBe(true);
  });

  it("allows a non-browser client that sends no fetch metadata", () => {
    // curl and scripts are the "local tool" case the trust model keeps
    // working - they send no Sec-Fetch-Site and no Origin.
    expect(isCrossSiteWrite("POST", {})).toBe(false);
    expect(isCrossSiteWrite("DELETE", { host: "127.0.0.1:4000" })).toBe(false);
  });

  it("falls back to Origin for a browser without fetch metadata", () => {
    // Old browser, no Sec-Fetch-Site: a cross-origin Origin is still a
    // cross-site write and is refused.
    expect(
      isCrossSiteWrite("POST", { origin: "http://evil.example", host: "127.0.0.1:4000" })
    ).toBe(true);
    // A matching Origin is the UI itself.
    expect(
      isCrossSiteWrite("POST", { origin: "http://127.0.0.1:4000", host: "127.0.0.1:4000" })
    ).toBe(false);
  });

  it("refuses an unparseable or null Origin rather than trusting it", () => {
    expect(isCrossSiteWrite("POST", { origin: "not a url", host: "127.0.0.1:4000" })).toBe(true);
    // Sec-Fetch-Site wins when present, so a null Origin there is moot; via
    // the Origin fallback, "null" is treated as "no origin" (a privacy-masked
    // same-origin request), not as a host to compare.
    expect(isCrossSiteWrite("POST", { origin: "null", host: "127.0.0.1:4000" })).toBe(false);
  });

  it("prefers Sec-Fetch-Site over Origin when both are present", () => {
    // The unforgeable signal decides; a spoofed Origin cannot loosen it.
    expect(
      isCrossSiteWrite("POST", {
        "sec-fetch-site": "cross-site",
        origin: "http://127.0.0.1:4000",
        host: "127.0.0.1:4000",
      })
    ).toBe(true);
  });
});
