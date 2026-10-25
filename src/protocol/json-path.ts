// Shared by gateway-client.ts (read side, extracting a jsonField from an
// incoming MQTT payload) and device-simulator.ts (write side, building a
// simulated payload) - a dot-free path behaves exactly like a plain object
// key lookup/assignment in both directions, so every existing flat
// jsonField (e.g. "massFlowRate") is unaffected.

export function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  // Split off with .pop() (a for-of over segments.slice(0, -1) would work
  // too, but this avoids the extra array copy) rather than indexing
  // segments[segments.length - 1] directly - under this repo's
  // noUncheckedIndexedAccess, an array-index read is typed T | undefined,
  // which can't be used as a Record's key. .split(".") on a non-empty path
  // always yields at least one element, so lastSegment is only undefined
  // for a "" path, which no caller passes (jsonField is always a
  // non-empty configured string) - the guard below just keeps the types
  // honest for that impossible case rather than asserting it away.
  const lastSegment = segments.pop();
  if (lastSegment === undefined) return;

  let current = obj;
  for (const segment of segments) {
    const next = current[segment];
    if (typeof next !== "object" || next === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[lastSegment] = value;
}
