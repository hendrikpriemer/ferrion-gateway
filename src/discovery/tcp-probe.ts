import net from "node:net";

// The sweep half of the discovery (R07, stage 2): which address:port pairs
// accept a TCP connection at all. A plain connect, closed straight away -
// no OPC UA byte is sent, so a device that is not an OPC UA server sees
// nothing but a short-lived connection.

/** Per probe. A device on the local network answers in milliseconds; 500 ms covers a routed site. */
export const PROBE_TIMEOUT_MS = 500;
/**
 * Per probe in the second pass, for targets that stayed silent in the first.
 * Found on the production VM (ferrion#961): two searches of the same /24 a
 * few minutes apart found 14 and 23 open ports - the first contact to a
 * device can outlast 500 ms (address resolution on the way, a slow embedded
 * stack), and there was no second try. By the second pass the address is
 * resolved, so a device that is there answers at once.
 */
// 750 ms rather than more: a /22 on one port must still fit the 120 s cap
// with both passes and time left to identify (ferrion plans the budget
// with the same figures, device-discovery-actions.ts).
export const PROBE_RETRY_TIMEOUT_MS = 750;
/** Probes at once: 16 x 1 / 0.5 s = at most about 32 connection attempts per second. */
export const PROBE_CONCURRENCY = 16;

/**
 * "open": the port accepted the connection. "closed": something answered -
 * a refusal, or an error that came back - so asking again would not help.
 * "silent": no answer within the timeout, worth a second try.
 */
export type ProbeOutcome = "open" | "closed" | "silent";

export type ProbeFn = (host: string, port: number, timeoutMs: number) => Promise<ProbeOutcome>;

export const probeTcp: ProbeFn = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("silent"), timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("error", () => finish("closed"));
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
