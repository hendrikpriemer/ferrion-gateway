import type { ReadingInput } from "../ferrion-client/types.js";

export interface ReadingBufferOptions {
  // Caps total buffered readings so a persistently failing push doesn't
  // grow memory without bound - oldest readings are dropped first.
  maxSize?: number;
  // Fired with the reading that got dropped when `add()` evicts the oldest
  // entry to stay under maxSize - previously silent data loss during a
  // long-enough outage. A callback, not a direct Logger dependency, so
  // this file stays pure/dependency-free and easy to unit test; the caller
  // (ReadingLoop) wires it to its own logger.
  onEvict?: (reading: ReadingInput) => void;
}

const DEFAULT_MAX_SIZE = 1000;

function keyOf(reading: ReadingInput): string {
  return `${reading.dataSourceId}|${reading.timestamp}`;
}

// Accumulates readings between push ticks, deduplicating on
// (dataSourceId, timestamp) - the same key ferrion's own `skipDuplicates`
// uses server-side - so a retried discovery/read tick never grows the
// buffer with the same instant twice.
export class ReadingBuffer {
  private readonly maxSize: number;
  private readonly onEvict: ((reading: ReadingInput) => void) | undefined;
  private readonly entries = new Map<string, ReadingInput>();

  constructor(options: ReadingBufferOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  // Non-destructive snapshot of everything currently buffered, in
  // insertion order - unlike drain(), doesn't remove anything. Used to
  // persist the buffer to disk (see ReadingBufferStore) without disturbing
  // it.
  toArray(): ReadingInput[] {
    return [...this.entries.values()];
  }

  add(reading: ReadingInput): void {
    const key = keyOf(reading);
    if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        if (evicted) this.onEvict?.(evicted);
      }
    }
    this.entries.set(key, reading);
  }

  // Removes and returns up to `limit` buffered readings, oldest first.
  drain(limit: number = this.maxSize): ReadingInput[] {
    const drained: ReadingInput[] = [];
    for (const [key, reading] of this.entries) {
      if (drained.length >= limit) break;
      drained.push(reading);
      this.entries.delete(key);
    }
    return drained;
  }

  // Puts readings back after a failed push, ahead of anything collected in
  // the meantime, so a retry doesn't reorder behind newer readings.
  requeue(readings: ReadingInput[]): void {
    const rest = [...this.entries.entries()];
    this.entries.clear();
    for (const reading of readings) {
      this.entries.set(keyOf(reading), reading);
    }
    for (const [key, reading] of rest) {
      if (!this.entries.has(key)) {
        this.entries.set(key, reading);
      }
    }
  }
}
