import path from "node:path";
import { judgeInstanceFile, type InstanceFileVerdict, type InstanceRecord } from "../src/control-plane/instance-store.js";
import { judgeSettingsFile, type SettingsFileVerdict } from "../src/control-plane/settings-store.js";
import { errorMessage } from "../src/util/error-message.js";
import { readJsonFile } from "../src/util/json-file.js";

// Answers one question an operator cannot otherwise answer without
// restarting the very thing they are worried about: would the persisted
// data/ directory still load under the version about to be deployed?
//
// It matters because both stores are deliberately unforgiving at boot -
// instance-store.ts moves a file it cannot parse aside and starts empty,
// settings-store.ts treats an incomplete one as "never configured". Both
// are the right behaviour (the alternative was a boot loop, review 2026-09
// N-3) and both are quiet in the way that hurts: the container reports
// healthy either way, because the control plane does answer - it just has
// nothing left to run. On a remote VM that reads as "the update broke it".
//
// Run against the *new* image before replacing the running container (see
// docs/deployment.md) and the question is answered while the old one is
// still serving.

export interface InstanceSummary {
  total: number;
  bridge: number;
  autoStart: number;
}

// Deliberately not the SettingsFileVerdict itself: that carries the
// decrypted apiKey, and this result object is the thing a caller would
// naturally log, serialise or hand to a deploy script. Narrowing it here
// means the key cannot leave this function by accident - the base URL is
// all an operator needs to recognise the right ferrion instance.
export type SettingsCheck =
  | { kind: "settings"; baseUrl: string }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "rejected"; cause: "json" | "schema"; reason: string };

export interface DataCheck {
  dataDir: string;
  instances: { verdict: InstanceFileVerdict; summary: InstanceSummary | undefined };
  settings: SettingsCheck;
}

function redact(verdict: SettingsFileVerdict): SettingsCheck {
  switch (verdict.kind) {
    case "settings":
      return { kind: "settings", baseUrl: verdict.settings.baseUrl };
    case "absent":
      return { kind: "absent" };
    case "unreadable":
      return { kind: "unreadable", reason: errorMessage(verdict.error) };
    case "rejected":
      return { kind: "rejected", cause: verdict.cause, reason: verdict.reason };
  }
}

export function summarize(records: readonly InstanceRecord[]): InstanceSummary {
  return {
    total: records.length,
    // A bridge-only record is the one carrying real hardware (see
    // instance-store.ts's InstanceRecord.device), so losing it costs live
    // measurements, not a simulation.
    bridge: records.filter((record) => !record.device).length,
    autoStart: records.filter((record) => record.autoStart).length,
  };
}

export function checkDataDirectory(dataDir: string): DataCheck {
  const instanceVerdict = judgeInstanceFile(readJsonFile(path.join(dataDir, "instances.json")));

  return {
    dataDir,
    instances: {
      verdict: instanceVerdict,
      summary: instanceVerdict.kind === "records" ? summarize(instanceVerdict.records) : undefined,
    },
    settings: redact(judgeSettingsFile(readJsonFile(path.join(dataDir, "settings.json")))),
  };
}

// True when the check found data the deployed version would refuse or
// silently ignore. A fresh install with no files at all is deliberately not
// a finding: it is the normal state before the first configuration, and
// failing there would teach operators to ignore this command.
export function hasFinding(check: DataCheck): boolean {
  const bad = (kind: string): boolean => kind === "rejected" || kind === "unreadable";
  return bad(check.instances.verdict.kind) || bad(check.settings.kind);
}

const INDENT = " ".repeat(29);

// The two rejection causes send an operator in opposite directions, so they
// must not share a sentence: a schema mismatch is about this upgrade, a
// broken file is about the write that produced it.
const REJECTION_HEADLINE: Record<"json" | "schema", string> = {
  json: "Kein gültiges JSON (abgebrochener Schreibvorgang? volle Platte?).",
  schema: "Passt nicht zum Schema dieser Version.",
};

