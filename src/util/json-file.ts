import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// The one JSON-file convention the three stores (instances, settings,
// reading buffers) used to each carry a copy of (review 2026-09, N-23):
// synchronous fs, temp file then rename so a crash mid-write cannot leave
// a half-written file, restrictive modes because every one of them holds
// something another local user has no business reading.

export type ReadJsonResult =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "invalid-json" }
  | { kind: "ok"; json: unknown };

export function readJsonFile(filePath: string): ReadJsonResult {
  if (!existsSync(filePath)) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (error) {
    return { kind: "unreadable", error };
  }
  if (!raw) return { kind: "empty" };
  try {
    return { kind: "ok", json: JSON.parse(raw) };
  } catch {
    return { kind: "invalid-json" };
  }
}

export interface WriteJsonOptions {
  // 0o600 by default: none of these files is for anyone but this process.
  mode?: number;
  dirMode?: number;
  pretty?: boolean;
}

export function writeJsonFileAtomic(filePath: string, value: unknown, options: WriteJsonOptions = {}): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: options.dirMode ?? 0o700 });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), {
    mode: options.mode ?? 0o600,
  });
  renameSync(tempPath, filePath);
}
