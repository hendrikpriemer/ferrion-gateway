import { DEVICE_TEMPLATE_IDS, type DeviceTemplateId } from "../config/schema.js";
import { getDeviceTemplate } from "../device-catalog/known-device-templates.js";
import type { CommandPayload, CommandResultInput, CommandType } from "../ferrion-client/types.js";
import { errorMessage } from "../util/error-message.js";

// TEST_CONNECTION/BROWSE_DATA_POINTS payloads carry `templateId` when the
// wizard's device step picked a known catalog template (see
// ferrion-client/types.ts's CommandPayload) - falls back to AF2 both when
// it's absent (the "Sonstiges/manuell" path never has one) and when it
// names a template this gateway version doesn't recognize (an older
// ferrion talking to a newer gateway, or vice versa). Matches this
// function's own pre-templateId behavior exactly, so neither case is a
// regression - AF2 was already the only option before templateId existed.
const FALLBACK_OPCUA_TEMPLATE_ID = "aventics-af2-opcua";

// Same multi-scheme situation as gateway-client.ts's
// OpcuaConnectionConfig.namespaceUriFallbacks - the AF2 catalog entry
// covers several real-world namespace URI variants against the one
// "AVENTICS AF2 (OPC UA)" template's Node IDs. Kept here too (mirroring
// ferrion's own known-device-templates.ts) since TEST_CONNECTION/
// BROWSE_DATA_POINTS never go through ferrion's already-resolved
// connectionConfig. "{serialNumber}" entries get the same substitution as
// the primary URI. AF2-specific: no other OPC UA template needs fallbacks
// (Janitza UMG801's namespace URI is fixed, confirmed identical across
// every real unit).
const AVENTICS_AF2_NAMESPACE_FALLBACK_TEMPLATES = [
  "urn:AVENTICS:AF2::{serialNumber}",
  "http://emerson.com/Flowmeter/AF2/Instance/",
];

function resolveOpcuaTemplateId(payload: Pick<CommandPayload, "templateId">): DeviceTemplateId {
  const candidate = payload.templateId;
  if (candidate && (DEVICE_TEMPLATE_IDS as readonly string[]).includes(candidate)) {
    return candidate as DeviceTemplateId;
  }
  return FALLBACK_OPCUA_TEMPLATE_ID;
}

export function resolveOpcuaNamespaceUri(payload: Pick<CommandPayload, "templateId">, serialNumber: string): string {
  const template = getDeviceTemplate(resolveOpcuaTemplateId(payload));
  return (template.namespaceUriTemplate ?? "").replace("{serialNumber}", serialNumber);
}

export function resolveOpcuaNamespaceUriFallbacks(payload: Pick<CommandPayload, "templateId">, serialNumber: string): string[] {
  if (resolveOpcuaTemplateId(payload) !== FALLBACK_OPCUA_TEMPLATE_ID) return [];
  return AVENTICS_AF2_NAMESPACE_FALLBACK_TEMPLATES.map((template) => template.replace("{serialNumber}", serialNumber));
}

import {
  discoverUmg801CurrentGroups,
  type Umg801CurrentGroup,
} from "../device-catalog/umg801-current-groups.js";

function toErrorResult(error: unknown): CommandResultInput {
  return { status: "FAILED", result: { error: errorMessage(error) } };
}

// Each protocol's gateway-client is imported lazily, only when a command
// for that protocol actually arrives - see device-simulator.ts's comment
// on why (node-opcua alone costs ~78Mi RSS beyond the Node/tsx baseline;
// importing every protocol unconditionally meant every instance paid that
// cost, even a pure Modbus/MQTT one that would otherwise never load it).

async function testOpcuaConnection(payload: CommandPayload): Promise<{ discoveredModuleIndices?: number[]; softwareVersion?: string }> {
  const { OpcuaGatewayClient } = await import("../protocol/opcua/gateway-client.js");
  const host = payload.connectionValues.host ?? "";
  const port = Number(payload.connectionValues.port);
  const serialNumber = payload.connectionValues.serialNumber ?? "";
  const namespaceUri = resolveOpcuaNamespaceUri(payload, serialNumber);
  const namespaceUriFallbacks = resolveOpcuaNamespaceUriFallbacks(payload, serialNumber);
  const client = new OpcuaGatewayClient({ host, port, namespaceUri, namespaceUriFallbacks });
  try {
    await client.testConnection();
    // Like the module probe below, an extra that must never fail the test:
    // ferrion refuses a UMG 801 older than 1.6 with it (ferrion#902),
    // and says so when the device does not tell.
    const softwareVersion = await client.readSoftwareVersion().catch(() => null);
    const version = softwareVersion ? { softwareVersion } : {};
    const moduleProbe = getDeviceTemplate(resolveOpcuaTemplateId(payload)).moduleProbe;
    if (!moduleProbe) return version;
    // A failed probe (network hiccup, etc.) must not fail the connection
    // test itself - the wizard already confirmed the device is reachable
    // above; it just falls back to showing every possible module (see
    // AddDataSourceDialog.tsx) instead of narrowing to discovered ones.
    try {
      const discoveredModuleIndices = await client.browseModules(moduleProbe.modulesFolderNodeId);
      return { ...version, discoveredModuleIndices };
    } catch {
      return version;
    }
  } finally {
    await client.disconnect();
  }
}