function describeInstances(verdict: InstanceFileVerdict, summary: InstanceSummary | undefined): string[] {
  switch (verdict.kind) {
    case "records": {
      const counts = summary ?? summarize(verdict.records);
      return [
        `instances.json   OK          ${counts.total} Instanzen, davon ${counts.bridge} Bridge, ${counts.autoStart} mit Autostart`,
        // Only "genauso viele" when a bridge is already there: without one,
        // ensureBridgeInstance() adds a record at boot and the count that
        // comes back is legitimately one higher.
        ...(counts.bridge === 0
          ? [
              `${INDENT}Nach dem Update ist es eine mehr: Ohne vorhandene Bridge`,
              `${INDENT}legt der Start selbst eine an.`,
            ]
          : [`${INDENT}Nach dem Update müssen es genauso viele sein.`]),
      ];
    }
    case "absent":
      return [
        "instances.json   leer        Keine Instanzen hinterlegt (frische Installation).",
        `${INDENT}Der Start legt sich selbst eine Bridge-Instanz an.`,
      ];
    case "unreadable":
      return [
        "instances.json   UNLESBAR    Vorhanden, aber nicht lesbar (Rechte? Volume?).",
        `${INDENT}Grund: ${errorMessage(verdict.error)}`,
        `${INDENT}Der Start käme ohne die simulierten Instanzen hoch.`,
      ];
    case "rejected":
      return [
        `instances.json   ABGELEHNT   ${REJECTION_HEADLINE[verdict.cause]}`,
        `${INDENT}Grund: ${verdict.reason}`,
        `${INDENT}Der Start verschiebt die Datei nach instances.json.invalid-<Zeit>`,
        // Not "ohne Instanzen": ensureBridgeInstance() recreates a bridge
        // record on the next boot, so real hardware keeps running and only
        // the simulated instances are gone. For an operator that is the
        // more important half of the message.
        `${INDENT}und kommt nur mit einer frisch angelegten Bridge hoch –`,
        `${INDENT}echte Hardware läuft weiter, die Simulationen sind weg.`,
      ];
  }
}

function describeSettings(verdict: SettingsCheck): string[] {
  switch (verdict.kind) {
    case "settings":
      return [`settings.json    OK          ferrion-Verbindung konfiguriert: ${verdict.baseUrl}`];
    case "absent":
      return [
        "settings.json    leer        Keine ferrion-Verbindung hinterlegt.",
        `${INDENT}Ohne sie startet KEINE Instanz, auch keine mit Autostart –`,
        `${INDENT}und der Start schreibt dazu nichts ins Log.`,
      ];
    case "unreadable":
      return [
        "settings.json    UNLESBAR    Vorhanden, aber nicht lesbar (Rechte? Volume?).",
        `${INDENT}Grund: ${verdict.reason}`,
        `${INDENT}Ohne sie startet KEINE Instanz.`,
      ];
    case "rejected":
      return [
        `settings.json    ABGELEHNT   ${REJECTION_HEADLINE[verdict.cause]}`,
        `${INDENT}Grund: ${verdict.reason}`,
        `${INDENT}Die Datei bleibt liegen, gilt aber als unkonfiguriert:`,
        `${INDENT}es startet KEINE Instanz.`,
      ];
  }
}

export function formatDataCheck(check: DataCheck): string {
  return [
    "ferrion-gateway – Datenprüfung vor dem Update",
    `Verzeichnis: ${check.dataDir}`,
    "",
    ...describeInstances(check.instances.verdict, check.instances.summary),
    ...describeSettings(check.settings),
    "",
    hasFinding(check)
      ? "Ergebnis: BEFUND. Vor dem Umschalten klären – siehe docs/deployment.md."
      : "Ergebnis: Dieser Datenstand lädt unter der neuen Version unverändert.",
  ].join("\n");
}
