import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstanceRecord } from "../src/control-plane/instance-store.js";
import { checkDataDirectory, formatDataCheck, hasFinding, summarize } from "./check-data-lib.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Shaped exactly like a record the control plane writes today - the point
// of the whole check is that a real, untouched file passes, so an invented
// "valid" shape would prove nothing.
const realRecord: InstanceRecord = {
  id: "0d4a3c9e-2b31-4a0e-9d51-5f0e6b1c2d34",
  instanceName: "ds1-modbus-1",
  device: { templateId: "aventics-ds1-modbus-tcp", serialNumber: "1" },
  ports: { modbus: 5502 },
  autoStart: true,
  createdAt: "2026-08-30T09:12:44.104Z",
};

const bridgeRecord: InstanceRecord = {
  id: "1e5b4da0-3c42-4b1f-ae62-6a1f7c2d3e45",
  instanceName: "bridge",
  ports: {},
  autoStart: true,
  createdAt: "2026-08-30T09:12:45.210Z",
};

const realSettings = {
  baseUrl: "https://ferrion.example:3000",
  apiKey: "gw_Ny1rZXktZm9yLXRlc3Rpbmctb25seQ",
  rejectUnauthorized: true,
};

function dataDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fg-check-data-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

describe("checkDataDirectory", () => {
  it("passes a file in the shape the control plane actually writes", () => {
    const check = checkDataDirectory(
      dataDir({ "instances.json": json([realRecord, bridgeRecord]), "settings.json": json(realSettings) }),
    );

    expect(check.instances.verdict.kind).toBe("records");
    expect(check.instances.summary).toEqual({ total: 2, bridge: 1, autoStart: 2 });
    expect(check.settings).toEqual({ kind: "settings", baseUrl: "https://ferrion.example:3000" });
    expect(hasFinding(check)).toBe(false);
  });

  it("treats a fresh install with no files as fine, not as a finding", () => {
    // If an empty directory failed the command, the first thing an operator
    // learns is that its output can be ignored.
    const check = checkDataDirectory(dataDir({}));

    expect(check.instances.verdict.kind).toBe("absent");
    expect(check.settings.kind).toBe("absent");
    expect(hasFinding(check)).toBe(false);
  });

  it("rejects an instances.json whose ports carry a key the strict schema drops", () => {
    // The actual upgrade risk this tool exists for: portsSchema is a
    // strictObject, so a field that an older version once wrote there is
    // not ignored - it disqualifies the whole file and every instance in it.
    const check = checkDataDirectory(
      dataDir({
        "instances.json": json([{ ...realRecord, ports: { modbus: 5502, http: 8080 } }]),
        "settings.json": json(realSettings),
      }),
    );

    expect(check.instances.verdict.kind).toBe("rejected");
    expect(hasFinding(check)).toBe(true);
  });

  it("rejects a hand-edited instances.json that is an object rather than an array", () => {
    const check = checkDataDirectory(dataDir({ "instances.json": "{}", "settings.json": json(realSettings) }));

    expect(check.instances.verdict.kind).toBe("rejected");
    expect(check.instances.summary).toBeUndefined();
    expect(hasFinding(check)).toBe(true);
  });

  it("reports a truncated instances.json as invalid JSON", () => {
    const check = checkDataDirectory(dataDir({ "instances.json": '[{"id":"a"' }));

    expect(check.instances.verdict).toEqual({ kind: "rejected", cause: "json", reason: "not valid JSON" });
    expect(hasFinding(check)).toBe(true);
  });

  it("rejects settings without an apiKey, the quiet failure that stops every instance", () => {
    const check = checkDataDirectory(
      dataDir({
        "instances.json": json([realRecord]),
        "settings.json": json({ baseUrl: "https://ferrion.example:3000" }),
      }),
    );

    expect(check.settings.kind).toBe("rejected");
    // The instance list surviving is exactly what makes this one deceptive:
    // the UI looks intact and nothing runs.
    expect(check.instances.verdict.kind).toBe("records");
    expect(hasFinding(check)).toBe(true);
  });

  it("never carries the API key out of the check", () => {
    // The result object is what a caller would naturally log or hand to a
    // deploy script, so the key must not be reachable from it at all -
    // not merely absent from the rendered output.
    const check = checkDataDirectory(
      dataDir({ "instances.json": json([realRecord]), "settings.json": json(realSettings) }),
    );

    expect(JSON.stringify(check)).not.toContain(realSettings.apiKey);
    expect(formatDataCheck(check)).not.toContain(realSettings.apiKey);
  });

  it("keeps the API key out of the rejection reason too", () => {
    // The success path is redacted by construction and proves little. The
    // one path where an input value could ever surface is the validation
    // message, so that is the path worth guarding: a settings file with a
    // real key and one offending field.
    const check = checkDataDirectory(
      dataDir({ "settings.json": json({ ...realSettings, rejectUnauthorized: "nein" }) }),
    );

    expect(check.settings.kind).toBe("rejected");
    expect(JSON.stringify(check)).not.toContain(realSettings.apiKey);
    expect(formatDataCheck(check)).not.toContain(realSettings.apiKey);
  });
});

