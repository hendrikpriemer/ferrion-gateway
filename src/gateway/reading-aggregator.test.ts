import { describe, expect, it } from "vitest";
import { ReadingAggregator } from "./reading-aggregator.js";

describe("ReadingAggregator", () => {
  it("defaults to the last recorded value per data source", () => {
    const aggregator = new ReadingAggregator();
    aggregator.record("d1", 1, "2026-08-16T12:00:00.000Z");
    aggregator.record("d1", 2, "2026-08-16T12:00:00.001Z");
    aggregator.record("d1", 3, "2026-08-16T12:00:00.002Z");

    expect(aggregator.flush()).toEqual([{ dataSourceId: "d1", timestamp: "2026-08-16T12:00:00.002Z", value: 3 }]);
  });

  it("computes avg/min/max over everything recorded since the last flush", () => {
    for (const [strategy, expected] of [
      ["avg", 2],
      ["min", 1],
      ["max", 3],
    ] as const) {
      const aggregator = new ReadingAggregator({ strategy });
      aggregator.record("d1", 1, "2026-08-16T12:00:00.000Z");
      aggregator.record("d1", 2, "2026-08-16T12:00:00.001Z");
      aggregator.record("d1", 3, "2026-08-16T12:00:00.002Z");

      expect(aggregator.flush()).toEqual([{ dataSourceId: "d1", timestamp: "2026-08-16T12:00:00.002Z", value: expected }]);
    }
  });

  it("emits one reading per data source that received a sample", () => {
    const aggregator = new ReadingAggregator();
    aggregator.record("d1", 1, "2026-08-16T12:00:00.000Z");
    aggregator.record("d2", 10, "2026-08-16T12:00:00.000Z");

    const flushed = aggregator.flush();
    expect(flushed).toHaveLength(2);
    expect(flushed.map((r) => r.dataSourceId).sort()).toEqual(["d1", "d2"]);
  });

  it("clears state after flush, so a data source with no new samples is omitted next time", () => {
    const aggregator = new ReadingAggregator();
    aggregator.record("d1", 1, "2026-08-16T12:00:00.000Z");
    aggregator.flush();

    expect(aggregator.flush()).toEqual([]);
  });

  it("returns nothing when no samples were ever recorded", () => {
    const aggregator = new ReadingAggregator();
    expect(aggregator.flush()).toEqual([]);
  });
});
