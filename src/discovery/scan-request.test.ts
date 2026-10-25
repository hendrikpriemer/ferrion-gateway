import { describe, expect, it } from "vitest";
import { formatIpv4 } from "./ipv4.js";
import { DISCOVERY_LIMIT_ENV, MAX_SCAN_ADDRESSES, planScan, readDiscoveryLimit, type ScanPlan } from "./scan-request.js";

const limit = (value: string) => readDiscoveryLimit({ [DISCOVERY_LIMIT_ENV]: value });
const PLANT = limit("10.20.30.0/24, 10.20.40.0/22");

function plan(payload: unknown, discoveryLimit = PLANT): ScanPlan {
  const result = planScan(payload, discoveryLimit);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}
function refusal(payload: unknown, discoveryLimit = PLANT): string {
  const result = planScan(payload, discoveryLimit);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("readDiscoveryLimit", () => {
  it("reads comma- and space-separated blocks", () => {
    expect(limit("10.0.0.0/24,10.0.1.0/24  10.0.2.7").cidrs).toHaveLength(3);
  });

  it("drops what does not parse instead of widening it", () => {
    const read = limit("10.0.0.0/24, 10.0.1.7/24, plant.local");
    expect(read.cidrs).toHaveLength(1);
    expect(read.invalid).toEqual(["10.0.1.7/24", "plant.local"]);
  });

  it("is empty when the variable is not set", () => {
    expect(readDiscoveryLimit({}).cidrs).toEqual([]);
  });
});

describe("planScan", () => {
  it("refuses everything while the gateway has no discovery limit", () => {
    expect(refusal({ protocols: ["OPC_UA"], opcua: { hosts: ["10.20.30.23"] } }, readDiscoveryLimit({}))).toBe(
      "discovery not enabled on this gateway (FG_DISCOVERY_ALLOWED_CIDRS not set)",
    );
  });

  it("plans a sweep of a released /24 on the default port", () => {
    const planned = plan({ protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.30.0/24"] } } });

    expect(planned.addresses).toHaveLength(254);
    expect(planned.ports).toEqual([4840]);
    expect(planned.budgetMs).toBe(30_000);
    expect(planned.namedHosts.size).toBe(0);
  });

  it("probes named hosts on the requested ports and remembers them as named", () => {
    const planned = plan({
      protocols: ["OPC_UA"],
      opcua: { hosts: ["10.20.30.23", "10.20.30.23"], sweep: { cidrs: [], ports: [4840, 4843, 4843] } },
      budgetMs: 60_000,
      knownEndpoints: ["10.20.30.23:4840"],
    });

    expect(planned.addresses.map(formatIpv4)).toEqual(["10.20.30.23"]);
    expect(planned.ports).toEqual([4840, 4843]);
    expect([...planned.namedHosts].map(formatIpv4)).toEqual(["10.20.30.23"]);
    expect(planned.budgetMs).toBe(60_000);
    expect([...planned.knownEndpoints]).toEqual(["10.20.30.23:4840"]);
  });

  it("counts overlapping networks once", () => {
    const planned = plan({ protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.30.0/24", "10.20.30.0/25"] } } });
    expect(planned.addresses).toHaveLength(254);
  });

  it.each([
    ["a network outside the limit", { sweep: { cidrs: ["10.20.31.0/24"] } }, "outside gateway discovery limit: 10.20.31.0/24"],
    ["a network reaching past the limit", { sweep: { cidrs: ["10.20.30.0/23"] } }, "outside gateway discovery limit: 10.20.30.0/23"],
    ["a host outside the limit", { hosts: ["10.20.34.1"] }, "outside gateway discovery limit: 10.20.34.1"],
    ["a network wider than /22", { sweep: { cidrs: ["10.20.40.0/21"] } }, "network too large (at most /22): 10.20.40.0/21"],
    ["a DNS name as host", { hosts: ["umg801.plant.local"] }, "not an IPv4 address: umg801.plant.local"],
    ["a malformed network", { sweep: { cidrs: ["10.20.30.7/24"] } }, "not an IPv4 network: 10.20.30.7/24"],
    ["nothing to scan", { sweep: { cidrs: [] } }, "nothing to scan (no network, no host)"],
  ])("refuses %s before any probe", (_name, opcua, error) => {
    expect(refusal({ protocols: ["OPC_UA"], opcua })).toBe(error);
  });

  it("allows one /22 (1 022 addresses) but not more than 1 024 over all networks together", () => {
    expect(plan({ protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.40.0/22"] } } }).addresses).toHaveLength(1022);
    // Each network alone is allowed; together they are 1 276 addresses.
    expect(refusal({ protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.40.0/22", "10.20.30.0/24"] } } })).toBe(
      `too many addresses (at most ${MAX_SCAN_ADDRESSES} per scan, over all networks together)`,
    );
    // Two named hosts on top of the /22 still fit; three do not.
    const twoMore = { sweep: { cidrs: ["10.20.40.0/22"] }, hosts: ["10.20.30.1", "10.20.30.2"] };
    expect(plan({ protocols: ["OPC_UA"], opcua: twoMore }).addresses).toHaveLength(1024);
    expect(refusal({ protocols: ["OPC_UA"], opcua: { ...twoMore, hosts: [...twoMore.hosts, "10.20.30.3"] } })).toMatch(/^too many addresses/);
  });

  it("refuses a request without OPC UA", () => {
    expect(refusal({ protocols: ["MODBUS_TCP"], opcua: { hosts: ["10.20.30.23"] } })).toBe(
      "no supported protocol requested (supported: OPC_UA)",
    );
  });

  it.each([
    ["no protocols", { opcua: { hosts: ["10.20.30.23"] } }],
    ["a budget above two minutes", { protocols: ["OPC_UA"], opcua: { hosts: ["10.20.30.23"] }, budgetMs: 120_001 }],
    ["a budget below five seconds", { protocols: ["OPC_UA"], opcua: { hosts: ["10.20.30.23"] }, budgetMs: 4_999 }],
    ["more than eight ports", { protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.30.0/30"], ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] } } }],
    ["a port out of range", { protocols: ["OPC_UA"], opcua: { sweep: { cidrs: ["10.20.30.0/30"], ports: [65536] } } }],
    ["a malformed known endpoint", { protocols: ["OPC_UA"], opcua: { hosts: ["10.20.30.23"] }, knownEndpoints: ["umg801:4840"] }],
    ["not an object", "scan everything"],
  ])("refuses %s as an invalid request", (_name, payload) => {
    expect(refusal(payload)).toMatch(/^invalid discovery request: /);
  });
});
