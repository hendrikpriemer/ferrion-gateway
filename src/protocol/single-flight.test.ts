import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "./single-flight.js";

describe("SingleFlight", () => {
  it("runs fn once for a single call and returns its resolved value", async () => {
    const gate = new SingleFlight<number>();
    const fn = vi.fn().mockResolvedValue(42);
    await expect(gate.run(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("piggybacks concurrent calls onto the same in-flight attempt instead of starting a new one", async () => {
    const gate = new SingleFlight<number>();
    let resolveFn: (value: number) => void;
    const fn = vi.fn().mockImplementation(() => new Promise<number>((resolve) => (resolveFn = resolve)));

    const first = gate.run(fn);
    const second = gate.run(fn);
    const third = gate.run(fn);
    resolveFn!(7);

    await expect(Promise.all([first, second, third])).resolves.toEqual([7, 7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("only the originator's promise rejects - piggybacking calls resolve to undefined instead", async () => {
    const gate = new SingleFlight<number>();
    let rejectFn: (error: Error) => void;
    const fn = vi.fn().mockImplementation(() => new Promise<number>((_resolve, reject) => (rejectFn = reject)));

    const originator = gate.run(fn);
    const piggyback1 = gate.run(fn);
    const piggyback2 = gate.run(fn);
    rejectFn!(new Error("connect failed"));

    await expect(originator).rejects.toThrow("connect failed");
    await expect(piggyback1).resolves.toBeUndefined();
    await expect(piggyback2).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh attempt once the previous one has settled", async () => {
    const gate = new SingleFlight<number>();
    const fn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(gate.run(fn)).resolves.toBe(1);
    await expect(gate.run(fn)).resolves.toBe(2);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
