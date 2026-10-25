import type { DeviceTemplateId } from "../config/schema.js";
import type { DataSourceProtocol } from "../ferrion-client/types.js";

/**
 * A read-only mirror of ferrion's own device catalog
 * (ferrion's src/lib/known-device-templates.ts) - same ids, metric
 * keys, and protocol addressing, kept in sync by the consistency checks in
 * known-device-templates.test.ts. Used only by drivers/simulated to know
 * which node IDs/registers/topics to expose on the local simulated server;
 * reading real data sources never consults this file, since ferrion already
 * sends the fully-resolved connectionConfig per data source (see
 * ferrion-client/types.ts's GatewayDataSource).
 */

export type DeviceMetricAddressing =
  | { kind: "opcua"; nodeIdentifier: number }
  // jsonField: optional so a future MQTT device that genuinely does
  // publish one bare number per topic isn't forced to have one - see
  // protocol/mqtt/gateway-client.ts's MqttConnectionConfig.jsonField.
  // jsonFieldFallbacks: kept here only for parity with ferrion's own
  // catalog (ferrion's src/lib/known-device-templates.ts) - the
  // local simulator (drivers/simulated) never reads it, it always
  // publishes the shape named by `jsonField` itself.
  | { kind: "mqtt"; topic: string; jsonField?: string; jsonFieldFallbacks?: string[] }
  | {
      kind: "modbus";
      register: number;
      registerCount: number;
      byteOrder: "BIG_ENDIAN" | "WORD_SWAPPED";
      format?: "FLOAT32" | "INT32" | "UINT32";
      resolutionRegister?: number;
    };

export interface DeviceTemplateMetric {
  metricKey: string;
  label: string;
  unit: string;
  addressing: DeviceMetricAddressing;
}

export interface DeviceTemplate {
  id: DeviceTemplateId;
  manufacturer: string;
  model: string;
  protocol: DataSourceProtocol;
  // OPC UA only - "{serialNumber}" placeholder, see ferrion's own doc
  // comment on why the namespace URI is per-device, not a fixed constant.
  namespaceUriTemplate?: string;
  metrics: DeviceTemplateMetric[];
  // Live-discovery hook for a template whose module count varies per
  // physical unit (see gateway/command-handlers.ts's testOpcuaConnection())
  // - the wizard uses this right after a successful connection test to
  // narrow the data-point picker to modules the device actually has,
  // instead of every one the catalog statically allows for. Only one
  // discovery scheme exists so far (a browse of a known "modules" parent
  // node) - kept as a discriminated union so a future device needing a
  // different mechanism doesn't have to reshape this field.
  moduleProbe?: { kind: "opcua-browse"; modulesFolderNodeId: number; maxModuleCount: number };
}

