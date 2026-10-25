import { describe, expect, it, vi } from "vitest";
import { discoverDevices, MAX_CANDIDATES, registeredEndpoint } from "./discover-devices.js";
import type { IdentifyFn, Identity } from "./opcua-identify.js";
import { DISCOVERY_LIMIT_ENV, planScan, readDiscoveryLimit, type ScanPlan } from "./scan-request.js";
import type { ProbeFn } from "./tcp-probe.js";

function plan(opcua: unknown, extra: Record<string, unknown> = {}, limitText = "10.0.4.0/24"): ScanPlan {
  const result = planScan({ protocols: ["OPC_UA"], opcua, ...extra }, readDiscoveryLimit({ [DISCOVERY_LIMIT_ENV]: limitText }));
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    applicationUri: "urn:device",
    productUri: "urn:product",
    applicationName: "Device",
    applicationType: "Server",
    advertisedEndpointUrl: "opc.tcp://device-hostname:4840",
    securityModes: ["None"],
    anonymousWithoutSecurity: true,
    buildInfo: { productUri: null, manufacturerName: "Maker", productName: "Device", softwareVersion: "1.0" },
    namespaceUris: ["http://opcfoundation.org/UA/"],
    sessionSkipped: null,
    sessionError: null,
    registeredServers: [],
    ...overrides,
  };
}

const openOn = (...open: string[]): ProbeFn => vi.fn(async (host, port) => open.includes(`${host}:${port}`));

