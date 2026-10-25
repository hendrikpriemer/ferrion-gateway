// Serializes async operations: each run() call waits for every earlier one
// to finish before starting, and gets its own genuine result - unlike
// SingleFlight, which coalesces concurrent callers into one shared outcome.
// Needed wherever a single physical connection can't safely have two
// operations in flight at once (see modbus/gateway-client.ts: modbus-serial
// doesn't pipeline requests over one TCP connection, so two concurrent
// metric reads sharing one connection could otherwise have their responses
// mismatched to the wrong request). `tail` never itself rejects - a failed
// task must not stall every task queued after it, only report failure to
// its own caller.
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const started = this.tail.then(fn, fn);
    this.tail = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
