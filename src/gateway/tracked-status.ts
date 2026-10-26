// The statuses a tracked source can have, in one place for both ends of the
// IPC channel: the reading loop in the child sets them, and the control
// plane's message schema accepts exactly these. Two separate lists drifted
// apart once - "node-unknown" was added to the child only, and the parent
// then dropped every status message of such an instance (ferrion#960).
//
// Its own module because the control plane must not import reading-loop.ts
// for a value: that would load the protocol clients into the parent process.
export const TRACKED_SOURCE_STATUSES = ["live", "stale", "error", "node-unknown"] as const;

export type TrackedSourceStatusValue = (typeof TRACKED_SOURCE_STATUSES)[number];