describe("discoverDevices", () => {
  it("identifies every open port and keeps the probed address, not the reported one", async () => {
    const identify = vi.fn<IdentifyFn>(async () => identity());
    const result = await discoverDevices(plan({ sweep: { cidrs: ["10.0.4.0/29"] } }), {
      probe: openOn("10.0.4.3:4840", "10.0.4.5:4840"),
      identify,
    });

    expect(result.candidates.map((candidate) => [candidate.endpointUrl, candidate.foundBy])).toEqual([
      ["opc.tcp://10.0.4.3:4840", ["sweep"]],
      ["opc.tcp://10.0.4.5:4840", ["sweep"]],
    ]);
    expect(result.candidates[0]?.advertisedEndpointUrl).toBe("opc.tcp://device-hostname:4840");
    expect(result.scan).toMatchObject({ probed: 6, openPorts: 2, notOpcua: 0, truncated: false, truncatedBy: null, limit: ["10.0.4.0/24"] });
    expect(identify).toHaveBeenCalledTimes(2);
  });

  it("marks named hosts as found by host", async () => {
    const result = await discoverDevices(plan({ hosts: ["10.0.4.9"], sweep: { cidrs: [], ports: [4840, 4843] } }), {
      probe: openOn("10.0.4.9:4843"),
      identify: async () => identity(),
    });

    expect(result.candidates.map((candidate) => [candidate.port, candidate.foundBy])).toEqual([[4843, ["host"]]]);
    expect(result.scan.probed).toBe(2);
  });

  it("opens no session at a device that already runs as a data source", async () => {
    const identify = vi.fn<IdentifyFn>(async () => identity());
    await discoverDevices(plan({ hosts: ["10.0.4.9", "10.0.4.10"] }, { knownEndpoints: ["10.0.4.9:4840"] }), {
      probe: openOn("10.0.4.9:4840", "10.0.4.10:4840"),
      identify,
    });

    const sessions = Object.fromEntries(identify.mock.calls.map(([host, , options]) => [host, options.openSession]));
    expect(sessions).toEqual({ "10.0.4.9": false, "10.0.4.10": true });
  });

  it("counts open ports that do not speak OPC UA without listing them", async () => {
    const result = await discoverDevices(plan({ hosts: ["10.0.4.9"] }), {
      probe: openOn("10.0.4.9:4840"),
      identify: async () => {
        throw new Error("not OPC UA");
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.scan.notOpcua).toBe(1);
  });

  it("lists a Local Discovery Server apart and adds the servers it names, at its own address", async () => {
    const identify = vi.fn<IdentifyFn>(async (host, port) =>
      host === "10.0.4.2" && port === 4840
        ? identity({
            applicationType: "DiscoveryServer",
            applicationUri: "urn:lds",
            registeredServers: [
              // By hostname: reached at the LDS's own address.
              { applicationUri: "urn:a", discoveryUrls: ["opc.tcp://plant-pc:48010"] },
              // An IPv4 literal inside the limit is taken as it is.
              { applicationUri: "urn:b", discoveryUrls: ["opc.tcp://10.0.4.20:4841/path"] },
              // Outside the limit: dropped, never probed.
              { applicationUri: "urn:c", discoveryUrls: ["opc.tcp://10.9.9.9:4841"] },
              // Also found by the sweep: merged, not listed twice.
              { applicationUri: "urn:d", discoveryUrls: ["opc.tcp://10.0.4.7:4840"] },
            ],
          })
        : identity({ applicationUri: `urn:${host}:${port}` }),
    );
    const result = await discoverDevices(plan({ sweep: { cidrs: ["10.0.4.0/28"] } }), {
      probe: openOn("10.0.4.2:4840", "10.0.4.7:4840"),
      identify,
    });

    expect(result.discoveryServers).toEqual([{ host: "10.0.4.2", port: 4840, applicationUri: "urn:lds", registeredServers: 4 }]);
    expect(result.candidates.map((candidate) => [candidate.endpointUrl, candidate.foundBy])).toEqual([
      ["opc.tcp://10.0.4.2:48010", ["lds"]],
      ["opc.tcp://10.0.4.7:4840", ["lds", "sweep"]],
      ["opc.tcp://10.0.4.20:4841", ["lds"]],
    ]);
    // Each identified once; 10.0.4.7 is not identified again for the LDS.
    expect(new Set(identify.mock.calls.map(([host, port]) => `${host}:${port}`))).toEqual(
      new Set(["10.0.4.2:4840", "10.0.4.2:48010", "10.0.4.20:4841", "10.0.4.7:4840"]),
    );
    expect(identify).toHaveBeenCalledTimes(4);
  });

  it("follows one LDS hop only", async () => {
    const identify = vi.fn<IdentifyFn>(async (_host, port) =>
      identity({
        applicationType: "DiscoveryServer",
        registeredServers: [{ applicationUri: "urn:next", discoveryUrls: [`opc.tcp://lds:${port + 1}`] }],
      }),
    );
    await discoverDevices(plan({ hosts: ["10.0.4.2"] }), { probe: openOn("10.0.4.2:4840"), identify });

    expect(identify.mock.calls.map(([, port]) => port)).toEqual([4840, 4841]);
  });

  it("stops probing when the budget runs out and says so", async () => {
    let clock = 0;
    const probe: ProbeFn = vi.fn(async () => {
      clock += 1_000;
      return false;
    });
    const result = await discoverDevices(plan({ sweep: { cidrs: ["10.0.4.0/24"] } }, { budgetMs: 5_000 }), {
      probe,
      identify: async () => identity(),
      now: () => clock,
    });

    expect(result.scan.truncated).toBe(true);
    expect(result.scan.truncatedBy).toBe("budget");
    // 16 start at once at t=0; after that every worker sees the deadline.
    expect(result.scan.probed).toBeLessThan(254);
  });

  it("keeps budget for identifying what a slow sweep found, named hosts first", async () => {
    // Found live: every probe at a silent host costs its full timeout, and a
    // sweep allowed the whole budget left none for the open ports it found.
    let clock = 0;
    const probe: ProbeFn = vi.fn(async (host) => {
      await Promise.resolve();
      clock += 500;
      return host === "10.0.4.200";
    });
    const identify = vi.fn<IdentifyFn>(async () => identity());
    const result = await discoverDevices(plan({ hosts: ["10.0.4.200"], sweep: { cidrs: ["10.0.4.0/24"] } }, { budgetMs: 10_000 }), {
      probe,
      identify,
      now: () => clock,
    });

    // The named host was probed first and identified in the time kept back.
    expect(vi.mocked(probe).mock.calls[0]?.[0]).toBe("10.0.4.200");
    expect(result.candidates.map((candidate) => candidate.host)).toEqual(["10.0.4.200"]);
    expect(result.scan.truncatedBy).toBe("budget");
    expect(clock).toBeLessThanOrEqual(7_000 + 16 * 500);
  });

  it("does not start an identification it has no time left for", async () => {
    let clock = 0;
    const identify = vi.fn<IdentifyFn>(async () => {
      // Time passes while the identification runs, not before it starts.
      await Promise.resolve();
      clock += 10_000;
      return identity();
    });
    const result = await discoverDevices(plan({ hosts: ["10.0.4.1", "10.0.4.2", "10.0.4.3", "10.0.4.4", "10.0.4.5"] }, { budgetMs: 5_000 }), {
      probe: async () => true,
      identify,
      now: () => clock,
    });

    // Four start together (the concurrency); the fifth would begin past the deadline.
    expect(identify).toHaveBeenCalledTimes(4);
    expect(result.scan.truncatedBy).toBe("budget");
  });

  it(`keeps at most ${MAX_CANDIDATES} candidates and reports the rest as truncated`, async () => {
    const result = await discoverDevices(plan({ sweep: { cidrs: ["10.0.4.0/25"] } }), {
      probe: async () => true,
      identify: async (host) => identity({ applicationUri: `urn:${host}` }),
    });

    expect(result.candidates).toHaveLength(MAX_CANDIDATES);
    expect(result.scan).toMatchObject({ openPorts: 126, truncated: true, truncatedBy: "candidates" });
  });
});

describe("registeredEndpoint", () => {
  const scan = plan({ hosts: ["10.0.4.2"] });
  const lds = 0x0a000402; // 10.0.4.2

  it.each([
    ["opc.tcp://plant-pc:48010", { address: lds, port: 48010 }],
    ["OPC.TCP://plant-pc:48010/UA/Server", { address: lds, port: 48010 }],
    ["opc.tcp://10.0.4.30:4841", { address: 0x0a00041e, port: 4841 }],
    ["opc.tcp://10.9.9.9:4841", null],
    ["opc.tcp://plant-pc", null],
    ["opc.tcp://plant-pc:0", null],
    ["opc.tcp://plant-pc:70000", null],
    ["http://plant-pc:80", null],
    ["opc.tcp://[fe80::1]:4840", { address: lds, port: 4840 }],
  ])("reads %s", (url, expected) => {
    expect(registeredEndpoint(url, lds, scan)).toEqual(expected);
  });
});
