import type { ReadingInput } from "../ferrion-client/types.js";
import { readJsonFile, writeJsonFileAtomic } from "../util/json-file.js";

// The buffer file is named after the instance, and an instance name is
// whatever the operator typed (or a fleet config lists) - "../../etc/x"
// included. Anything that is not a plain file-name character becomes "_",
// so the file always lands inside the reading-buffers directory (review
// 2026-09, M-12).
export function bufferFileNameFor(instanceName: string): string {
  const safe = instanceName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64);
  return `${safe || "instance"}.json`;
}

// Persists the ReadingBuffer's contents across a gateway process restart -
// without this, a buffer that had genuinely bridged a ferrion outage (see
// ReadingBuffer's own dedup/requeue behavior) still loses everything the
// moment the process itself restarts (crash, redeploy, host reboot), since
// the buffer is otherwise in-memory only. Same util/json-file.ts
// convention as the control-plane stores (sync fs, temp-file then rename
// so a crash mid-write can't corrupt the file, 0600/0700 like
// instances.json and settings.json per pentest L-2, empty/missing file
// treated as "nothing buffered yet" rather than an error) - `data/` is
// already a Docker-volume-mounted directory (see docker-compose.yml), so
// this fits the existing deployment story without any infra changes.
export class ReadingBufferStore {
  constructor(private readonly filePath: string) {}

  load(): ReadingInput[] {
    const read = readJsonFile(this.filePath);
    return read.kind === "ok" && Array.isArray(read.json) ? (read.json as ReadingInput[]) : [];
  }

  save(readings: ReadingInput[]): void {
    writeJsonFileAtomic(this.filePath, readings);
  }
}