// Acquired from the shared registry, not a fresh client: a device that is
// already being read (e.g. adding metrics to an existing DS1) often accepts
// only one Modbus TCP connection, and a second one for the test was refused
// with ECONNREFUSED while the readings kept flowing. With no reader on that
// device, release() closes the connection exactly as before.
async function testModbusConnection(payload: CommandPayload): Promise<void> {
  const { acquireModbusGatewayClient, releaseModbusGatewayClient } = await import("../protocol/modbus/gateway-client.js");
  const connection = { host: (payload.connectionValues.host ?? "").trim(), port: Number(payload.connectionValues.port) };
  const client = acquireModbusGatewayClient(connection);
  try {
    await client.testConnection();
  } finally {
    releaseModbusGatewayClient(connection);
  }
}

async function testMqttConnection(payload: CommandPayload): Promise<void> {
  const { MqttGatewayClient } = await import("../protocol/mqtt/gateway-client.js");
  const client = new MqttGatewayClient({
    brokerUrl: payload.connectionValues.brokerUrl ?? "",
    port: Number(payload.connectionValues.port),
    username: payload.connectionValues.username,
    password: payload.connectionValues.password,
  });
  try {
    await client.testConnection();
  } finally {
    client.disconnect();
  }
}

/** Both protocol variants of the UMG 801 serve the same web interface. */
const UMG801_TEMPLATE_IDS = new Set(["janitza-umg801-modbus-tcp", "janitza-umg801-opcua"]);

/**
 * The device's own current groups, asked over HTTP, for either protocol.
 *
 * Separate from the protocol test above because it has nothing to do with
 * the protocol: the UMG 801 serves `/deviceinfo/structure` over plain HTTP
 * whether ferrion reads it via Modbus or OPC UA, and the names of the
 * outgoing circuits live only there.
 *
 * Failure is reported, not swallowed: `currentGroupDiscovery: "unavailable"`
 * tells ferrion to say "groups could not be determined - please check on the
 * device" rather than letting an absent list read as "this device has none".
 * Never conclude a group exists from the fact that numbers arrive.
 */
async function discoverCurrentGroups(
  payload: CommandPayload
): Promise<{ discoveredCurrentGroups?: Umg801CurrentGroup[]; currentGroupDiscovery?: "unavailable" }> {
  if (!UMG801_TEMPLATE_IDS.has(payload.templateId ?? "")) return {};
  const host = (payload.connectionValues.host ?? "").trim();
  if (host === "") return {};
  const groups = await discoverUmg801CurrentGroups(host);
  return groups ? { discoveredCurrentGroups: groups } : { currentGroupDiscovery: "unavailable" };
}

export async function handleTestConnection(payload: CommandPayload): Promise<CommandResultInput> {
  try {
    let extra: { discoveredModuleIndices?: number[]; softwareVersion?: string } = {};
    if (payload.protocol === "OPC_UA") {
      extra = await testOpcuaConnection(payload);
    } else if (payload.protocol === "MODBUS_TCP") {
      await testModbusConnection(payload);
    } else {
      await testMqttConnection(payload);
    }
    // Only after the connection itself is known good: this is an extra, and
    // it must never turn a working device into a failed test.
    const groups = await discoverCurrentGroups(payload);
    return { status: "COMPLETED", result: { ok: true, ...extra, ...groups } };
  } catch (error) {
    return toErrorResult(error);
  }
}

// Real Browse service call for OPC UA; a documented stub for Modbus/MQTT
// (neither protocol has a real discovery mechanism, and ferrion's UI
// doesn't consume browse results yet either - see the plan's Verifikation
// section).
export async function handleBrowseDataPoints(payload: CommandPayload): Promise<CommandResultInput> {
  if (payload.protocol !== "OPC_UA") {
    return {
      status: "FAILED",
      result: { error: `BROWSE_DATA_POINTS is not implemented for protocol ${payload.protocol}` },
    };
  }
  const { OpcuaGatewayClient } = await import("../protocol/opcua/gateway-client.js");
  const host = payload.connectionValues.host ?? "";
  const port = Number(payload.connectionValues.port);
  const namespaceUri = resolveOpcuaNamespaceUri(payload, payload.connectionValues.serialNumber ?? "");
  const client = new OpcuaGatewayClient({ host, port, namespaceUri });
  try {
    const nodes = await client.browse();
    return { status: "COMPLETED", result: { nodes } };
  } catch (error) {
    return toErrorResult(error);
  } finally {
    await client.disconnect();
  }
}

// A type this gateway does not know - a newer ferrion's DISCOVER_DEVICES,
// say - is answered as such. Until R07 anything but TEST_CONNECTION ran as
// BROWSE_DATA_POINTS: an older gateway would have browsed when asked to scan.
export async function handleCommand(type: CommandType, payload: CommandPayload): Promise<CommandResultInput> {
  switch (type) {
    case "TEST_CONNECTION":
      return handleTestConnection(payload);
    case "BROWSE_DATA_POINTS":
      return handleBrowseDataPoints(payload);
    default:
      return { status: "FAILED", result: { error: `unsupported command: ${String(type)}` } };
  }
}
