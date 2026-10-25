import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { z } from "zod";
import {
  aggregationStrategySchema,
  deviceSchema,
  portsSchema,
  type AggregationStrategy,
  type DeviceTemplateId,
  type Ports,
} from "../config/schema.js";
import { readJsonFile, writeJsonFileAtomic, type ReadJsonResult } from "../util/json-file.js";
import { zodReason } from "../util/zod-reason.js";

// A sparse subset of pollingSchema - only the fields the Web UI's
// "Erweitert" section exposes (see routes.ts's toInstanceConfig()). Absent
// fields fall back to pollingSchema's own defaults, same as an instance
// created before this existed.
export interface PollingOverrides {
  readingIntervalMs?: number;
  readingsPushIntervalMs?: number;
  aggregation?: AggregationStrategy;
}

// A sparse subset of resilienceSchema - only ever set today via the
// dedicated bridge-settings route (see routes.ts's PUT
// /api/instances/:id/bridge-settings), since the Web UI's "Erweitert"
// section for simulated instances doesn't expose these. Absent fields
// fall back to resilienceSchema's own defaults, same as PollingOverrides.
export interface ResilienceOverrides {
  httpRequestTimeoutMs?: number;
  readingBufferMaxSize?: number;
}

export interface InstanceRecord {
  id: string;
  instanceName: string;
  // Absent for a bridge-only instance - one with no locally-simulated
  // device, that only bridges real hardware whose connection details
  // come entirely from ferrion's own data-source config (see
  // config/schema.ts's instanceConfigSchema.device doc comment).
  device?: { templateId: DeviceTemplateId; serialNumber: string };
  ports: Ports;
  polling?: PollingOverrides;
  resilience?: ResilienceOverrides;
  // Whether this instance was intentionally running the last time anyone
  // called /start or /stop on it (see routes.ts) - distinct from
  // ProcessManager's own "is it currently running" state, which is
  // runtime-only and always starts every instance as "stopped" after a
  // control-plane restart/redeploy. Read once at boot
  // (routes.ts's resumeAutoStartInstances()) to resume whatever was
  // actually running before, instead of leaving it idle until someone
  // notices and clicks Start again.
  autoStart?: boolean;
  createdAt: string;
}

export type CreateInstanceInput = Omit<InstanceRecord, "id" | "createdAt">;
export type UpdateInstanceInput = Omit<InstanceRecord, "id" | "createdAt">;

// Shape of one persisted record - loose where the runtime is loose (the
// polling/resilience overrides are sparse subsets, see above), strict on
// the fields every route dereferences without a check.
const storedRecordSchema = z.object({
  id: z.string().min(1),
  instanceName: z.string().min(1),
  device: deviceSchema.optional(),
  ports: portsSchema,
  polling: z
    .object({
      readingIntervalMs: z.number().int().positive().optional(),
      readingsPushIntervalMs: z.number().int().positive().optional(),
      aggregation: aggregationStrategySchema.optional(),
    })
    .optional(),
  resilience: z
    .object({
      httpRequestTimeoutMs: z.number().int().positive().optional(),
      readingBufferMaxSize: z.number().int().positive().optional(),
    })
    .optional(),
  autoStart: z.boolean().optional(),
  createdAt: z.string().min(1),
});
const storedRecordsSchema = z.array(storedRecordSchema);

// What loading an instances.json amounts to, decided without touching the
// file system. Split out of the store so the pre-deploy check
// (scripts/check-data.ts, see docs/deployment.md) can ask "would this file
// still load after the upgrade?" through the very rules the boot path
// applies, instead of a second copy of them that drifts from this one the
// first time a field is added. The store keeps the side effects -
// quarantining the file, logging - and this decides only the verdict.
export type InstanceFileVerdict =
  | { kind: "records"; records: InstanceRecord[] }
  | { kind: "absent" }
  | { kind: "unreadable"; error: unknown }
  // `cause` separates "the bytes are not JSON" from "the JSON is not a
  // record list". The store treats both the same way, but they point an
  // operator at opposite things - a truncated write or a full disk versus a
  // field this version no longer accepts - so anything that *reports* the
  // verdict has to be able to tell them apart.
  | { kind: "rejected"; cause: "json" | "schema"; reason: string };

