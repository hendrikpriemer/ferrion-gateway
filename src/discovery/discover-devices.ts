import { cidrContainsAddress, formatCidr, formatIpv4, parseIpv4 } from "./ipv4.js";
import { IDENTIFY_CONCURRENCY, IDENTIFY_TIMEOUT_MS, identifyOpcuaServer, type IdentifyFn, type Identity } from "./opcua-identify.js";
import { endpointKey, type ScanPlan } from "./scan-request.js";
import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, probeTcp, runPool, type ProbeFn } from "./tcp-probe.js";

// DISCOVER_DEVICES (R07, stage 2): sweep, identify, and what a Local
// Discovery Server adds, within the scan's budget and candidate limit.

/** Candidates per scan; more is reported as truncated. */
export const MAX_CANDIDATES = 64;
// Below this much budget left, a new identification is not worth starting.
const MIN_IDENTIFY_MS = 300;
// The sweep's share of the budget; the rest is kept for identifying what it
// found. Found live (24.10.): a /24 on eight ports is 2 040 probes, about
// 64 s at 32 a second against hosts that do not answer - the sweep used up
// a 60 s budget, found eight open ports and identified none of them.
export const SWEEP_BUDGET_SHARE = 0.7;

export type FoundBy = "sweep" | "host" | "lds";

export interface Candidate extends Omit<Identity, "registeredServers"> {
  protocol: "OPC_UA";
  host: string;
  port: number;
  // The address that answered - what a data source should connect to.
  endpointUrl: string;
  foundBy: FoundBy[];
}

export interface DiscoveryResult {
  candidates: Candidate[];
  // Local Discovery Servers met on the way: not devices themselves.
  discoveryServers: Array<{ host: string; port: number; applicationUri: string | null; registeredServers: number }>;
  scan: {
    durationMs: number;
    // TCP probes actually sent.
    probed: number;
    openPorts: number;
    // Open ports that did not speak OPC UA (a web server on 4840, say).
    notOpcua: number;
    truncated: boolean;
    truncatedBy: "budget" | "candidates" | null;
    limit: string[];
  };
}

export interface DiscoverDeps {
  probe?: ProbeFn;
  identify?: IdentifyFn;
  now?: () => number;
}

interface Endpoint {
  address: number;
  port: number;
  foundBy: Set<FoundBy>;
}

/**
 * Where a server registered at an LDS can be reached. A *Local* Discovery
 * Server runs on the same machine as the servers registered with it (OPC UA
 * Part 12), and those servers report themselves by hostname, which the
 * gateway may not resolve - so the LDS's own address with the reported port.
 * A reported IPv4 literal is taken as it is, if the limit allows it; a name
 * is never resolved, since DNS could point anywhere.
 */
export function registeredEndpoint(discoveryUrl: string, ldsAddress: number, plan: ScanPlan): { address: number; port: number } | null {
  const match = /^opc\.tcp:\/\/([^/:]+|\[[^\]]+\]):(\d{1,5})(?:\/.*)?$/i.exec(discoveryUrl);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const literal = parseIpv4(match[1] as string);
  const address = literal ?? ldsAddress;
  if (!plan.limit.some((allowed) => cidrContainsAddress(allowed, address))) return null;
  return { address, port };
}

export async function discoverDevices(plan: ScanPlan, deps: DiscoverDeps = {}): Promise<DiscoveryResult> {
  const probe = deps.probe ?? probeTcp;
  const identify = deps.identify ?? identifyOpcuaServer;
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + plan.budgetMs;
  let truncatedBy: DiscoveryResult["scan"]["truncatedBy"] = null;

  // 1. Sweep: which address:port pairs accept a connection. Named hosts
  //    first - someone asked for them by address.
  const named = plan.addresses.filter((address) => plan.namedHosts.has(address));
  const swept = plan.addresses.filter((address) => !plan.namedHosts.has(address));
  const targets = [...named, ...swept].flatMap((address) => plan.ports.map((port) => ({ address, port })));
  const open: Endpoint[] = [];
  const { started: probed } = await runPool(
    targets,
    PROBE_CONCURRENCY,
    started + Math.floor(plan.budgetMs * SWEEP_BUDGET_SHARE),
    async ({ address, port }) => {
      if (await probe(formatIpv4(address), port, PROBE_TIMEOUT_MS)) {
        open.push({ address, port, foundBy: new Set([plan.namedHosts.has(address) ? "host" : "sweep"]) });
      }
    },
    now,
  );
  if (probed < targets.length) truncatedBy = "budget";

  // 2. Identify, then once more for what an LDS named. One hop only: an LDS
  //    registered at another LDS is not followed.
  const endpoints = new Map<string, Endpoint>();
  for (const endpoint of open) endpoints.set(endpointKey(endpoint.address, endpoint.port), endpoint);
  const candidates = new Map<string, Candidate>();
  const discoveryServers: DiscoveryResult["discoveryServers"] = [];
  let notOpcua = 0;

  const identifyRound = async (round: Endpoint[]): Promise<Endpoint[]> => {
    const named: Endpoint[] = [];
    const { started: begun } = await runPool(
      round,
      IDENTIFY_CONCURRENCY,
      deadline - MIN_IDENTIFY_MS,
      async (endpoint) => {
        const key = endpointKey(endpoint.address, endpoint.port);
        const host = formatIpv4(endpoint.address);
        let identity: Identity;
        try {
          identity = await identify(host, endpoint.port, {
            openSession: !plan.knownEndpoints.has(key),
            timeoutMs: Math.min(IDENTIFY_TIMEOUT_MS, Math.max(MIN_IDENTIFY_MS, deadline - now())),
          });
        } catch {
          notOpcua += 1;
          return;
        }
        const { registeredServers, ...rest } = identity;
        if (identity.applicationType === "DiscoveryServer") {
          discoveryServers.push({ host, port: endpoint.port, applicationUri: identity.applicationUri, registeredServers: registeredServers.length });
        } else if (candidates.size < MAX_CANDIDATES) {
          candidates.set(key, { protocol: "OPC_UA", host, port: endpoint.port, endpointUrl: `opc.tcp://${host}:${endpoint.port}`, foundBy: [], ...rest });
        } else {
          truncatedBy ??= "candidates";
        }
        for (const server of registeredServers) {
          for (const url of server.discoveryUrls) {
            const target = registeredEndpoint(url, endpoint.address, plan);
            if (!target) continue;
            const targetKey = endpointKey(target.address, target.port);
            const known = endpoints.get(targetKey);
            if (known) {
              known.foundBy.add("lds");
            } else {
              const added: Endpoint = { ...target, foundBy: new Set(["lds"]) };
              endpoints.set(targetKey, added);
              named.push(added);
            }
          }
        }
      },
      now,
    );
    if (begun < round.length) truncatedBy ??= "budget";
    return named;
  };

  const fromLds = await identifyRound(open);
  await identifyRound(fromLds);

  for (const [key, candidate] of candidates) {
    candidate.foundBy = [...(endpoints.get(key)?.foundBy ?? [])].sort();
  }

  return {
    candidates: [...candidates.values()].sort((a, b) => (parseIpv4(a.host) ?? 0) - (parseIpv4(b.host) ?? 0) || a.port - b.port),
    discoveryServers,
    scan: {
      durationMs: now() - started,
      probed,
      openPorts: open.length,
      notOpcua,
      truncated: truncatedBy !== null,
      truncatedBy,
      limit: plan.limit.map(formatCidr),
    },
  };
}
