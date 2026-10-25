import { describe, expect, it } from "vitest";
import {
  cidrContainsAddress,
  cidrContainsCidr,
  cidrHostCount,
  cidrHosts,
  formatCidr,
  formatIpv4,
  parseCidr,
  parseIpv4,
} from "./ipv4.js";

const cidr = (text: string) => {
  const parsed = parseCidr(text);
  if (!parsed) throw new Error(`not a CIDR: ${text}`);
  return parsed;
};

describe("parseIpv4 / formatIpv4", () => {
  it("round-trips an address", () => {
    expect(formatIpv4(parseIpv4("10.20.30.23") as number)).toBe("10.20.30.23");
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIpv4("0.0.0.0")).toBe(0);
  });

  it.each(["10.0.0", "10.0.0.256", "10.0.0.01", "10.0.0.-1", "host.local", "10.0.0.1 ", "", "1.2.3.4.5"])(
    "refuses %j",
    (text) => {
      expect(parseIpv4(text)).toBeNull();
    },
  );
});

describe("parseCidr", () => {
  it("reads a block and a bare address as a /32", () => {
    expect(formatCidr(cidr("10.0.4.0/24"))).toBe("10.0.4.0/24");
    expect(formatCidr(cidr("10.0.4.7"))).toBe("10.0.4.7/32");
    expect(formatCidr(cidr("0.0.0.0/0"))).toBe("0.0.0.0/0");
  });

  it("refuses host bits, which may have meant the single host", () => {
    expect(parseCidr("10.0.4.7/24")).toBeNull();
  });

  it.each(["10.0.4.0/33", "10.0.4.0/", "10.0.4.0/24/1", "10.0.4.0/-1", "10.0.4.0/08", "fe80::/64", "x/24"])(
    "refuses %j",
    (text) => {
      expect(parseCidr(text)).toBeNull();
    },
  );
});

describe("containment", () => {
  it("knows an address inside and outside a block", () => {
    expect(cidrContainsAddress(cidr("10.0.4.0/24"), parseIpv4("10.0.4.255") as number)).toBe(true);
    expect(cidrContainsAddress(cidr("10.0.4.0/24"), parseIpv4("10.0.5.0") as number)).toBe(false);
    expect(cidrContainsAddress(cidr("0.0.0.0/0"), parseIpv4("8.8.8.8") as number)).toBe(true);
  });

  it("knows a block inside, overlapping and beside another", () => {
    expect(cidrContainsCidr(cidr("10.0.0.0/16"), cidr("10.0.4.0/24"))).toBe(true);
    expect(cidrContainsCidr(cidr("10.0.4.0/24"), cidr("10.0.4.0/24"))).toBe(true);
    // Wider than the outer block, even though it starts inside it.
    expect(cidrContainsCidr(cidr("10.0.4.0/24"), cidr("10.0.4.0/23"))).toBe(false);
    expect(cidrContainsCidr(cidr("10.0.4.0/24"), cidr("10.0.5.0/24"))).toBe(false);
  });
});

describe("cidrHosts", () => {
  it("leaves out network and broadcast address of a /24", () => {
    const hosts = cidrHosts(cidr("10.0.4.0/24"));
    expect(hosts).toHaveLength(254);
    expect(formatIpv4(hosts[0] as number)).toBe("10.0.4.1");
    expect(formatIpv4(hosts.at(-1) as number)).toBe("10.0.4.254");
    expect(cidrHostCount(cidr("10.0.4.0/24"))).toBe(254);
  });

  it("keeps both addresses of a /31 and the one of a /32", () => {
    expect(cidrHosts(cidr("10.0.4.0/31")).map(formatIpv4)).toEqual(["10.0.4.0", "10.0.4.1"]);
    expect(cidrHosts(cidr("10.0.4.9/32")).map(formatIpv4)).toEqual(["10.0.4.9"]);
    expect(cidrHostCount(cidr("10.0.4.0/31"))).toBe(2);
    expect(cidrHostCount(cidr("10.0.4.9/32"))).toBe(1);
  });

  it("counts a /22 without building it", () => {
    expect(cidrHostCount(cidr("10.0.4.0/22"))).toBe(1022);
    expect(cidrHosts(cidr("10.0.4.0/22"))).toHaveLength(1022);
  });
});