export function judgeInstanceFile(read: ReadJsonResult): InstanceFileVerdict {
  switch (read.kind) {
    case "missing":
    case "empty":
      return { kind: "absent" };
    case "unreadable":
      return { kind: "unreadable", error: read.error };
    case "invalid-json":
      return { kind: "rejected", cause: "json", reason: "not valid JSON" };
    case "ok": {
      const result = storedRecordsSchema.safeParse(read.json);
      return result.success
        ? { kind: "records", records: result.data }
        : { kind: "rejected", cause: "schema", reason: zodReason(result.error) };
    }
  }
}

// Reads/writes data/instances.json (gitignored) - replaces manually
// hand-editing config files as the primary workflow (see the plan). The
// ferrion connection (base URL + API key) lives separately in
// settings-store.ts, entered once rather than per instance. Writes go
// through util/json-file.ts's temp-file + rename so a crash mid-write
// can't corrupt the store.
export class InstanceStore {
  private readonly filePath: string;
  private records: InstanceRecord[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.records = this.load();
  }

  // A file that is present but not an array of records (a hand edit that
  // left `{}`, a truncated write on a full disk) used to load as-is and
  // crash the control plane on the first `[...records]` - a boot loop with
  // no way in (review 2026-09, N-3). Now: the broken file is moved aside
  // (never silently overwritten by the next persist(), so the operator's
  // edits survive to be repaired) and the store starts empty.
  private load(): InstanceRecord[] {
    const verdict = judgeInstanceFile(readJsonFile(this.filePath));
    switch (verdict.kind) {
      case "absent":
        return [];
      case "unreadable":
        console.error(`[instance-store] could not read ${this.filePath}, starting empty`, verdict.error);
        return [];
      case "rejected":
        this.quarantine(verdict.reason);
        return [];
      case "records":
        return verdict.records;
    }
  }

  private quarantine(reason: string): void {
    const asidePath = `${this.filePath}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(this.filePath, asidePath);
    } catch {
      // Nothing more to do than to say so; the next persist() rewrites it.
    }
    console.error(`[instance-store] ${this.filePath} was ${reason} - moved to ${asidePath}, starting empty`);
  }

  private persist(): void {
    // 0600 for consistency with settings-store: instances.json holds no
    // secret, but it does hold the sensor topology (asset ids, protocols,
    // hosts, ports), and there is no reason for it to be world-readable when
    // its sibling is not.
    writeJsonFileAtomic(this.filePath, this.records, { pretty: true });
  }

  list(): InstanceRecord[] {
    return [...this.records];
  }

  get(id: string): InstanceRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  create(input: CreateInstanceInput): InstanceRecord {
    const record: InstanceRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.records.push(record);
    this.persist();
    return record;
  }

  // The one read-merge-write every mutation below is: undefined when the
  // id is unknown, the persisted record otherwise.
  private patch(id: string, partial: Partial<Omit<InstanceRecord, "id" | "createdAt">>): InstanceRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updated: InstanceRecord = { ...existing, ...partial };
    this.records = this.records.map((record) => (record.id === id ? updated : record));
    this.persist();
    return updated;
  }

  update(id: string, input: UpdateInstanceInput): InstanceRecord | undefined {
    return this.patch(id, input);
  }

  // Narrower than update(): only ever called from the /start and /stop
  // handlers (see routes.ts), which don't otherwise touch the rest of a
  // record's fields and shouldn't need to round-trip them just to flip
  // this one flag.
  setAutoStart(id: string, autoStart: boolean): InstanceRecord | undefined {
    return this.patch(id, { autoStart });
  }

  // Narrower than update(): only ever called from the bridge-settings
  // route (see routes.ts's PUT /api/instances/:id/bridge-settings), which
  // only ever touches these two fields - same reasoning as
  // setAutoStart() above.
  updateSettings(
    id: string,
    settings: { polling?: PollingOverrides; resilience?: ResilienceOverrides },
  ): InstanceRecord | undefined {
    return this.patch(id, settings);
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }
}
