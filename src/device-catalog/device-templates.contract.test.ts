import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contractView } from "./contract.js";
import { DEVICE_TEMPLATES } from "./known-device-templates.js";

// The cross-repository contract: this catalog, reduced to what the sensors
// actually read, must equal device-templates.contract.json - and ferrion's
// catalog must equal its identical copy of that file. Changing a template
// is therefore a deliberate two-repository change of the JSON, never a
// silent drift on one side (review 2026-09, N-19).
describe("device catalog contract", () => {
  it("matches device-templates.contract.json exactly", () => {
    const fixture = JSON.parse(readFileSync(new URL("./device-templates.contract.json", import.meta.url), "utf-8")) as unknown;
    expect(contractView(DEVICE_TEMPLATES)).toEqual(fixture);
  });
});
