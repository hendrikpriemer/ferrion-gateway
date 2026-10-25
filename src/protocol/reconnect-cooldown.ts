export interface ReconnectCooldownOptions {
  cooldownMs?: number;
  now?: () => number;
}

const DEFAULT_COOLDOWN_MS = 3000;

// Shared by OpcuaGatewayClient and ModbusGatewayClient: after a connection
// failure, don't let a fast readIntervalMs (down to 1ms) turn a genuinely
// unreachable device into thousands of reconnect attempts per second. A
// failed canAttempt() is not itself an error - callers treat it as "no value
// this cycle" (see DataSourceReader.read()'s undefined-means-no-value
// contract), so the caller keeps retrying on its own schedule without this
// needing anything smarter than a fixed cooldown.
export class ReconnectCooldown {
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private nextAttemptAt = 0;

  constructor(options: ReconnectCooldownOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  canAttempt(): boolean {
    return this.now() >= this.nextAttemptAt;
  }

  recordFailure(): void {
    this.nextAttemptAt = this.now() + this.cooldownMs;
  }

  reset(): void {
    this.nextAttemptAt = 0;
  }
}