// Janitza UMG 801 (Power Analyser) - a modular multi-circuit power meter,
// not a single-value sensor like the templates above. Register map verified
// against "Formelsammlung zur Modbus-Adressenliste" (Dok. Nr. 2.053.015.1.a,
// 11/2024) + the manufacturer's own Modbus address list XLSX (referenced by
// that manual as the authoritative source, exported to CSV for this catalog
// entry) - never guessed. Big-Endian byte order is explicit in the manual
// ("Die in dieser Adressenliste beschriebenen Adressen liefern die Daten im
// Format 'Big-Endian' zurück"); Float32 values already apply the configured
// transformer ratio ("Messwerte im Float ... Format berücksichtigen die
// entsprechenden Wandlerfaktoren"), so unlike the FD-G above there's no
// resolutionRegister to read.
//
// Registers come from the "basic device" / "Basic device measuring group 01"
// address block (19000-19060) - true 200ms-effective real-time values (a
// "Messwert" per the manual's own definition), not the separate averaged/
// min/max/drag-indicator blocks the same address list also exposes for the
// same physical quantities. That block has no aggregate power-factor
// register (only per-phase "Fund.power factor, Cos(φ)"), so powerFactorL1/
// L2/L3 stay per-phase rather than inventing a sum from a different address
// block.
const JANITZA_UMG801_BASE_METRICS: DeviceTemplateMetric[] = [
  { metricKey: "voltageL1N", label: "Spannung L1-N", unit: "V", addressing: { kind: "modbus", register: 19000, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "voltageL2N", label: "Spannung L2-N", unit: "V", addressing: { kind: "modbus", register: 19002, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "voltageL3N", label: "Spannung L3-N", unit: "V", addressing: { kind: "modbus", register: 19004, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "currentL1", label: "Strom L1", unit: "A", addressing: { kind: "modbus", register: 19012, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "currentL2", label: "Strom L2", unit: "A", addressing: { kind: "modbus", register: 19014, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "currentL3", label: "Strom L3", unit: "A", addressing: { kind: "modbus", register: 19016, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "activePowerSum", label: "Wirkleistung Summe", unit: "W", addressing: { kind: "modbus", register: 19026, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "apparentPowerSum", label: "Scheinleistung Summe", unit: "VA", addressing: { kind: "modbus", register: 19034, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "reactivePowerSum", label: "Blindleistung Summe", unit: "var", addressing: { kind: "modbus", register: 19042, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "powerFactorL1", label: "Leistungsfaktor L1", unit: "-", addressing: { kind: "modbus", register: 19044, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "powerFactorL2", label: "Leistungsfaktor L2", unit: "-", addressing: { kind: "modbus", register: 19046, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "powerFactorL3", label: "Leistungsfaktor L3", unit: "-", addressing: { kind: "modbus", register: 19048, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "frequency", label: "Frequenz", unit: "Hz", addressing: { kind: "modbus", register: 19050, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
  { metricKey: "activeEnergySum", label: "Wirkenergie Summe", unit: "Wh", addressing: { kind: "modbus", register: 19060, registerCount: 2, byteOrder: "BIG_ENDIAN" } },
];

/**
 * Every current group other than the base device's own first one.
 *
 * Corrected 2026-10-09 against the device itself (ferrion's
 * `docs/janitza-umg801-stromgruppen-2026-10-08.md`, measured at the UMG 801
 * on site). What this catalogue called "Modul 2" was in truth module 1's
 * **second current group** - the values were right, the label was not. The
 * unit the device is organised in is the **current group**: the base device
 * carries three, an 800-CT8-A carries two, and each is its own outgoing
 * circuit with its own name on the device.
 *
 * Modbus lays the groups out as consecutive 100-register blocks from 19200,
 * all with the same layout, running **across** devices: base IG2, base IG3,
 * module 1 IG1, module 1 IG2, module 2 IG1, and so on. The base device's own
 * IG1 is the exception, with its own layout from 19000.
 *
 * The sequence is written down for **800-CT8-A modules only**, two groups
 * each, because that is what was verified. A different module type carries a
 * different number of groups and would shift every following block.
 *
 * Mirror of ferrion's own catalogue - same ids, metric keys and addresses,
 * and `device-templates.contract.json` is byte-identical in both repos.
 */
const JANITZA_UMG801_GROUP_BLOCK_BASE = 19200;
const JANITZA_UMG801_GROUP_BLOCK_STRIDE = 100;
const JANITZA_UMG801_BASE_EXTRA_GROUPS = [2, 3];
const JANITZA_UMG801_GROUPS_PER_MODULE = 2;
const JANITZA_UMG801_MODULE_COUNT = 20;

const JANITZA_UMG801_GROUP_OFFSETS = {
  currentL1: 0,
  currentL2: 2,
  currentL3: 4,
  activePowerSum: 14,
  apparentPowerSum: 22,
  // Q1, the fundamental-component reactive power - the same quantity the
  // base device's 19042 carries, and now the same one OPC UA reads.
  reactivePowerSum: 30,
  activeEnergySum: 44,
} as const;

const JANITZA_UMG801_GROUP_UNITS = {
  currentL1: "A",
  currentL2: "A",
  currentL3: "A",
  activePowerSum: "W",
  apparentPowerSum: "VA",
  reactivePowerSum: "var",
  activeEnergySum: "Wh",
} as const;

const JANITZA_UMG801_GROUP_LABELS = {
  currentL1: "Strom L1",
  currentL2: "Strom L2",
  currentL3: "Strom L3",
  activePowerSum: "Wirkleistung Summe",
  apparentPowerSum: "Scheinleistung Summe",
  reactivePowerSum: "Blindleistung Summe",
  activeEnergySum: "Wirkenergie Summe",
} as const;

type JanitzaUmg801GroupQuantity = keyof typeof JANITZA_UMG801_GROUP_OFFSETS;

const JANITZA_UMG801_GROUP_QUANTITIES = Object.keys(
  JANITZA_UMG801_GROUP_OFFSETS
) as JanitzaUmg801GroupQuantity[];

/**
 * The base device's first group keeps the plain keys it has always had, so
 * no stored data changes its name. Everything else gets a new one rather
 * than a key silently changing meaning.
 */
function janitzaUmg801MetricKey(
  quantity: JanitzaUmg801GroupQuantity,
  group: number,
  moduleIndex: number | null
): string {
  const capitalised = quantity.charAt(0).toUpperCase() + quantity.slice(1);
  if (moduleIndex === null) {
    return group === 1 ? quantity : `group${group}${capitalised}`;
  }
  return `module${moduleIndex}Group${group}${capitalised}`;
}

function janitzaUmg801GroupLabel(
  group: number,
  moduleIndex: number | null,
  quantity: JanitzaUmg801GroupQuantity
): string {
  const where = moduleIndex === null ? "Basis" : `Modul ${moduleIndex}`;
  return `${where} – Gruppe ${group} – ${JANITZA_UMG801_GROUP_LABELS[quantity]}`;
}

function janitzaUmg801GroupsAfterBaseFirst(): { group: number; moduleIndex: number | null }[] {
  const groups: { group: number; moduleIndex: number | null }[] = JANITZA_UMG801_BASE_EXTRA_GROUPS.map(
    (group) => ({ group, moduleIndex: null })
  );
  for (let moduleIndex = 1; moduleIndex <= JANITZA_UMG801_MODULE_COUNT; moduleIndex++) {
    for (let group = 1; group <= JANITZA_UMG801_GROUPS_PER_MODULE; group++) {
      groups.push({ group, moduleIndex });
    }
  }
  return groups;
}

function buildJanitzaUmg801GroupMetricsModbus(): DeviceTemplateMetric[] {
  return janitzaUmg801GroupsAfterBaseFirst().flatMap(({ group, moduleIndex }, blockIndex) => {
    const base = JANITZA_UMG801_GROUP_BLOCK_BASE + blockIndex * JANITZA_UMG801_GROUP_BLOCK_STRIDE;
    return JANITZA_UMG801_GROUP_QUANTITIES.map((quantity) => ({
      metricKey: janitzaUmg801MetricKey(quantity, group, moduleIndex),
      label: janitzaUmg801GroupLabel(group, moduleIndex, quantity),
      unit: JANITZA_UMG801_GROUP_UNITS[quantity],
      addressing: {
        kind: "modbus" as const,
        register: base + JANITZA_UMG801_GROUP_OFFSETS[quantity],
        registerCount: 2,
        byteOrder: "BIG_ENDIAN" as const,
      },
    }));
  });
}

function buildJanitzaUmg801Metrics(): DeviceTemplateMetric[] {
  return [...JANITZA_UMG801_BASE_METRICS, ...buildJanitzaUmg801GroupMetricsModbus()];
}

// OPC UA variant of the same physical device - no vendor documentation was
// available for this protocol (unlike the Modbus address list above), so
// the Node ID scheme below was discovered by live-browsing the address
// space of 5 real UMG 801 units and cross-verifying the resulting formula
// against 4 of them (module counts 1, 2, ~9, and 10 - matching that
// different installations have different numbers of current-measurement
// modules actually fitted). The 5th unit's "public" process-data namespace
// browses as genuinely empty (BadNodeIdUnknown even for the base device's
// own voltage/frequency nodes) despite registering the same namespace URI -
// apparently a configuration/licensing difference on that specific unit,
// not a gap in this addressing scheme; worth the user checking that unit's
// own OPC UA configuration if they rely on it.
//
// Every "measuring group" (the base device's own primary group, and each
// current-measurement module's own primary group) uses an *identical* set
// of offsets relative to its own group root - confirmed against both the
// base device and module 1's group live. A module's own group root is
// 1000000 (module 1) + (moduleIndex-1)*100000, plus a fixed +5000 to reach
// that module's primary group.
const JANITZA_UMG801_NAMESPACE_URI = "https://opc.janitza.de/umg801/public";

// The "Modules" parent folder - live-confirmed 2026-09-04 against a real
// unit: its children are exactly the fitted modules' own
// "ModuleN" nodes (that unit had 3: Module1/Module2/Module3), each at
// JANITZA_UMG801_MODULE_ROOT_BASE + (N-1)*JANITZA_UMG801_MODULE_ROOT_STRIDE
// - not derivable from the per-module Node IDs alone, so kept as its own
// constant. Used by gateway/command-handlers.ts's testOpcuaConnection() via
// this template's moduleProbe, not by anything in this file itself.
const JANITZA_UMG801_MODULES_FOLDER_NODE_ID = 999000;

// Same metricKeys as the Modbus TCP template above, mapped to this
// namespace's own Node IDs - keeping the metric surface identical across
// protocol variants of one physical device (see the AVENTICS AF2 OPC
// UA/MQTT templates above for the established precedent). No
// {serialNumber} templating needed: unlike the AF2, every UMG 801 unit
// tested registers the exact same fixed namespace URI.
const JANITZA_UMG801_BASE_METRICS_OPCUA: DeviceTemplateMetric[] = [
  { metricKey: "voltageL1N", label: "Spannung L1-N", unit: "V", addressing: { kind: "opcua", nodeIdentifier: 135600 } },
  { metricKey: "voltageL2N", label: "Spannung L2-N", unit: "V", addressing: { kind: "opcua", nodeIdentifier: 137600 } },
  { metricKey: "voltageL3N", label: "Spannung L3-N", unit: "V", addressing: { kind: "opcua", nodeIdentifier: 139600 } },
  { metricKey: "currentL1", label: "Strom L1", unit: "A", addressing: { kind: "opcua", nodeIdentifier: 103240 } },
  { metricKey: "currentL2", label: "Strom L2", unit: "A", addressing: { kind: "opcua", nodeIdentifier: 105240 } },
  { metricKey: "currentL3", label: "Strom L3", unit: "A", addressing: { kind: "opcua", nodeIdentifier: 107240 } },
  { metricKey: "activePowerSum", label: "Wirkleistung Summe", unit: "W", addressing: { kind: "opcua", nodeIdentifier: 101260 } },
  { metricKey: "apparentPowerSum", label: "Scheinleistung Summe", unit: "VA", addressing: { kind: "opcua", nodeIdentifier: 101380 } },
  { metricKey: "reactivePowerSum", label: "Blindleistung Summe", unit: "var", addressing: { kind: "opcua", nodeIdentifier: 101360 } },
  { metricKey: "powerFactorL1", label: "Leistungsfaktor L1", unit: "-", addressing: { kind: "opcua", nodeIdentifier: 103360 } },
  { metricKey: "powerFactorL2", label: "Leistungsfaktor L2", unit: "-", addressing: { kind: "opcua", nodeIdentifier: 105360 } },
  { metricKey: "powerFactorL3", label: "Leistungsfaktor L3", unit: "-", addressing: { kind: "opcua", nodeIdentifier: 107360 } },
  { metricKey: "frequency", label: "Frequenz", unit: "Hz", addressing: { kind: "opcua", nodeIdentifier: 131100 } },
  { metricKey: "activeEnergySum", label: "Wirkenergie Summe", unit: "Wh", addressing: { kind: "opcua", nodeIdentifier: 102505 } },
];

/**
 * OPC UA addresses the same current groups, and here the rule really is a
 * formula - independent of which module types are fitted.
 *
 * Group root = device root + (g-1) * 10000, base device 100000, module m
 * 1004000 + (m-1) * 100000. Checked against the device 2026-10-09.
 *
 * Two corrections to the base device's group above: current read `ILoad`
 * (a percentage of nominal current) and is now `IRms` in amperes, and
 * reactive power read the total Q while Modbus read Q1 - both are Q1 now.
 */
const JANITZA_UMG801_BASE_DEVICE_ROOT = 100000;
const JANITZA_UMG801_MODULE_DEVICE_ROOT = 1004000;
const JANITZA_UMG801_MODULE_ROOT_STRIDE_OPCUA = 100000;
const JANITZA_UMG801_GROUP_ROOT_STRIDE = 10000;

const JANITZA_UMG801_GROUP_OFFSETS_OPCUA: Record<JanitzaUmg801GroupQuantity, number> = {
  currentL1: 3240,
  currentL2: 5240,
  currentL3: 7240,
  activePowerSum: 1260,
  apparentPowerSum: 1380,
  reactivePowerSum: 1360,
  activeEnergySum: 2505,
};

function janitzaUmg801GroupRootOpcua(group: number, moduleIndex: number | null): number {
  const deviceRoot =
    moduleIndex === null
      ? JANITZA_UMG801_BASE_DEVICE_ROOT
      : JANITZA_UMG801_MODULE_DEVICE_ROOT + (moduleIndex - 1) * JANITZA_UMG801_MODULE_ROOT_STRIDE_OPCUA;
  return deviceRoot + (group - 1) * JANITZA_UMG801_GROUP_ROOT_STRIDE;
}

function buildJanitzaUmg801GroupMetricsOpcua(): DeviceTemplateMetric[] {
  return janitzaUmg801GroupsAfterBaseFirst().flatMap(({ group, moduleIndex }) => {
    const groupRoot = janitzaUmg801GroupRootOpcua(group, moduleIndex);
    return JANITZA_UMG801_GROUP_QUANTITIES.map((quantity) => ({
      metricKey: janitzaUmg801MetricKey(quantity, group, moduleIndex),
      label: janitzaUmg801GroupLabel(group, moduleIndex, quantity),
      unit: JANITZA_UMG801_GROUP_UNITS[quantity],
      addressing: { kind: "opcua" as const, nodeIdentifier: groupRoot + JANITZA_UMG801_GROUP_OFFSETS_OPCUA[quantity] },
    }));
  });
}

function buildJanitzaUmg801MetricsOpcua(): DeviceTemplateMetric[] {
  return [...JANITZA_UMG801_BASE_METRICS_OPCUA, ...buildJanitzaUmg801GroupMetricsOpcua()];
}

export const DEVICE_TEMPLATES: DeviceTemplate[] = [
  {
    id: "aventics-af2-opcua",
    manufacturer: "AVENTICS",
    model: "AF2 (Ethernet, OPC UA)",
    protocol: "OPC_UA",
    namespaceUriTemplate: "urn:AVENTICS:AF2:{serialNumber}",
    metrics: [
      {
        metricKey: "massFlowRate",
        label: "Massendurchfluss",
        unit: "kg/h",
        addressing: { kind: "opcua", nodeIdentifier: 6002 },
      },
      {
        metricKey: "volumetricFlowRate",
        label: "Volumendurchfluss",
        unit: "m³/h",
        addressing: { kind: "opcua", nodeIdentifier: 6010 },
      },
      {
        metricKey: "temperature",
        label: "Temperatur",
        unit: "°C",
        addressing: { kind: "opcua", nodeIdentifier: 6014 },
      },
      {
        metricKey: "pressure",
        label: "Druck",
        unit: "bar",
        addressing: { kind: "opcua", nodeIdentifier: 6013 },
      },
    ],
  },
  {
    id: "aventics-af2-mqtt",
    manufacturer: "AVENTICS",
    model: "AF2 (Ethernet, MQTT)",
    protocol: "MQTT",
    // Confirmed live against a real unit (2026-08-20) and against the SICK
    // FTMg operating instructions ch. 9.4.3/9.4.4 (SICK manufactures the
    // AF2 for AVENTICS/Emerson - same firmware, relabeled): the "Single"
    // ProcessData format publishes every metric as a field of ONE shared
    // JSON object on ONE topic (site-configured in the sensor's own web
    // UI, no fixed convention), not one topic per metric as this catalog
    // previously assumed. "af2/processdata" below is only a placeholder -
    // the real per-device topic still has to be entered in the wizard.
    //
    // jsonFieldFallbacks covers a second real AF2 unit (SCANIA-AF2-Montage,
    // 2026-08-21, topic under a "d/ITA_SDK/..." prefix - same broker/site as
    // this template's other units, so likely an older firmware/OEM variant
    // rather than a different system) that publishes each metric as a
    // PascalCase-named, nested {value, unit, min, max, mean} object instead
    // of the flat lower-camelCase number, e.g.
    // {"MassFlowRate":{"value":1.91,...},...,"Pressure":{"value":11.70,...}}.
    // Still one shared topic per device - only the per-metric field's shape
    // differs (a dotted path reaching into the nested object, see
    // protocol/mqtt/gateway-client.ts's getByPath() use). Kept as one
    // template rather than a second catalog entry since a user has no way
    // to know which firmware their real unit runs before connecting.
    metrics: [
      {
        metricKey: "massFlowRate",
        label: "Massendurchfluss",
        unit: "kg/h",
        addressing: {
          kind: "mqtt",
          topic: "af2/processdata",
          jsonField: "massFlowRate",
          jsonFieldFallbacks: ["MassFlowRate.value", "MassFlowRate"],
        },
      },
      {
        metricKey: "volumetricFlowRate",
        label: "Volumendurchfluss",
        unit: "m³/h",
        addressing: {
          kind: "mqtt",
          topic: "af2/processdata",
          jsonField: "volumetricFlowRate",
          jsonFieldFallbacks: ["VolumetricFlowRate.value", "VolumetricFlowRate"],
        },
      },
      {
        metricKey: "temperature",
        label: "Temperatur",
        unit: "°C",
        addressing: {
          kind: "mqtt",
          topic: "af2/processdata",
          jsonField: "temperature",
          jsonFieldFallbacks: ["Temperature.value", "Temperature"],
        },
      },
      {
        metricKey: "pressure",
        label: "Druck",
        unit: "bar",
        addressing: {
          kind: "mqtt",
          topic: "af2/processdata",
          jsonField: "pressure",
          jsonFieldFallbacks: ["Pressure.value", "Pressure"],
        },
      },
    ],
  },
  {
    id: "aventics-ds1-modbus-tcp",
    manufacturer: "AVENTICS",
    model: "DS1 (Modbus TCP)",
    protocol: "MODBUS_TCP",
    metrics: [
      {
        metricKey: "temperature",
        label: "Temperatur",
        unit: "°C",
        addressing: { kind: "modbus", register: 1000, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        metricKey: "relativeHumidity",
        label: "Rel. Feuchtigkeit",
        unit: "%",
        addressing: { kind: "modbus", register: 1004, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        metricKey: "dewPoint",
        label: "Taupunkt",
        unit: "°Ctd",
        addressing: { kind: "modbus", register: 1006, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      // The five below were missing here while the platform's own catalog
      // listed them all along - so a data source created for any of them
      // would have been polled from a register this gateway never served,
      // and the metric would have sat empty with nothing to explain why.
      // Registers are the device's own, taken from the same operating
      // instructions as the three above.
      {
        metricKey: "absoluteHumidity",
        label: "Absolute Feuchtigkeit",
        unit: "g/m³",
        addressing: { kind: "modbus", register: 1010, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        // The pressure-invariant one: unchanged by compression or expansion,
        // which is what makes it the right quantity for comparing two points
        // in a network against each other.
        metricKey: "moistureContent",
        label: "Feuchtegehalt",
        unit: "g/kg",
        addressing: { kind: "modbus", register: 1014, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        metricKey: "vaporRatio",
        label: "Wasserdampfgehalt",
        unit: "ppm",
        addressing: { kind: "modbus", register: 1016, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        metricKey: "waterVaporPartialPressure",
        label: "Wasserdampf-Partialdruck",
        unit: "hPa",
        addressing: { kind: "modbus", register: 1020, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
      {
        // Shares the unit with dewPoint but is a different quantity - the
        // dew point after expansion to atmospheric pressure. ISO 8573-1's
        // water classes are defined against the PRESSURE dew point, so this
        // one must never be classified against them.
        metricKey: "atmosphericDewPoint",
        label: "Atmosphärischer Taupunkt",
        unit: "°Ctd",
        addressing: { kind: "modbus", register: 1022, registerCount: 2, byteOrder: "BIG_ENDIAN" },
      },
    ],
  },
  {
    id: "keyence-fd-g-modbus-tcp",
    manufacturer: "KEYENCE",
    model: "FD-G (Modbus TCP)",
    protocol: "MODBUS_TCP",
    metrics: [
      {
        metricKey: "volumetricFlowRate",
        label: "Durchflussrate",
        unit: "m³/h",
        addressing: {
          kind: "modbus",
          register: 4,
          registerCount: 2,
          byteOrder: "WORD_SWAPPED",
          format: "INT32",
          resolutionRegister: 25,
        },
      },
    ],
  },
  {
    id: "janitza-umg801-modbus-tcp",
    manufacturer: "Janitza",
    model: "UMG 801 (Modbus TCP)",
    protocol: "MODBUS_TCP",
    metrics: buildJanitzaUmg801Metrics(),
  },
  {
    id: "janitza-umg801-opcua",
    manufacturer: "Janitza",
    model: "UMG 801 (OPC UA)",
    protocol: "OPC_UA",
    namespaceUriTemplate: JANITZA_UMG801_NAMESPACE_URI,
    metrics: buildJanitzaUmg801MetricsOpcua(),
    moduleProbe: {
      kind: "opcua-browse",
      modulesFolderNodeId: JANITZA_UMG801_MODULES_FOLDER_NODE_ID,
      maxModuleCount: JANITZA_UMG801_MODULE_COUNT,
    },
  },
];

export function getDeviceTemplate(id: DeviceTemplateId): DeviceTemplate {
  const template = DEVICE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) {
    throw new Error(`Unknown device template id: ${id}`);
  }
  return template;
}
