import type { HttpClient } from "./http-client.js";
import { SUPPORTED_COMMAND_TYPES, type CommandResultInput, type GatewayCommand, type GatewayDataSource, type ReadingInput } from "./types.js";

export interface GatewayApiOptions {
  // A lost result permanently strands a command IN_PROGRESS on ferrion's
  // side (no server-side recovery) - result posting alone gets bounded
  // retries with backoff, unlike other calls here.
  resultRetryAttempts?: number;
  resultRetryBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // This gateway's own version, sent with every poll so ferrion can show it
  // and know what the gateway runs (R07).
  version?: string;
  // FG_DISCOVERY_ALLOWED_CIDRS, so ferrion's settings can show a release
  // outside it as having no effect (R07, decision 8). Left out when not set:
  // with DISCOVER_DEVICES among the capabilities, that means "no discovery".
  discoveryLimit?: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GatewayApi {
  private readonly http: HttpClient;
  private readonly resultRetryAttempts: number;
  private readonly resultRetryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly commandsPath: string;

  constructor(http: HttpClient, options: GatewayApiOptions = {}) {
    this.http = http;
    this.resultRetryAttempts = options.resultRetryAttempts ?? 3;
    this.resultRetryBaseDelayMs = options.resultRetryBaseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    // Version and capabilities ride on the poll ferrion already gets every
    // few seconds - no extra request. An older ferrion ignores the query.
    const query = new URLSearchParams({ capabilities: SUPPORTED_COMMAND_TYPES.join(",") });
    if (options.version) query.set("version", options.version);
    if (options.discoveryLimit && options.discoveryLimit.length > 0) query.set("discoveryLimit", options.discoveryLimit.join(","));
    this.commandsPath = `/api/gateway/commands?${query.toString()}`;
  }

  async fetchCommands(): Promise<GatewayCommand[]> {
    const { commands } = await this.http.request<{ commands: GatewayCommand[] }>(this.commandsPath);
    return commands;
  }

  async postCommandResult(commandId: string, input: CommandResultInput): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.resultRetryAttempts; attempt++) {
      try {
        await this.http.request<{ ok: boolean }>(`/api/gateway/commands/${commandId}/result`, {
          method: "POST",
          body: input,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.resultRetryAttempts - 1) {
          await this.sleep(this.resultRetryBaseDelayMs * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  async fetchDataSources(): Promise<GatewayDataSource[]> {
    const { dataSources } = await this.http.request<{ dataSources: GatewayDataSource[] }>(
      "/api/gateway/data-sources",
    );
    return dataSources;
  }

  async pushReadings(readings: ReadingInput[]): Promise<number> {
    if (readings.length === 0) return 0;
    const { accepted } = await this.http.request<{ accepted: number }>("/api/gateway/readings", {
      method: "POST",
      body: { readings },
    });
    return accepted;
  }
}
