import type { DeviceTemplateId, Ports } from "../src/config/schema.js";
import { getDeviceTemplate } from "../src/device-catalog/known-device-templates.js";
import type { DataSourceProtocol } from "../src/ferrion-client/types.js";

const BASE_PORTS = {
  opcua: 4840,
  modbus: 5502,
  mqtt: 1883,
} as const;

type ProtocolKind = keyof typeof BASE_PORTS;

// Derived from the catalog's own `protocol` field rather than a hardcoded
// per-id list - found live: a hardcoded list silently fell through to
// "modbus" for a newly-added MQTT template (aventics-af2-mqtt-legacy,
// later merged into aventics-af2-mqtt once its payload-shape difference
// turned out to only need jsonFieldFallbacks, not a separate template)
// that wasn't in it, handing out a colliding Modbus port instead of an
// MQTT one. Deriving from DEVICE_TEMPLATES instead means adding a
// template can never desync this mapping again.
const PROTOCOL_TO_KIND: Record<DataSourceProtocol, ProtocolKind> = {
  OPC_UA: "opcua",
  MQTT: "mqtt",
  MODBUS_TCP: "modbus",
};

export function protocolKindForTemplate(templateId: DeviceTemplateId): ProtocolKind {
  return PROTOCOL_TO_KIND[getDeviceTemplate(templateId).protocol];
}

// The smallest port from the protocol's base upward that no existing
// instance holds - what the control plane needs, as opposed to the
// positional fleet allocation below. Recomputing the fleet sequence from
// template ids alone handed a deleted instance's successor the port of a
// *remaining* instance (A 5502, B 5503, delete A, create C -> C got 5503;
// review 2026-09, H-6): the sequence knows the order, not the ports that
// are actually taken.
export function nextFreePort(templateId: DeviceTemplateId, usedPorts: Iterable<Ports>): Ports {
  const kind = protocolKindForTemplate(templateId);
  const taken = new Set<number>();
  for (const ports of usedPorts) {
    const port = ports[kind];
    if (port !== undefined) taken.add(port);
  }
  let candidate = BASE_PORTS[kind];
  while (taken.has(candidate)) candidate += 1;
  return { [kind]: candidate };
}

// Pure function: basePort + index within that protocol, per the plan - a
// fleet can be protocol-mixed, so each protocol counts up independently
// (the 3rd OPC UA instance and the 1st MQTT instance don't collide just
// because they're both "instance index 2" in the overall list).
//
// `undefined` entries (a bridge-only instance/record with no local
// simulated device - see control-plane/routes.ts's allocatePortsFor() and
// fleet/launcher.ts) get `{}` back at their own position and don't
// consume a protocol slot - callers can pass `record.device?.templateId`
// straight through without filtering first, which matters specifically
// because this function's output is positional: filtering the input
// before calling this would desync the result from the caller's own
// index-based lookups (e.g. launcher.ts's `allocatedPorts[index]`).
export function allocatePorts(templateIds: readonly (DeviceTemplateId | undefined)[]): Ports[] {
  const nextIndexByKind: Record<ProtocolKind, number> = { opcua: 0, modbus: 0, mqtt: 0 };

  return templateIds.map((templateId) => {
    if (!templateId) return {};
    const kind = protocolKindForTemplate(templateId);
    const port = BASE_PORTS[kind] + nextIndexByKind[kind];
    nextIndexByKind[kind] += 1;
    return { [kind]: port };
  });
}
