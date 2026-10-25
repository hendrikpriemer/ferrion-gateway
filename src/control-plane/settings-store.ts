import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { readJsonFile, writeJsonFileAtomic, type ReadJsonResult } from "../util/json-file.js";
import { zodReason } from "../util/zod-reason.js";

export interface FerrionSettings {
  baseUrl: string;
  apiKey: string;
  rejectUnauthorized: boolean;
}

// What a settings.json must look like to count as "configured" - a
// hand-edited file missing the apiKey used to load fine and then send
// `Bearer undefined` on every request (review 2026-09, N-3). Shape only;
// the URL rules live with the PUT route that writes the file.
const storedSettingsSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  rejectUnauthorized: z.boolean().default(true),
});

// Same split as instance-store.ts's judgeInstanceFile: the verdict is a
// pure function so the pre-deploy check can apply the boot path's own
// rules to a file without starting anything. This one matters more than it
// looks - an unconfigured connection means resumeAutoStartInstances()
// returns immediately and *no* instance starts, which is a quieter and
// worse failure than a missing instance list.
export type SettingsFileVerdict =
  | { kind: "settings"; settings: FerrionSettings }
  | { kind: "absent" }
  | { kind: "unreadable"; error: unknown }
  | { kind: "rejected"; cause: "json" | "schema"; reason: string };

export function judgeSettingsFile(read: ReadJsonResult): SettingsFileVerdict {
  switch (read.kind) {
    case "missing":
    case "empty":
      return { kind: "absent" };
    case "unreadable":
      return { kind: "unreadable", error: read.error };
    case "invalid-json":
      return { kind: "rejected", cause: "json", reason: "not valid JSON" };
    case "ok": {
      const result = storedSettingsSchema.safeParse(read.json);
      // zodReason, never error.message: this string reaches a log line, and
      // zod 4's own message is a multi-line JSON dump. It also never carries
      // the parsed value, which matters here more than anywhere else - the
      // file holds the ferrion API key in plaintext.
      return result.success
        ? { kind: "settings", settings: result.data }
        : { kind: "rejected", cause: "schema", reason: zodReason(result.error) };
    }
  }
}

// The ferrion connection (base URL + API key) entered once here, not
// re-typed per instance - see the plan's separation of "one-time base
// setup" from "adding a simulated sensor". Same gitignored-JSON,
// temp-file-then-rename persistence (util/json-file.ts) as instance-store.ts.
export class SettingsStore {
  private readonly filePath: string;
  private settings: FerrionSettings | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.settings = this.load();
  }

  private load(): FerrionSettings | undefined {
    const verdict = judgeSettingsFile(readJsonFile(this.filePath));
    switch (verdict.kind) {
      case "absent":
        return undefined;
      case "unreadable":
        console.error(`[settings-store] could not read ${this.filePath}, treating as unconfigured`, verdict.error);
        return undefined;
      case "rejected":
        console.error(`[settings-store] ${this.filePath} is unusable, treating as unconfigured: ${verdict.reason}`);
        return undefined;
      case "settings":
        return verdict.settings;
    }
  }

  get(): FerrionSettings | undefined {
    return this.settings;
  }

  save(settings: FerrionSettings): void {
    this.settings = settings;
    // mode 0o600 (json-file.ts's default): this file holds the ferrion API
    // key in plaintext - no reason for any other local user/process to be
    // able to read it. A no-op on Windows (dev only; the real deployment
    // target is the Linux container - see Dockerfile), harmless either way.
    writeJsonFileAtomic(this.filePath, settings, { pretty: true });
  }

  // Does not affect instances already running with this config snapshot -
  // only new starts, which the routes.ts guard already blocks without a
  // configured connection.
  clear(): boolean {
    const had = this.settings !== undefined;
    this.settings = undefined;
    if (existsSync(this.filePath)) {
      rmSync(this.filePath);
    }
    return had;
  }
}
