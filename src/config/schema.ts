import { z } from "zod";

// Kept here (not in device-catalog) as the single source of truth so
// config validation doesn't depend on the catalog module - device-catalog
// imports this type back instead of the other way around.
export const DEVICE_TEMPLATE_IDS = [
  "aventics-af2-opcua",
  "aventics-af2-mqtt",
  "aventics-ds1-modbus-tcp",
  "keyence-fd-g-modbus-tcp",
  "janitza-umg801-modbus-tcp",
  "janitza-umg801-opcua",
] as const;

export type DeviceTemplateId = (typeof DEVICE_TEMPLATE_IDS)[number];

const deviceTemplateIdSchema = z.enum(DEVICE_TEMPLATE_IDS);

export const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

// FG_LOG_LEVEL was documented in .env.example and read by nothing (review
// 2026-09, M-5) - the container ran every instance at "info" with no way
// down. An unknown value falls back to "info" rather than refusing to
// start over a typo in an environment variable.
export function envLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const parsed = logLevelSchema.safeParse(env.FG_LOG_LEVEL);
  return parsed.success ? parsed.data : "info";
}

// http(s) only and no userinfo: z.url() alone accepts `javascript:`,
// `ftp:` and `user:pass@host`, none of which is a ferrion the API key
// should ever be sent to (review 2026-09, M-12). Shared by the file
// configs here and the control-plane's PUT /api/settings.
export const ferrionBaseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => {
    // zod runs refinements even after the url check failed, so this must
    // not throw on a non-URL - it only has to add nothing new then.
    try {
      const parsed = new URL(value);
      return parsed.username === "" && parsed.password === "";
    } catch {
      return true;
    }
  }, "baseUrl must not carry credentials");

// Strict objects throughout the *file* configs: a misspelt key
// (`readingIntervalMS`) used to be dropped silently, the default applied,
// and the operator left wondering why the setting had no effect (review
// 2026-09, M-12). The HTTP routes keep their own, stripping schemas.
export const deviceSchema = z.strictObject({
  templateId: deviceTemplateIdSchema,
  serialNumber: z.string().min(1),
});

export const portsSchema = z.strictObject({
  opcua: z.number().int().min(1).max(65535).optional(),
  modbus: z.number().int().min(1).max(65535).optional(),
  mqtt: z.number().int().min(1).max(65535).optional(),
});

// "last" is closest to pre-aggregation behavior; avg/min/max smooth a fast
// readingIntervalMs (down to 1ms) over the window between pushes instead of
// just reporting whichever sample happened to land last - see
// gateway/reading-aggregator.ts.
export const aggregationStrategySchema = z.enum(["last", "avg", "min", "max"]);
export type AggregationStrategy = z.infer<typeof aggregationStrategySchema>;

// readingsPushIntervalMs has a floor: the 1 ms range is meant for *reads*
// (see the aggregator); pushing more often than once a second would only
// run into ferrion's own rate limit (10 pushes per 5 s per gateway).
export const MIN_PUSH_INTERVAL_MS = 1000;

export const pollingSchema = z.strictObject({
  commandsIntervalMs: z.number().int().positive().default(3000),
  dataSourcesIntervalMs: z.number().int().positive().default(15000),
  readingIntervalMs: z.number().int().positive().default(5000),
  readingsPushIntervalMs: z.number().int().min(MIN_PUSH_INTERVAL_MS).default(5000),
  aggregation: aggregationStrategySchema.default("last"),
});

// "Set once, rarely retuned" hardening knobs - unlike pollingSchema's
// fields, not exposed in the Web UI's "Erweitert" section (see
// control-plane/routes.ts's toInstanceConfig()).
export const resilienceSchema = z.strictObject({
  // http-client.ts's AbortSignal.timeout() - bounds how long a single
  // stalled-but-not-erroring request to ferrion can block a loop tick.
  httpRequestTimeoutMs: z.number().int().positive().default(10_000),
  // gateway/reading-buffer.ts's ReadingBuffer maxSize - how many unsent
  // readings survive a ferrion outage before the oldest start getting
  // evicted (see ReadingLoop's eviction warning for when that happens).
  // 10_000 gives real headroom for a planned ferrion platform update: at
  // the default 5s push interval, the buffer holds one entry per tracked
  // data source per failed push cycle, so this many entries covers ~40
  // minutes of full-fidelity buffering with today's ~39 production data
  // sources (10_000 / 39 push-cycles-worth * 5s) - comfortably past any
  // update this app has actually needed live so far, while still bounded
  // (a genuinely multi-hour-or-longer outage still degrades gracefully to
  // oldest-evicted rather than unbounded memory growth). With the push
  // backoff (reading-loop.ts) the cadence during an outage stretches to
  // a minute, so the same buffer then covers longer, more coarsely.
  //
  // Capped at ferrion's own per-push limit (MAX_READINGS_PER_PUSH in its
  // readings route): a larger buffer would just be evicted-from earlier
  // than it filled, and the loop pushes in batches of at most 5 000 anyway
  // (reading-loop.ts MAX_PUSH_BATCH).
  readingBufferMaxSize: z.number().int().positive().max(25_000).default(10_000),
});
export type Resilience = z.infer<typeof resilienceSchema>;