describe("summarize", () => {
  it("counts a bridge by the absence of a device, not by its name", () => {
    // "bridge" as an instanceName is a convention, not a guarantee - an
    // operator can rename it in the UI, and the record stays the bridge.
    expect(summarize([{ ...bridgeRecord, instanceName: "Werk 2 Hardware" }])).toEqual({
      total: 1,
      bridge: 1,
      autoStart: 1,
    });
  });

  it("does not count a stopped instance as autostarting", () => {
    expect(summarize([{ ...realRecord, autoStart: false }, { ...realRecord, autoStart: undefined }])).toEqual({
      total: 2,
      bridge: 0,
      autoStart: 0,
    });
  });
});

describe("formatDataCheck", () => {
  it("names the counts to compare against after the restart", () => {
    const output = formatDataCheck(
      checkDataDirectory(
        dataDir({ "instances.json": json([realRecord, bridgeRecord]), "settings.json": json(realSettings) }),
      ),
    );

    expect(output).toContain("2 Instanzen, davon 1 Bridge, 2 mit Autostart");
    expect(output).toContain("https://ferrion.example:3000");
    expect(output).toContain("lädt unter der neuen Version unverändert");
    expect(output).not.toContain("BEFUND");
  });

  it("says what the start would do with a rejected file, not just that it is wrong", () => {
    const output = formatDataCheck(checkDataDirectory(dataDir({ "instances.json": "{}" })));

    expect(output).toContain("ABGELEHNT");
    expect(output).toContain("instances.json.invalid-<Zeit>");
    expect(output).toContain("BEFUND");
  });

  it("warns that missing settings stop every instance, including autostart ones", () => {
    const output = formatDataCheck(checkDataDirectory(dataDir({ "instances.json": json([realRecord]) })));

    expect(output).toContain("KEINE Instanz");
    // Absent settings are a legitimate pre-configuration state, so this
    // informs without failing the command.
    expect(output).toContain("lädt unter der neuen Version unverändert");
  });

  it("names the offending record and field, not a bracket", () => {
    // The whole tool exists to answer "what is wrong with the file". zod 4
    // renders error.message as indented JSON whose first line is literally
    // "[", so an earlier take-the-first-line version printed "Grund: [".
    // Asserting on the count of "Grund:" lines would not have caught that -
    // only asserting on what the line actually says does.
    const output = formatDataCheck(
      checkDataDirectory(
        dataDir({ "instances.json": json([realRecord, { ...realRecord, ports: { modbus: 5502, http: 8080 } }]) }),
      ),
    );
    const grund = output.split("\n").find((line) => line.includes("Grund:"))?.trim();

    expect(grund).toBe('Grund: 1.ports: Unrecognized key: "http"');
  });

  it("counts the further problems instead of printing all of them", () => {
    const output = formatDataCheck(
      checkDataDirectory(dataDir({ "instances.json": json([{ id: "", instanceName: "", ports: {}, createdAt: "" }]) })),
    );
    const grund = output.split("\n").find((line) => line.includes("Grund:"))?.trim() ?? "";

    expect(grund).toContain("and 2 more");
    expect(output.split("\n").filter((line) => line.includes("Grund:"))).toHaveLength(1);
  });

  it("says which kind of broken a file is", () => {
    // Both causes land in the same verdict kind, and telling an operator
    // "passt nicht zum Schema dieser Version" about a half-written file
    // points them at an upgrade problem that does not exist.
    const truncated = formatDataCheck(checkDataDirectory(dataDir({ "instances.json": '[{"id":"a"' })));
    const schema = formatDataCheck(checkDataDirectory(dataDir({ "instances.json": "{}" })));

    expect(truncated).toContain("Kein gültiges JSON");
    expect(truncated).not.toContain("Schema dieser Version");
    expect(schema).toContain("Schema dieser Version");
    expect(schema).not.toContain("Kein gültiges JSON");
  });

  it("warns that a rejected file still comes up with a fresh bridge", () => {
    // "kommt ohne Instanzen hoch" was wrong: ensureBridgeInstance() writes a
    // new bridge record at boot, so real hardware keeps running. That is the
    // half of the message an operator needs before deciding how urgent it is.
    const output = formatDataCheck(checkDataDirectory(dataDir({ "instances.json": "{}" })));

    expect(output).toContain("frisch angelegten Bridge");
    expect(output).toContain("echte Hardware läuft weiter");
  });

  it("shows why an unreadable file could not be read", () => {
    // A directory where a file is expected is the realistic version of this
    // on a volume with a botched mount; EISDIR answers the question that
    // "Rechte? Volume?" only asks.
    const dir = dataDir({});
    mkdirSync(path.join(dir, "instances.json"));

    const output = formatDataCheck(checkDataDirectory(dir));

    expect(output).toContain("UNLESBAR");
    expect(output).toMatch(/Grund: .*EISDIR/);
  });
});
