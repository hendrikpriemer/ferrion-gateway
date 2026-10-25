import { z } from "zod";
import { zodReason } from "../util/zod-reason.js";
import { cidrContainsAddress, cidrContainsCidr, cidrHosts, formatIpv4, parseCidr, parseIpv4, type Cidr } from "./ipv4.js";

// What a DISCOVER_DEVICES command may ask for, and the gateway's own say in
// it (R07, stage 2, decision 8).
//
// ferrion checks a request against the networks released for this gateway
// before it is sent. The gateway checks again, and against a limit ferrion
// cannot change: FG_DISCOVERY_ALLOWED_CIDRS, set by whoever runs the gateway
// on site. In a company network that reaches every plant worldwide, that
// limit is what keeps a wrong or misused release in ferrion from turning a
// gateway into a scanner of the whole network. Not set means no discovery.

export const DISCOVERY_LIMIT_ENV = "FG_DISCOVERY_ALLOWED_CIDRS";

/** Widest block one request may sweep: 1 022 hosts. */
export const MAX_SWEEP_PREFIX = 22;
/** Addresses per scan, over every block and host together. */
export const MAX_SCAN_ADDRESSES = 1024;
export const MAX_SCAN_PORTS = 8;
export const DEFAULT_OPCUA_PORT = 4840;
export const DEFAULT_BUDGET_MS = 30_000;
export const MIN_BUDGET_MS = 5_000;
// ferrion's command deadline is the budget plus 30 s; a longer scan would be
// closed as a timeout before it could answer.
export const MAX_BUDGET_MS = 120_000;
export const MAX_KNOWN_ENDPOINTS = 2_000;

export interface DiscoveryLimit {
  cidrs: Cidr[];
  // Entries that did not parse - reported, never widened into something.
  invalid: string[];
}

/** The limit from the environment. Comma- or space-separated; unparsable entries are dropped. */
export function readDiscoveryLimit(env: NodeJS.ProcessEnv = process.env): DiscoveryLimit {
  const entries = (env[DISCOVERY_LIMIT_ENV] ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  const cidrs: Cidr[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const parsed = parseCidr(entry);
    if (parsed) cidrs.push(parsed);
    else invalid.push(entry);
  }
  return { cidrs, invalid };
}

const endpointPattern = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;

const scanRequestSchema = z.object({
  protocols: z.array(z.string()).min(1),
  opcua: z
    .object({
      hosts: z.array(z.string()).max(MAX_SCAN_ADDRESSES).optional(),
      sweep: z
        .object({
          cidrs: z.array(z.string()).max(64),
          // Also the ports tried on every named host.
          ports: z.array(z.number().int().min(1).max(65535)).min(1).max(MAX_SCAN_PORTS).optional(),
        })
        .optional(),
    })
    .optional(),
  budgetMs: z.number().int().min(MIN_BUDGET_MS).max(MAX_BUDGET_MS).optional(),
  // host:port of devices that already run as a data source. They get
  // GetEndpoints only, never a session: a real device has few session slots,
  // and the session the readings use lives in another process (the bridge
  // instance), so this scan cannot share it.
  knownEndpoints: z.array(z.string().regex(endpointPattern)).max(MAX_KNOWN_ENDPOINTS).optional(),
});

export interface ScanPlan {
  // Addresses to probe, deduplicated, each on every port in `ports`.
  addresses: number[];
  ports: number[];
  // Explicitly named hosts, for `foundBy: "host"`.
  namedHosts: Set<number>;
  budgetMs: number;
  knownEndpoints: Set<string>;
  limit: Cidr[];
}

export type ScanPlanResult = { ok: true; plan: ScanPlan } | { ok: false; error: string };

/**
 * Checks a request and turns it into the list of addresses to probe. Every
 * refusal happens here, before a single probe leaves the gateway.
 */
export function planScan(payload: unknown, limit: DiscoveryLimit): ScanPlanResult {
  if (limit.cidrs.length === 0) {
    return { ok: false, error: `discovery not enabled on this gateway (${DISCOVERY_LIMIT_ENV} not set)` };
  }
  const parsed = scanRequestSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: `invalid discovery request: ${zodReason(parsed.error)}` };
  const request = parsed.data;
  if (!request.protocols.includes("OPC_UA")) {
    return { ok: false, error: `no supported protocol requested (supported: OPC_UA)` };
  }

  const insideLimit = (block: Cidr) => limit.cidrs.some((allowed) => cidrContainsCidr(allowed, block));
  const blocks: Cidr[] = [];
  for (const text of request.opcua?.sweep?.cidrs ?? []) {
    const block = parseCidr(text);
    if (!block) return { ok: false, error: `not an IPv4 network: ${text}` };
    if (block.prefix < MAX_SWEEP_PREFIX) return { ok: false, error: `network too large (at most /${MAX_SWEEP_PREFIX}): ${text}` };
    if (!insideLimit(block)) return { ok: false, error: `outside gateway discovery limit: ${text}` };
    blocks.push(block);
  }
  const namedHosts = new Set<number>();
  for (const text of request.opcua?.hosts ?? []) {
    const address = parseIpv4(text);
    if (address === null) return { ok: false, error: `not an IPv4 address: ${text}` };
    if (!limit.cidrs.some((allowed) => cidrContainsAddress(allowed, address))) {
      return { ok: false, error: `outside gateway discovery limit: ${text}` };
    }
    namedHosts.add(address);
  }
  if (blocks.length === 0 && namedHosts.size === 0) return { ok: false, error: "nothing to scan (no network, no host)" };

  // Counted after deduplication: two overlapping blocks are one scan of
  // their union. At most 64 /22s, so the set stays small either way.
  const addresses = new Set<number>(namedHosts);
  for (const block of blocks) for (const address of cidrHosts(block)) addresses.add(address);
  if (addresses.size > MAX_SCAN_ADDRESSES) {
    return { ok: false, error: `too many addresses (at most ${MAX_SCAN_ADDRESSES} per scan, over all networks together)` };
  }

  const ports = [...new Set(request.opcua?.sweep?.ports ?? [DEFAULT_OPCUA_PORT])];
  return {
    ok: true,
    plan: {
      addresses: [...addresses].sort((a, b) => a - b),
      ports,
      namedHosts,
      budgetMs: request.budgetMs ?? DEFAULT_BUDGET_MS,
      knownEndpoints: new Set(request.knownEndpoints ?? []),
      limit: limit.cidrs,
    },
  };
}

export function endpointKey(address: number, port: number): string {
  return `${formatIpv4(address)}:${port}`;
}