export const instanceConfigSchema = z.strictObject({
  instanceName: z.string().min(1).max(64),
  ferrion: z.strictObject({
    baseUrl: ferrionBaseUrlSchema,
    apiKey: z.string().min(1),
    rejectUnauthorized: z.boolean().default(true),
  }),
  // Absent for a bridge-only instance - one that only bridges real
  // hardware whose connection details live entirely in ferrion's own
  // data-source config (fetched via GET /api/gateway/data-sources), with
  // no locally-simulated device at all. See app.ts's startInstance() for
  // where this optionality actually takes effect.
  device: deviceSchema.optional(),
  ports: portsSchema.prefault({}),
  polling: pollingSchema.prefault({}),
  resilience: resilienceSchema.prefault({}),
  logLevel: logLevelSchema.default(envLogLevel()),
  // Whether this instance discovers/reads/pushes whatever data sources
  // ferrion assigns to its (shared-per-gateway) API key at all. Defaults
  // to true so a standalone (`npm run dev`) or fleet-launched simulated
  // instance stays fully self-contained, exactly as before this field
  // existed. The control-plane is the one place this is set to false
  // (see control-plane/routes.ts's toInstanceConfig()): every
  // control-plane deployment also always runs the bridge singleton under
  // the same API key, so a simulated instance's own reading loop would
  // otherwise redundantly re-discover and re-push the exact same data
  // sources the bridge already handles - confirmed live as the actual
  // cause of near-duplicate, irregularly-spaced readings for one data
  // source (multiple instances each pushing the same underlying value
  // within milliseconds of each other), which in turn broke the "Daten"
  // tab chart's gap-highlighting (its median-based detector mistook the
  // resulting irregular cadence for real gaps).
  runReadingLoop: z.boolean().default(true),
});

export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
export type Ports = z.infer<typeof portsSchema>;

// Fleet entries reference an env var for the API key (never embed it
// directly) so fleet.config.json can be committed without leaking secrets.
export const fleetEntrySchema = z.strictObject({
  instanceName: z.string().min(1).max(64),
  apiKeyEnvVar: z.string().min(1),
  // See instanceConfigSchema's own device field for why this is optional.
  device: deviceSchema.optional(),
  ports: portsSchema.optional(),
});

export type FleetEntry = z.infer<typeof fleetEntrySchema>;

export const fleetConfigSchema = z
  .strictObject({
    ferrion: z.strictObject({
      baseUrl: ferrionBaseUrlSchema,
      rejectUnauthorized: z.boolean().default(true),
    }),
    polling: pollingSchema.prefault({}),
    resilience: resilienceSchema.prefault({}),
    logLevel: logLevelSchema.default(envLogLevel()),
    instances: z.array(fleetEntrySchema).min(1),
  })
  // Two entries with one name would share a reading-buffer file and
  // overwrite each other; two explicit ports on one protocol would fight
  // for the socket. Both are operator mistakes worth refusing at load
  // time rather than as EADDRINUSE two seconds later.
  .superRefine((fleet, ctx) => {
    const names = new Set<string>();
    const explicitPorts = new Map<string, string>();
    fleet.instances.forEach((entry, index) => {
      if (names.has(entry.instanceName)) {
        ctx.addIssue({ code: "custom", path: ["instances", index, "instanceName"], message: `duplicate instanceName "${entry.instanceName}"` });
      }
      names.add(entry.instanceName);
      for (const [kind, port] of Object.entries(entry.ports ?? {})) {
        if (port === undefined) continue;
        const key = `${kind}:${port}`;
        const holder = explicitPorts.get(key);
        if (holder !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["instances", index, "ports", kind],
            message: `port ${port} (${kind}) is already given to "${holder}"`,
          });
        }
        explicitPorts.set(key, entry.instanceName);
      }
    });
  });

export type FleetConfig = z.infer<typeof fleetConfigSchema>;
