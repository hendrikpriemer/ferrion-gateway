import type { CommandResultInput } from "../ferrion-client/types.js";
import { discoverDevices, type DiscoverDeps } from "./discover-devices.js";
import { planScan, type DiscoveryLimit } from "./scan-request.js";

/**
 * DISCOVER_DEVICES end to end: refuse what the request or the gateway's own
 * limit does not allow, before anything leaves the gateway; otherwise scan
 * and report every candidate. Never throws - a refusal is a FAILED result
 * with the reason, which ferrion shows as it is.
 */
export async function handleDiscoverDevices(payload: unknown, limit: DiscoveryLimit, deps: DiscoverDeps = {}): Promise<CommandResultInput> {
  const planned = planScan(payload, limit);
  if (!planned.ok) return { status: "FAILED", result: { error: planned.error } };
  return { status: "COMPLETED", result: await discoverDevices(planned.plan, deps) };
}
