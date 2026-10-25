import { describe, expect, it, vi } from "vitest";
import { ReadingBuffer } from "./reading-buffer.js";

function reading(dataSourceId: string, timestamp: string, value: number) {
  return { dataSourceId, timestamp, value };
}

describe("ReadingBuffer", () => {
  it("adds and drains readings in insertion order", () => {
    const buffer = new ReadingBuffer();
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:05.000Z", 2));
    expect(buffer.size).toBe(2);

    const drained = buffer.drain();
    expect(drained).toEqual([reading("d1", "2026-08-14T12:00:00.000Z", 1), reading("d1", "2026-08-14T12:00:05.000Z", 2)]);
    expect(buffer.size).toBe(0);
  });

  it("deduplicates on (dataSourceId, timestamp), keeping the latest value", () => {
    const buffer = new ReadingBuffer();
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 999));
    expect(buffer.size).toBe(1);
    expect(buffer.drain()).toEqual([reading("d1", "2026-08-14T12:00:00.000Z", 999)]);
  });

  it("drains at most `limit` readings, leaving the rest buffered", () => {
    const buffer = new ReadingBuffer();
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:01.000Z", 2));
    buffer.add(reading("d1", "2026-08-14T12:00:02.000Z", 3));

    const drained = buffer.drain(2);
    expect(drained).toHaveLength(2);
    expect(buffer.size).toBe(1);
  });

  it("drops the oldest entry once maxSize is exceeded", () => {
    const buffer = new ReadingBuffer({ maxSize: 2 });
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:01.000Z", 2));
    buffer.add(reading("d1", "2026-08-14T12:00:02.000Z", 3));

    expect(buffer.size).toBe(2);
    const drained = buffer.drain();
    expect(drained.map((r) => r.value)).toEqual([2, 3]);
  });

  it("requeue puts failed readings back ahead of newer ones collected meanwhile", () => {
    const buffer = new ReadingBuffer();
    const failed = [reading("d1", "2026-08-14T12:00:00.000Z", 1), reading("d1", "2026-08-14T12:00:01.000Z", 2)];
    buffer.add(reading("d1", "2026-08-14T12:00:02.000Z", 3));

    buffer.requeue(failed);

    expect(buffer.drain().map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it("requeue does not duplicate a reading that was re-collected while it was in flight", () => {
    const buffer = new ReadingBuffer();
    const failed = [reading("d1", "2026-08-14T12:00:00.000Z", 1)];
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));

    buffer.requeue(failed);

    expect(buffer.size).toBe(1);
  });

  it("invokes onEvict with the oldest evicted reading when maxSize is exceeded", () => {
    const onEvict = vi.fn();
    const buffer = new ReadingBuffer({ maxSize: 2, onEvict });
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:01.000Z", 2));

    buffer.add(reading("d1", "2026-08-14T12:00:02.000Z", 3));

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith(reading("d1", "2026-08-14T12:00:00.000Z", 1));
  });

  it("does not invoke onEvict while under maxSize", () => {
    const onEvict = vi.fn();
    const buffer = new ReadingBuffer({ maxSize: 2, onEvict });

    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));

    expect(onEvict).not.toHaveBeenCalled();
  });

  it("toArray returns a non-destructive snapshot of everything currently buffered", () => {
    const buffer = new ReadingBuffer();
    buffer.add(reading("d1", "2026-08-14T12:00:00.000Z", 1));
    buffer.add(reading("d1", "2026-08-14T12:00:01.000Z", 2));

    expect(buffer.toArray()).toEqual([
      reading("d1", "2026-08-14T12:00:00.000Z", 1),
      reading("d1", "2026-08-14T12:00:01.000Z", 2),
    ]);
    expect(buffer.size).toBe(2);
  });
});
