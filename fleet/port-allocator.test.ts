import { describe, expect, it } from "vitest";
import type { DeviceTemplateId } from "../src/config/schema.js";
import { allocatePorts, nextFreePort } from "./port-allocator.js";

describe("allocatePorts", () => {
  it("assigns sequential ports per protocol, independent of the others", () => {
    const templateIds: DeviceTemplateId[] = ["aventics-af2-opcua", "aventics-af2-opcua", "aventics-ds1-modbus-tcp"];
    const ports = allocatePorts(templateIds);
    expect(ports).toEqual([{ opcua: 4840 }, { opcua: 4841 }, { modbus: 5502 }]);
  });

  it("never assigns the same port twice across a dozen mixed-protocol instances", () => {
    const templateIds: DeviceTemplateId[] = Array.from({ length: 12 }, (_, i) => {
      const options: DeviceTemplateId[] = ["aventics-af2-opcua", "aventics-af2-mqtt", "aventics-ds1-modbus-tcp"];
      return options[i % options.length] as DeviceTemplateId;
    });

    const ports = allocatePorts(templateIds);
    const allPorts = ports.flatMap((p) => Object.values(p));

    expect(allPorts).toHaveLength(12);
    expect(new Set(allPorts).size).toBe(12);
  });

  it("each returned entry only sets the port field for its own protocol", () => {
    const ports = allocatePorts(["aventics-af2-mqtt"]);
    expect(ports[0]).toEqual({ mqtt: 1883 });
  });

  it("returns an empty object at its own position for an undefined entry, without consuming a protocol slot", () => {
    const templateIds: (DeviceTemplateId | undefined)[] = ["aventics-af2-opcua", undefined, "aventics-af2-opcua"];

    const ports = allocatePorts(templateIds);

    expect(ports).toEqual([{ opcua: 4840 }, {}, { opcua: 4841 }]);
  });

  it("preserves index alignment for an all-undefined input", () => {
    expect(allocatePorts([undefined, undefined])).toEqual([{}, {}]);
  });
});

describe("nextFreePort", () => {
  it("takes the smallest free port of the template's protocol, judged by ports actually held", () => {
    expect(nextFreePort("aventics-ds1-modbus-tcp", [])).toEqual({ modbus: 5502 });
    expect(nextFreePort("aventics-ds1-modbus-tcp", [{ modbus: 5502 }, { modbus: 5503 }])).toEqual({ modbus: 5504 });
    // The gap a deletion left is reused; the remaining instance keeps 5503.
    expect(nextFreePort("aventics-ds1-modbus-tcp", [{ modbus: 5503 }])).toEqual({ modbus: 5502 });
    // Other protocols' ports and bridge records ({}) do not count.
    expect(nextFreePort("aventics-af2-opcua", [{ modbus: 5502 }, {}, { opcua: 4840 }])).toEqual({ opcua: 4841 });
  });
});
