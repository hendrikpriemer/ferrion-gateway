// Deduplicates concurrent async attempts: at a fast readIntervalMs (down to
// 1ms), reading-loop.ts's setInterval can fire dozens/hundreds of overlapping
// calls before a single slow attempt (real network I/O) settles. Without
// this, every one of those callers awaits its own independent operation
// (see the connection-race bug fixed by memoizing a single in-flight
// promise) - fixed that, but a *rejecting* shared promise still meant every
// concurrent caller got its own copy of the same rejection, so a single
// real failure was logged once per overlapping tick instead of once per
// actual attempt.
//
// Only the call that actually triggered the attempt (the "originator") sees
// its real outcome, including a rejection. Every call that piggybacks on an
// already-in-flight attempt gets the resolved value on success, or
// `undefined` (not a thrown error) if it failed - functionally identical to
// "no value this cycle" for the DataSourceReader.read() contract these
// protocol clients implement, without re-reporting a failure that's already
// being reported once by the originator.
export class SingleFlight<T> {
  private inFlight: Promise<T> | undefined;

  async run(fn: () => Promise<T>): Promise<T | undefined> {
    const isOriginator = !this.inFlight;
    if (isOriginator) {
      this.inFlight = fn().finally(() => {
        this.inFlight = undefined;
      });
    }
    const promise = this.inFlight as Promise<T>;
    if (isOriginator) {
      return promise;
    }
    return promise.catch(() => undefined);
  }
}
