// Mirrors ferrion's own gateway-facing API contract exactly
// (~/asset-manager/src/app/api/gateway/**) - see that repo's
// prisma/schema.prisma for GatewayCommandType/DataSourceProtocol and
// src/lib/known-device-templates.ts for how connectionConfig is built.

export type DataSourceProtocol = "MQTT" | "MODBUS_TCP" | "OPC_UA";

// The command types this gateway can run - reported to ferrion with every
// poll as its capabilities (gateway-api.ts), so ferrion never hands it one it
// does not know (R07). A type outside this list is answered "unsupported".
export const SUPPORTED_COMMAND_TYPES = ["TEST_CONNECTION", "BROWSE_DATA_POINTS", "DISCOVER_DEVICES"] as const;

export type SupportedCommandType = (typeof SUPPORTED_COMMAND_TYPES)[number];

// The two that run inside the command loop; DISCOVER_DEVICES runs beside it
// (command-loop.ts) and carries its own payload (discovery/scan-request.ts).
export type CommandType = Exclude<SupportedCommandType, "DISCOVER_DEVICES">;

export interface CommandPayload {
  protocol: DataSourceProtocol;
  // Raw, unresolved connection-step form values (e.g. serialNumber as a
  // plain string) - never the fully-resolved connectionConfig shape below.
  connectionValues: Record<string, string>;
  // The catalog template id the wizard's device step picked (see ferrion's
  // own known-device-templates.ts), so command-handlers.ts's OPC UA
  // namespace-URI resolution knows which template applies instead of
  // assuming a single hardcoded one - undefined for the "Sonstiges/manuell"
  // path, which never has a catalog template.
  templateId?: string;
}

export type GatewayCommand =
  | { id: string; type: CommandType; payload: CommandPayload }
  // Checked by planScan() before anything else, so typed as unknown here.
  | { id: string; type: "DISCOVER_DEVICES"; payload: unknown };

export type CommandResultStatus = "COMPLETED" | "FAILED";

export interface CommandResultInput {
  status: CommandResultStatus;
  result?: unknown;
}

// The fully-resolved form (e.g. OPC UA's namespaceUri already substituted)
// as returned by GET /api/gateway/data-sources - contrast CommandPayload's
// raw connectionValues above.
export interface GatewayDataSource {
  id: string;
  assetId: string;
  // The physical sensor's own name as assigned in ferrion - identical
  // across every data source sharing one assetId (they're all metrics of
  // the same Asset). Used to group per-metric tracked sources into one
  // row per sensor in the Web UI (see reading-loop.ts's getTrackedSensors()).
  assetName: string;
  protocol: DataSourceProtocol;
  connectionConfig: Record<string, unknown>;
  metricKey: string;
  label: string;
  unit: string | null;
}

export interface ReadingInput {
  dataSourceId: string;
  timestamp: string;
  value: number;
}
