import { describe, expect, it } from "vitest";
import { DEVICE_TEMPLATE_IDS } from "../config/schema.js";
import { DEVICE_TEMPLATES, getDeviceTemplate } from "./known-device-templates.js";

describe("DEVICE_TEMPLATES", () => {
  it("has exactly one entry per DeviceTemplateId from the config schema", () => {
    expect(DEVICE_TEMPLATES.map((t) => t.id).sort()).toEqual([...DEVICE_TEMPLATE_IDS].sort());
  });

  it("every metric's addressing.kind matches the template's own protocol", () => {
    const expectedKind: Record<string, string> = { OPC_UA: "opcua", MQTT: "mqtt", MODBUS_TCP: "modbus" };
    for (const template of DEVICE_TEMPLATES) {
      for (const metric of template.metrics) {
        expect(metric.addressing.kind).toBe(expectedKind[template.protocol]);
      }
    }
  });

  it("AF2 OPC UA: real Node IDs and namespace URI template, verified against the NodeSet2 export", () => {
    const template = getDeviceTemplate("aventics-af2-opcua");
    expect(template.namespaceUriTemplate).toBe("urn:AVENTICS:AF2:{serialNumber}");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.massFlowRate).toEqual({ kind: "opcua", nodeIdentifier: 6002 });
    expect(byMetric.volumetricFlowRate).toEqual({ kind: "opcua", nodeIdentifier: 6010 });
    expect(byMetric.temperature).toEqual({ kind: "opcua", nodeIdentifier: 6014 });
    expect(byMetric.pressure).toEqual({ kind: "opcua", nodeIdentifier: 6013 });
  });

  it("AF2 MQTT: every metric shares one topic, distinguished by jsonField, with a dotted jsonFieldFallbacks path for the older-firmware payload shape", () => {
    const template = getDeviceTemplate("aventics-af2-mqtt");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.temperature).toEqual({
      kind: "mqtt",
      topic: "af2/processdata",
      jsonField: "temperature",
      jsonFieldFallbacks: ["Temperature.value", "Temperature"],
    });
    expect(byMetric.pressure).toEqual({
      kind: "mqtt",
      topic: "af2/processdata",
      jsonField: "pressure",
      jsonFieldFallbacks: ["Pressure.value", "Pressure"],
    });
    const topics = new Set(template.metrics.map((m) => (m.addressing.kind === "mqtt" ? m.addressing.topic : null)));
    expect(topics.size).toBe(1);
  });

  it("DS1 Modbus TCP: registers verified against the manual's Chapter 11.2.1 mapping table", () => {
    const template = getDeviceTemplate("aventics-ds1-modbus-tcp");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.temperature).toEqual({ kind: "modbus", register: 1000, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.relativeHumidity).toEqual({
      kind: "modbus",
      register: 1004,
      registerCount: 2,
      byteOrder: "BIG_ENDIAN",
    });
    expect(byMetric.dewPoint).toEqual({ kind: "modbus", register: 1006, registerCount: 2, byteOrder: "BIG_ENDIAN" });
  });

  it("KEYENCE FD-G Modbus TCP: registers verified against the manual's section 9-6 Holding Register table", () => {
    const template = getDeviceTemplate("keyence-fd-g-modbus-tcp");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.volumetricFlowRate).toEqual({
      kind: "modbus",
      register: 4,
      registerCount: 2,
      byteOrder: "WORD_SWAPPED",
      format: "INT32",
      resolutionRegister: 25,
    });
  });

  it("Janitza UMG 801 Modbus TCP: base-device registers verified against the address list's 'basic device' / 'Basic device measuring group 01' block", () => {
    const template = getDeviceTemplate("janitza-umg801-modbus-tcp");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.voltageL1N).toEqual({ kind: "modbus", register: 19000, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.currentL1).toEqual({ kind: "modbus", register: 19012, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.activePowerSum).toEqual({ kind: "modbus", register: 19026, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.apparentPowerSum).toEqual({ kind: "modbus", register: 19034, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.reactivePowerSum).toEqual({ kind: "modbus", register: 19042, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.powerFactorL1).toEqual({ kind: "modbus", register: 19044, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.frequency).toEqual({ kind: "modbus", register: 19050, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.activeEnergySum).toEqual({ kind: "modbus", register: 19060, registerCount: 2, byteOrder: "BIG_ENDIAN" });
  });

  /**
   * Every row is what the device itself reported on 2026-10-09 (ferrion's
   * `docs/janitza-umg801-stromgruppen-2026-10-08.md`, read from the UMG 801
   * on site), not a formula this catalogue invented. The previous version
   * pinned "+100 per module" and stayed green while register 19500 was
   * labelled "Modul 2" and really belonged to module 1's second group.
   */
  const UMG801_GROUPS_FROM_DEVICE = [
    { key: "", label: "Basis IG1", modbus: 19012, opcua: 103240 },
    { key: "group2", label: "Basis IG2", modbus: 19200, opcua: 113240 },
    { key: "group3", label: "Basis IG3", modbus: 19300, opcua: 123240 },
    { key: "module1Group1", label: "Modul 1 IG1", modbus: 19400, opcua: 1007240 },
    { key: "module1Group2", label: "Modul 1 IG2", modbus: 19500, opcua: 1017240 },
    { key: "module2Group1", label: "Modul 2 IG1", modbus: 19600, opcua: 1107240 },
    { key: "module2Group2", label: "Modul 2 IG2", modbus: 19700, opcua: 1117240 },
    { key: "module3Group1", label: "Modul 3 IG1", modbus: 19800, opcua: 1207240 },
    { key: "module3Group2", label: "Modul 3 IG2", modbus: 19900, opcua: 1217240 },
  ];

  it("Janitza UMG 801 Modbus TCP: every current group sits where the device says it does", () => {
    const template = getDeviceTemplate("janitza-umg801-modbus-tcp");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));

    for (const { key, label, modbus } of UMG801_GROUPS_FROM_DEVICE) {
      const currentKey = key === "" ? "currentL1" : `${key}CurrentL1`;
      expect(byMetric[currentKey], `${label} Strom L1`).toEqual({
        kind: "modbus",
        register: modbus,
        registerCount: 2,
        byteOrder: "BIG_ENDIAN",
      });
    }

    // The offsets inside one group block: P +14, S +22, Q1 +30, WP +44.
    expect(byMetric.module1Group2ActivePowerSum).toEqual({ kind: "modbus", register: 19514, registerCount: 2, byteOrder: "BIG_ENDIAN" });
    expect(byMetric.module1Group2ActiveEnergySum).toEqual({ kind: "modbus", register: 19544, registerCount: 2, byteOrder: "BIG_ENDIAN" });

    expect(template.metrics.length).toBe(14 + (2 + 20 * 2) * 7);
  });

  it("Janitza UMG 801 OPC UA: has a moduleProbe for live module-count discovery, verified live against a real unit's Modules folder", () => {
    const template = getDeviceTemplate("janitza-umg801-opcua");
    expect(template.moduleProbe).toEqual({ kind: "opcua-browse", modulesFolderNodeId: 999000, maxModuleCount: 20 });
  });

  it("Janitza UMG 801 Modbus TCP: has no moduleProbe - reading a non-fitted module's registers returns a plausible-looking value instead of an error, so live detection isn't reliable over this protocol", () => {
    const template = getDeviceTemplate("janitza-umg801-modbus-tcp");
    expect(template.moduleProbe).toBeUndefined();
  });

  it("Janitza UMG 801 OPC UA: Node IDs verified live against 5 real units (no vendor documentation exists for this protocol)", () => {
    const template = getDeviceTemplate("janitza-umg801-opcua");
    expect(template.namespaceUriTemplate).toBe("https://opc.janitza.de/umg801/public");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));
    expect(byMetric.frequency).toEqual({ kind: "opcua", nodeIdentifier: 131100 });
    expect(byMetric.voltageL1N).toEqual({ kind: "opcua", nodeIdentifier: 135600 });
    // `IRms` in amperes, not `ILoad` in percent - that is the defect this
    // catalogue shipped with, and all twelve current sources on the
    // production instance hold percentages because of it.
    expect(byMetric.currentL1).toEqual({ kind: "opcua", nodeIdentifier: 103240 });
    expect(byMetric.activePowerSum).toEqual({ kind: "opcua", nodeIdentifier: 101260 });
    expect(byMetric.apparentPowerSum).toEqual({ kind: "opcua", nodeIdentifier: 101380 });
    // Q1, the same quantity Modbus reads - it used to be the total Q here.
    expect(byMetric.reactivePowerSum).toEqual({ kind: "opcua", nodeIdentifier: 101360 });
    expect(byMetric.powerFactorL1).toEqual({ kind: "opcua", nodeIdentifier: 103360 });
    expect(byMetric.activeEnergySum).toEqual({ kind: "opcua", nodeIdentifier: 102505 });
  });

  it("Janitza UMG 801 OPC UA: every current group sits where the device says it does", () => {
    const template = getDeviceTemplate("janitza-umg801-opcua");
    const byMetric = Object.fromEntries(template.metrics.map((m) => [m.metricKey, m.addressing]));

    for (const { key, label, opcua } of UMG801_GROUPS_FROM_DEVICE) {
      const currentKey = key === "" ? "currentL1" : `${key}CurrentL1`;
      expect(byMetric[currentKey], `${label} Strom L1`).toEqual({ kind: "opcua", nodeIdentifier: opcua });
    }

    // The formula at the far end: module 20 group 2 = 1004000 + 19*100000 + 10000.
    expect(byMetric.module20Group2CurrentL1).toEqual({ kind: "opcua", nodeIdentifier: 2917240 });
    expect(byMetric.module20Group2ActiveEnergySum).toEqual({ kind: "opcua", nodeIdentifier: 2916505 });
    expect(template.metrics.length).toBe(14 + (2 + 20 * 2) * 7);
  });
});

