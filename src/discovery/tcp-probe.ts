import net from "node:net";

// The sweep half of the discovery (R07, stage 2): which address:port pairs
// accept a TCP connection at all. A plain connect, closed straight away -
// no OPC UA byte is sent, so a device that is not an OPC UA server sees
// nothing but a short-lived connection.

/** Per probe. A device on the local network answers in milliseconds; 500 ms covers a routed site. */
export const PROBE_TIMEOUT_MS = 500;
/** Probes at once: 16 x 1 / 0.5 s = at most about 32 connection attempts per second. */
export const PROBE_CONCURRENCY = 16;

export type ProbeFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const probeTcp: ProbeFn = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

/**
 * Runs `work` over `items` with at most `concurrency` at once, and starts no
 * new item once `deadline` (epoch ms) has passed. Says how many it started,
 * so the caller can tell a finished run from one cut short by the budget.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  deadline: number,
  work: (item: T) => Promise<void>,
  now: () => number = Date.now,
): Promise<{ started: number }> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && now() < deadline) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return { started: next };
}
