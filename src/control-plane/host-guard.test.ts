import { describe, expect, it } from "vitest";
import { allowedHostnames, hostnameOf, isForeignHost } from "./host-guard.js";

describe("hostnameOf", () => {
  it("strips the port, unwraps IPv6 brackets and lower-cases", () => {
    expect(hostnameOf("127.0.0.1:4000")).toBe("127.0.0.1");
    expect(hostnameOf("LocalHost")).toBe("localhost");
    expect(hostnameOf("[::1]:4000")).toBe("::1");
    expect(hostnameOf("[::1]")).toBe("::1");
  });

  it("refuses what is not a Host header value", () => {
    expect(hostnameOf("")).toBeUndefined();
    expect(hostnameOf("::1:4000")).toBeUndefined();
    expect(hostnameOf("[::1")).toBeUndefined();
  });
});

describe("allowedHostnames", () => {
  it("is loopback only by default, plus whatever FG_ALLOWED_HOSTS lists", () => {
    expect([...allowedHostnames(undefined)]).toEqual(["localhost", "127.0.0.1", "::1"]);
    expect(allowedHostnames(" gateway.plant.local, 10.0.0.5 ").has("gateway.plant.local")).toBe(true);
    expect(allowedHostnames("gateway.plant.local,10.0.0.5").has("10.0.0.5")).toBe(true);
    expect(allowedHostnames(",,").size).toBe(3);
  });
});

describe("isForeignHost", () => {
  const allowed = allowedHostnames(undefined);

  it("lets this machine's own names through, with or without port", () => {
    expect(isForeignHost("127.0.0.1:4000", allowed)).toBe(false);
    expect(isForeignHost("localhost:4000", allowed)).toBe(false);
    expect(isForeignHost("[::1]:4000", allowed)).toBe(false);
    expect(isForeignHost(["127.0.0.1:4000"], allowed)).toBe(false);
  });

  it("refuses the DNS-rebinding case - a foreign name resolving to this machine", () => {
    // The finding: the page was loaded from evil.example:4000, whose record
    // then pointed at 127.0.0.1. The browser sends that name as Host.
    expect(isForeignHost("evil.example:4000", allowed)).toBe(true);
    expect(isForeignHost("127.0.0.1.evil.example:4000", allowed)).toBe(true);
  });

  it("refuses a missing or malformed Host header", () => {
    expect(isForeignHost(undefined, allowed)).toBe(true);
    expect(isForeignHost("", allowed)).toBe(true);
    expect(isForeignHost("::1:4000", allowed)).toBe(true);
  });

  it("honours an operator's extra names for network_mode: host deployments", () => {
    const withLan = allowedHostnames("gateway.plant.local");
    expect(isForeignHost("gateway.plant.local:4000", withLan)).toBe(false);
    expect(isForeignHost("GATEWAY.PLANT.LOCAL", withLan)).toBe(false);
  });
});
