import type { GatewayApi } from "../ferrion-client/gateway-api.js";
import type { CommandPayload, CommandResultInput, CommandType, GatewayCommand } from "../ferrion-client/types.js";
import type { Logger } from "../logging/logger.js";
import { errorMessage } from "../util/error-message.js";
import { handleDiscoverDevices } from "../discovery/handle-discover-devices.js";
import { readDiscoveryLimit, type DiscoveryLimit } from "../discovery/scan-request.js";
import { handleCommand as defaultHandleCommand } from "./command-handlers.js";

export type HandleCommandFn = (type: CommandType, payload: CommandPayload) => Promise<CommandResultInput>;

export type HandleDiscoveryFn = (payload: unknown) => Promise<CommandResultInput>;

export interface CommandLoopOptions {
  intervalMs?: number;
  logger?: Logger;
  handleCommand?: HandleCommandFn;
  // Defaults to the real scan within FG_DISCOVERY_ALLOWED_CIDRS.
  handleDiscovery?: HandleDiscoveryFn;
  discoveryLimit?: DiscoveryLimit;
}

const DEFAULT_INTERVAL_MS = 3000;

// Polls for pending commands and guarantees a result is posted for every
// one it picks up (try/catch around the handler, try/catch around the
// result POST). Since R07 ferrion closes a command without a result after
// its deadline, but only as a timeout - the real outcome is still lost.
export class CommandLoop {
  private readonly api: GatewayApi;
  private readonly intervalMs: number;
  private readonly logger: Logger | undefined;
  private readonly handleCommand: HandleCommandFn;
  private readonly handleDiscovery: HandleDiscoveryFn;
  // The scan running beside the loop, if any (R07): at most one per process.
  // A gateway's instances share one key, so another instance may take the
  // next DISCOVER_DEVICES; ferrion throttles per gateway for that.
  private scan: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(api: GatewayApi, options: CommandLoopOptions = {}) {
    this.api = api;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger;
    this.handleCommand = options.handleCommand ?? defaultHandleCommand;
    const limit = options.discoveryLimit ?? readDiscoveryLimit();
    this.handleDiscovery = options.handleDiscovery ?? ((payload) => handleDiscoverDevices(payload, limit));
  }

  /** Resolves once no scan is running - for tests and an orderly shutdown. */
  async scanSettled(): Promise<void> {
    await this.scan;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext(this.intervalMs));
    }, delayMs);
  }

  async tick(): Promise<void> {
    let commands: GatewayCommand[];
    try {
      commands = await this.api.fetchCommands();
    } catch (error) {
      this.logger?.error({ err: error }, "Failed to fetch gateway commands");
      return;
    }

    for (const command of commands) {
      if (command.type === "DISCOVER_DEVICES") {
        // Beside the loop, not in it: a scan takes up to its budget, and a
        // connection test arriving meanwhile must not wait for it.
        if (this.scan) {
          await this.postResult(command.id, { status: "FAILED", result: { error: "scan already running" } });
        } else {
          this.scan = this.runScan(command.id, command.payload).finally(() => {
            this.scan = undefined;
          });
        }
        continue;
      }
      let result: CommandResultInput;
      try {
        result = await this.handleCommand(command.type, command.payload);
      } catch (error) {
        result = { status: "FAILED", result: { error: errorMessage(error) } };
      }
      await this.postResult(command.id, result);
    }
  }

  private async runScan(commandId: string, payload: unknown): Promise<void> {
    this.logger?.info({ commandId }, "Device discovery started");
    let result: CommandResultInput;
    try {
      result = await this.handleDiscovery(payload);
    } catch (error) {
      result = { status: "FAILED", result: { error: errorMessage(error) } };
    }
    const outcome = result.result as { error?: string; scan?: unknown; candidates?: unknown[] } | undefined;
    this.logger?.info(
      { commandId, status: result.status, error: outcome?.error, candidates: outcome?.candidates?.length, scan: outcome?.scan },
      "Device discovery finished",
    );
    await this.postResult(commandId, result);
  }

  // Never throws: a lost result is logged, and ferrion's deadline closes
  // the command (R07, stage 1).
  private async postResult(commandId: string, result: CommandResultInput): Promise<void> {
    try {
      await this.api.postCommandResult(commandId, result);
    } catch (error) {
      this.logger?.error({ err: error, commandId }, "Failed to post command result");
    }
  }
}
