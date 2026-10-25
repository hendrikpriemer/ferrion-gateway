import { describe, expect, it, vi } from "vitest";
import { SerialQueue } from "./serial-queue.js";

describe("SerialQueue", () => {
  it("runs a single task and returns its resolved value", async () => {
    const queue = new SerialQueue();
    const fn = vi.fn().mockResolvedValue(42);
    await expect(queue.run(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs concurrently-queued tasks one at a time, in order, each getting its own result", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run(async () => {
      order.push(1);
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      return "first";
    });
    const second = queue.run(async () => {
      order.push(2);
      return "second";
    });

    // Let the microtask queue drain enough for the first task's own
    // synchronous prefix to run - run() schedules via .then(), so even the
    // *first* task doesn't execute synchronously within this test body.
    await Promise.resolve();
    await Promise.resolve();

    // The second task must not have started yet - it's queued behind the
    // still-in-flight first one.
    expect(order).toEqual([1]);

    releaseFirst!();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual([1, 2]);
  });

  it("a rejected task doesn't stall tasks queued after it", async () => {
    const queue = new SerialQueue();
    const failing = queue.run(() => Promise.reject(new Error("boom")));
    const next = queue.run(() => Promise.resolve("still runs"));

    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("still runs");
  });
});
