// Pure, protocol-agnostic staleness check: is a cached value still fresh
// enough to hand out? Used by the MQTT client (a device that publishes on
// its own cadence and then stops) - the OPC UA client judges liveness by
// its subscription's keepalives instead, since monitored items report
// changes only. Kept dependency-free so it stays trivially unit-testable.
export interface StalenessState {
  latestValueAt: number | undefined;
}

// A target that has never received a value yet is "no data", not "stale" -
// it may simply be waiting for its first sample. Only a target that WAS
// live and has gone silent for longer than `thresholdMs` counts as stale.
export function isStale(state: StalenessState, now: number, thresholdMs: number): boolean {
  return state.latestValueAt !== undefined && now - state.latestValueAt > thresholdMs;
}
