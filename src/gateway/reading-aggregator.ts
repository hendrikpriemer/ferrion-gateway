import type { AggregationStrategy } from "../config/schema.js";
import type { ReadingInput } from "../ferrion-client/types.js";

export interface ReadingAggregatorOptions {
  strategy?: AggregationStrategy;
}

interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  lastTimestamp: string;
}

// Sits between fast, per-protocol reads (down to a 1ms readIntervalMs) and the
// ReadingBuffer's outage-safe push queue: readOnce() feeds every raw sample into
// record(), and runPush() calls flush() right before draining the buffer, so read
// frequency never inflates what actually gets queued/pushed to ferrion - exactly
// one ReadingInput per data source that saw at least one sample since the last
// flush, regardless of how many reads happened in between.
export class ReadingAggregator {
  private readonly strategy: AggregationStrategy;
  private readonly accumulators = new Map<string, Accumulator>();

  constructor(options: ReadingAggregatorOptions = {}) {
    this.strategy = options.strategy ?? "last";
  }

  record(dataSourceId: string, value: number, timestamp: string): void {
    const existing = this.accumulators.get(dataSourceId);
    if (!existing) {
      this.accumulators.set(dataSourceId, {
        count: 1,
        sum: value,
        min: value,
        max: value,
        last: value,
        lastTimestamp: timestamp,
      });
      return;
    }
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.last = value;
    existing.lastTimestamp = timestamp;
  }

  flush(): ReadingInput[] {
    const readings: ReadingInput[] = [];
    for (const [dataSourceId, acc] of this.accumulators) {
      readings.push({ dataSourceId, timestamp: acc.lastTimestamp, value: this.resolve(acc) });
    }
    this.accumulators.clear();
    return readings;
  }

  private resolve(acc: Accumulator): number {
    switch (this.strategy) {
      case "avg":
        return acc.sum / acc.count;
      case "min":
        return acc.min;
      case "max":
        return acc.max;
      default:
        return acc.last;
    }
  }
}
