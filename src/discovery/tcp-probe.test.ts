import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeTcp, runPool } from "./tcp-probe.js";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("probeTcp", () => {
  it("sees an open port", async () => {
    expect(await probeTcp("127.0.0.1", await listen(), 500)).toBe(true);
  });

  it("sees a refused port as closed", async () => {
    expect(await probeTcp("127.0.0.1", await closedPort(), 500)).toBe(false);
  });

  it("gives up after the timeout on an address that never answers", async () => {
    // TEST-NET-1 (RFC 5737) is never routed, so the connect hangs.
    const started = Date.now();
    expect(await probeTcp("192.0.2.1", 4840, 100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("runPool", () => {
  it("runs every item, never more than the concurrency at once", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6, 7], 3, Number.POSITIVE_INFINITY, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(item);
      running -= 1;
    });

    expect(result.started).toBe(7);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it("starts nothing new once the deadline has passed", async () => {
    let clock = 0;
    const done: number[] = [];
    const result = await runPool(
      [1, 2, 3, 4, 5],
      1,
      2,
      async (item) => {
        clock += 1;
        done.push(item);
      },
      () => clock,
    );

    expect(done).toEqual([1, 2]);
    expect(result.started).toBe(2);
  });

  it("does nothing for no items", async () => {
    expect(await runPool([], 16, Number.POSITIVE_INFINITY, async () => {})).toEqual({ started: 0 });
  });
});