describe("getDeviceTemplate", () => {
  it("throws for an unknown id", () => {
    // @ts-expect-error - deliberately passing an invalid id to test the runtime guard
    expect(() => getDeviceTemplate("unknown-device")).toThrow(/Unknown device template id/);
  });
});

describe("DS1 catalog completeness", () => {
  it("serves every metric the DS1 actually reports", () => {
    // Found live: the gateway listed three of the eight while the platform's
    // own catalog listed all eight. A data source created for one of the
    // missing five would have been polled from a register this gateway never
    // served, and would have sat empty with nothing to explain why.
    const ds1 = Object.values(DEVICE_TEMPLATES).find((template) => template.model === "DS1 (Modbus TCP)");

    expect(ds1?.metrics.map((metric) => metric.metricKey).sort()).toEqual(
      [
        "absoluteHumidity",
        "atmosphericDewPoint",
        "dewPoint",
        "moistureContent",
        "relativeHumidity",
        "temperature",
        "vaporRatio",
        "waterVaporPartialPressure",
      ].sort()
    );
  });

  it("gives each DS1 metric its own register", () => {
    // Two metrics sharing a register would silently report the same number
    // under two names.
    const ds1 = Object.values(DEVICE_TEMPLATES).find((template) => template.model === "DS1 (Modbus TCP)");
    const registers = ds1!.metrics.map((metric) =>
      metric.addressing.kind === "modbus" ? metric.addressing.register : null
    );

    expect(new Set(registers).size).toBe(registers.length);
  });
});
