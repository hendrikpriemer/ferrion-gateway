import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUmg801CurrentGroups } from "./umg801-current-groups.js";

/**
 * Against the device's own answers, not against a hand-written shape: the
 * two JSON files are exactly what a real UMG 801 served on
 * 2026-10-08 (firmware 1.6.2, base device plus three 800-CT8-A).
 */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(process.cwd(), "src/device-catalog/fixtures/umg801-2026-10-08", name), "utf-8"));

const STRUCTURE = fixture("deviceinfo-structure.json");
const CURRENT_GROUPS = fixture("deviceinfo-structure-currentGroup.json");

describe("parseUmg801CurrentGroups", () => {
  it("finds all nine groups of the real unit, with the names from the device", () => {
    // Nine, not four: the base device carries three current groups and each
    // 800-CT8-A carries two. The catalogue offered four.
    expect(parseUmg801CurrentGroups(STRUCTURE, CURRENT_GROUPS)).toEqual([
      { device: 0, group: 1, name: "Kompressor ND1", moduleType: "UMG801/5A" },
      { device: 0, group: 2, name: "Kompressor ND3", moduleType: "UMG801/5A" },
      { device: 0, group: 3, name: null, moduleType: "UMG801/5A" },
      { device: 1, group: 1, name: null, moduleType: "800-CT8-A" },
      { device: 1, group: 2, name: "Kompressor HD1", moduleType: "800-CT8-A" },
      { device: 2, group: 1, name: "Kompressor ND2", moduleType: "800-CT8-A" },
      { device: 2, group: 2, name: "Kompressor HD2", moduleType: "800-CT8-A" },
      { device: 3, group: 1, name: "Trockner 2 rechts", moduleType: "800-CT8-A" },
      { device: 3, group: 2, name: "Trockner 1 links", moduleType: "800-CT8-A" },
    ]);
  });

  it("treats an empty name and the literal N/A alike, as no name at all", () => {
    // Both occur on the real unit - base IG3 is "", module 1 IG1 is "N/A".
    // Neither is a name a person chose, and the dialog must not pre-select
    // a group it cannot name.
    const groups = parseUmg801CurrentGroups(STRUCTURE, CURRENT_GROUPS);

    expect(groups.find((g) => g.device === 0 && g.group === 3)?.name).toBeNull();
    expect(groups.find((g) => g.device === 1 && g.group === 1)?.name).toBeNull();
  });

  it("leaves out a module that is fitted but not running", () => {
    const withInactive = (STRUCTURE as Record<string, unknown>[]).map((device) =>
      device.physPos === 2 ? { ...device, state: "inactive" } : device
    );

    const groups = parseUmg801CurrentGroups(withInactive, CURRENT_GROUPS);

    // Its two groups are gone; everyone else's remain.
    expect(groups.some((g) => g.device === 2)).toBe(false);
    expect(groups).toHaveLength(7);
  });

  it("follows the structure's group count, not whatever the group response lists", () => {
    // The structure says how many groups a device carries. A stray entry
    // beyond that count is not a group - trusting it would offer registers
    // the device does not serve.
    const extra = JSON.parse(JSON.stringify(CURRENT_GROUPS)) as Record<string, Record<string, unknown>>;
    extra.D1!.IG3 = { id: 3, name: "Erfunden", type: "system" };

    const groups = parseUmg801CurrentGroups(STRUCTURE, extra);

    expect(groups.filter((g) => g.device === 1)).toHaveLength(2);
    expect(groups.some((g) => g.name === "Erfunden")).toBe(false);
  });

  it("still offers a group the device listed in the structure but did not describe", () => {
    // The other direction: the structure is the authority on existence, so a
    // missing description costs the name, not the group.
    const withoutDescription = JSON.parse(JSON.stringify(CURRENT_GROUPS)) as Record<string, Record<string, unknown>>;
    delete withoutDescription.D0!.IG2;

    const groups = parseUmg801CurrentGroups(STRUCTURE, withoutDescription);

    expect(groups.find((g) => g.device === 0 && g.group === 2)).toEqual({
      device: 0,
      group: 2,
      name: null,
      moduleType: "UMG801/5A",
    });
  });

  it("answers with nothing for responses it cannot read", () => {
    // Older firmware, a different product, an error page - all end up here,
    // and the caller falls back rather than inventing groups.
    expect(parseUmg801CurrentGroups(null, CURRENT_GROUPS)).toEqual([]);
    expect(parseUmg801CurrentGroups(STRUCTURE, null)).toEqual([]);
    expect(parseUmg801CurrentGroups({ nope: true }, CURRENT_GROUPS)).toEqual([]);
    expect(parseUmg801CurrentGroups([{ physPos: "0" }], CURRENT_GROUPS)).toEqual([]);
  });
});
