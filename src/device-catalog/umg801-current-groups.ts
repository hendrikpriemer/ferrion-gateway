/**
 * Reading a Janitza UMG 801's own list of current groups off the device.
 *
 * A current group is one outgoing circuit, and it is the unit a person
 * actually wants to pick: "Kompressor HD1", not "register 19500". The device
 * knows those names - its web interface shows them - and serves them over
 * plain HTTP without authentication (confirmed on firmware 1.6.2 at the unit
 * on site, 2026-10-08; identifying fields anonymised):
 *
 *   GET /deviceinfo/structure               which devices are fitted
 *   GET /deviceinfo/structure/currentGroup  each device's groups, with names
 *
 * Until now the catalogue offered up to 154 checkboxes named after registers,
 * and the names on the device were nowhere to be seen. Worse, what it called
 * "Modul 2" was module 1's second group - see
 * `docs/janitza-umg801-stromgruppen-2026-10-08.md` in ferrion.
 *
 * The parsing lives apart from the fetching on purpose: the shapes below are
 * pinned against the device's own three responses, kept as fixtures in
 * `fixtures/umg801-2026-10-08/`, so a change to the format fails a test
 * rather than quietly producing an empty list.
 */

/** One current group, as the device describes it. */
export type Umg801CurrentGroup = {
  /** Physical position: 0 is the base device, 1..n the fitted modules. */
  device: number;
  /** The group's number within that device, 1-based (IG1, IG2, ...). */
  group: number;
  /**
   * The name configured on the device, or null when there is none.
   *
   * Two spellings mean "unnamed" here: an empty string, and the literal
   * "N/A" - both occur on the real unit (base IG3 is empty, module 1 IG1 is
   * "N/A"). Neither is a name a person chose, and neither should be offered
   * as one.
   */
  name: string | null;
  /** The device's own type, e.g. "UMG801/5A" or "800-CT8-A". */
  moduleType: string;
};

type StructureEntry = {
  physPos?: unknown;
  type?: unknown;
  numCurrentGroups?: unknown;
  state?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** "" and "N/A" both mean the group was never named. */
function groupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "N/A") return null;
  return trimmed;
}

/**
 * The current groups the two responses describe, in device and group order.
 *
 * Driven by `/deviceinfo/structure` rather than by the group response alone:
 * that one says which devices are actually fitted and how many groups each
 * carries, and it is the only place the module type appears. A group listed
 * under a device that is not fitted - or beyond that device's group count -
 * is left out rather than trusted.
 */
export function parseUmg801CurrentGroups(structure: unknown, currentGroups: unknown): Umg801CurrentGroup[] {
  if (!Array.isArray(structure)) return [];
  const groupsByDevice = asRecord(currentGroups);
  if (!groupsByDevice) return [];

  const found: Umg801CurrentGroup[] = [];
  for (const entry of structure as StructureEntry[]) {
    const device = asRecord(entry);
    if (!device) continue;
    const physPos = device.physPos;
    const moduleType = device.type;
    const count = device.numCurrentGroups;
    if (typeof physPos !== "number" || typeof moduleType !== "string" || typeof count !== "number") continue;
    // A module that is fitted but not running has no readable groups, and
    // offering them would promise data that never arrives.
    if (device.state !== undefined && device.state !== "active") continue;

    const perDevice = asRecord(groupsByDevice[`D${physPos}`]);
    for (let group = 1; group <= count; group++) {
      const described = asRecord(perDevice?.[`IG${group}`]);
      // No entry means the device did not describe this group; it is still a
      // group the structure says exists, so it is offered - just unnamed.
      found.push({
        device: physPos,
        group,
        name: groupName(described?.name),
        moduleType,
      });
    }
  }
  return found;
}

/** How long the device gets to answer. It is on the local network, or it is not there. */
const DEVICE_INFO_TIMEOUT_MS = 5000;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DEVICE_INFO_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * Asks the device for its current groups, or returns null.
 *
 * Null, not an exception: a connection test that already succeeded must not
 * fail because this extra lookup did. Older firmware, a closed port 80, or a
 * unit that wants authentication all end up here, and the caller falls back
 * to what it did before - with a warning, so nobody mistakes "we could not
 * ask" for "this device has no groups".
 */
export async function discoverUmg801CurrentGroups(host: string): Promise<Umg801CurrentGroup[] | null> {
  const base = `http://${host}`;
  try {
    const [structure, currentGroups] = await Promise.all([
      fetchJson(`${base}/deviceinfo/structure`),
      fetchJson(`${base}/deviceinfo/structure/currentGroup`),
    ]);
    const groups = parseUmg801CurrentGroups(structure, currentGroups);
    // An empty list from a device that answered is not a usable answer
    // either - it would hide every group behind "none found".
    return groups.length > 0 ? groups : null;
  } catch {
    return null;
  }
}
