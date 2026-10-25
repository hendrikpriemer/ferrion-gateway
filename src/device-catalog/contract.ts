import type { DeviceTemplate } from "./known-device-templates.js";

// The protocol-neutral view of a device template that both repositories
// must agree on: which metrics a device has, in which unit, at which
// address. Labels, manufacturer/model strings and the gateway-only
// `kind` discriminator are deliberately left out - they may differ or
// evolve on one side without the sensors reading differently.
//
// The same view lives as JSON in device-templates.contract.json here and
// in ferrion (src/lib/device-templates.contract.json); each side's test
// checks its own catalog against its copy of the file, and the two copies
// are meant to be byte-identical. Drift was real before this existed
// (review 2026-09, N-19): the AF2 MQTT jsonFieldFallbacks had diverged
// with nothing to say so.
export interface ContractMetric {
  metricKey: string;
  unit: string;
  addressing: Record<string, unknown>;
}

export interface ContractTemplate {
  id: string;
  protocol: string;
  namespaceUriTemplate?: string;
  metrics: ContractMetric[];
}

function sortedKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) as T;
}

export function contractView(templates: readonly DeviceTemplate[]): ContractTemplate[] {
  return [...templates]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((template) => ({
      id: template.id,
      protocol: template.protocol,
      ...(template.namespaceUriTemplate ? { namespaceUriTemplate: template.namespaceUriTemplate } : {}),
      metrics: template.metrics.map((metric) => {
        // `topic` is left out for MQTT as well: here it is the placeholder
        // the local simulator publishes on ("af2/processdata"), in ferrion
        // the real per-device topic is typed into the wizard and the
        // catalog carries none - the one legitimate structural difference.
        const { kind: _kind, ...rest } = metric.addressing;
        const addressing: Record<string, unknown> = { ...rest };
        if (metric.addressing.kind === "mqtt") delete addressing.topic;
        return { metricKey: metric.metricKey, unit: metric.unit, addressing: sortedKeys(addressing) };
      }),
    }));
}
