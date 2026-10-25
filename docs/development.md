# Development

Setting up a development environment, the ways to run the gateway, the
simulated devices, and how it is tested.

## Requirements

- Node.js 22.13 or later (`engines` in `package.json`)
- npm
- Docker with Compose, for the container image and the local fleet
- A ferrion installation to report to, with a gateway created under
  **Settings → Gateways**. Without one, simulated devices still run, but nothing
  is reported.

```sh
npm install        # also installs the git hooks (version bump, checks)
npm test
npm run typecheck
npm run lint
```

## Simulated devices

Simulated devices are a permanent part of the gateway, not throwaway test
tooling. Each simulated instance runs a real protocol server (an OPC UA server,
a Modbus TCP server, or an MQTT broker with a publisher) and the same reader
code that reads real hardware. Only `src/drivers/simulated/` is simulation
specific; `src/protocol/*/gateway-client.ts` and `src/gateway/` are the
production code.

| Template | Protocol | Simulates |
| --- | --- | --- |
| AVENTICS AF2 | OPC UA, MQTT | Compressed-air flow sensor (flow, pressure, temperature, consumption) |
| AVENTICS DS1 | Modbus TCP | Pressure sensor |
| Keyence FD-G | Modbus TCP | Flow sensor |
| Janitza UMG 801 | OPC UA, Modbus TCP | Power analyser with current groups |

Values come from a seeded generator bounded to each device's real measuring
range, so a run is reproducible. Start one from the web UI (**+ Add
instance**), copy its connection info into ferrion's "Add data source" dialog
together with the matching "… (Simulation)" template, and the asset shows live
values within seconds.

## The bridge in detail

The bridge instance never simulates anything - it just runs the same
discovery/read/push loop, driven entirely by whatever data sources
ferrion assigns to this gateway's API key. There's no step 6 equivalent
on the gateway side: in ferrion's own "Add data source" dialog,
pick the *real* device template (not a "… (Simulation)" one - those start
with blank connection fields) and enter the sensor's actual IP/port on
your network. As soon as ferrion has that data source assigned to this
gateway, the bridge instance picks it up on its next discovery cycle
(`dataSourcesIntervalMs`, default 15s) with no further gateway-side
configuration. Its card lists every data source it's currently bridging
(name, protocol, host, and a live/stale/error status per source, derived
from `reading-loop.ts`'s own read outcomes).

The bridge is a **control-plane-managed singleton**, not something
created through the form: `GET /api/gateway/data-sources` is scoped by
gateway API key, not by local instance, so every running instance under
the same key would otherwise redundantly double-connect to the same real
hardware. The control-plane creates it automatically on first boot if it
doesn't already exist, always starts it, and its card has no Stop/Edit/
Delete controls - only Start, in case its process ever needs a manual
kick (it also auto-restarts itself a few seconds after an unexpected
crash on its own, see `process-manager.ts`'s `keepAlive` option).

## Headless fleet launcher

For scripted/CI-style bulk starts without the Web UI:

```sh
cp fleet.config.example.json fleet.config.json
# edit fleet.config.json, then set the referenced env vars:
export FG_KEY_AF2_OPCUA_1=gw_...
export FG_KEY_AF2_MQTT_1=gw_...
export FG_KEY_DS1_MODBUS_1=gw_...
npm run fleet -- fleet.config.json
```

Real API keys are never committed - `fleet.config.json` only references
env var *names*, resolved at launch time. Ports are auto-assigned per
protocol (`basePort + index within that protocol`, see
`fleet/port-allocator.ts`) unless overridden per instance. A fleet entry
can also be bridge-only - omit `device` entirely, as
`fleet.config.example.json`'s own `bridge-1` entry does - and it's
simply skipped by port allocation instead of consuming a slot.

## Single instance, no fleet/UI

```sh
cp config/instances/example.instance.json config/instances/my-instance.json
# edit it with a real ferrion API key
npm run dev -- config/instances/my-instance.json
```

For a bridge-only instance (see "Bridging real hardware" above), start
from `config/instances/example-bridge.instance.json` instead - it has no
`device`/`ports` fields at all.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev -- <config.json>` | Runs one instance directly (`src/index.ts`) |
| `npm run start:control-plane` | Starts the Web UI + local backend on port 4000 |
| `npm run fleet -- <fleet.json>` | Headless bulk-start from a fleet config |
| `npm test` | Runs the unit test suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with typescript-eslint's type-checked rules (also a CI step) |
| `npm run check:data [dir]` | Would the persisted `data/` still load under this version? Run it against the *new* image before replacing a running container — see [deployment.md](deployment.md) |

## Docker / FLECS / Margo

```sh
docker compose up -d --build
```

**Updating an existing deployment is not just this command** — a `git pull`
alone leaves the old image running, and the persisted `data/` directory has
to be checked against the new version's schemas before the switch, or the
control plane can come up `healthy` with no instances at all.
[deployment.md](deployment.md) has the full procedure: back up,
build, check, switch, verify, roll back.

Starts the control-plane on <http://127.0.0.1:4000> (published to
`127.0.0.1` only, not `0.0.0.0` - see `docker-compose.yml`'s comments on
why this is where the "local machine only, no auth" trust boundary now
lives, since the app itself has to bind `0.0.0.0` *inside* the container
for Docker's port publishing to reach it at all - `FG_BIND_HOST` controls
this). `data/instances.json`/`data/settings.json` persist in the
`ferrion-gateway-data` named volume across restarts. Each simulated
protocol also gets a small published port range (10 slots), since every
new instance of the same protocol takes the next port up - see the
compose file if you need more than that.

`margo.yaml` at the repo root is a [Margo](https://margo.org) Application
Description ([spec](https://github.com/margo/specification)) describing
this as a Compose-deployable app, so it can be onboarded onto a
FLECS-managed edge device (or any other Margo-compliant device) the same
way as any other app - its `packageLocation` points directly at
`docker-compose.yml`. Not yet published to any FLECS/Margo catalog; add a
real `resources/icon.png` etc. before actually submitting it.

**If ferrion itself runs natively on the host (not in Docker)**, set the
ferrion connection's base URL to `https://host.docker.internal:3000`, not
`https://localhost:3000` - inside the container, `localhost` means "this
container", not "the host machine", the same reachability distinction as
`FG_BIND_HOST` above but in the opposite direction. The connection status
indicator (see "Connection status" below) will show "Unreachable" if this
is set wrong.

## Disclosed simplification: AF2 flow-rate ranges

`temperature`/`pressure` for the simulated AF2 use real `EURange` values
from its own OPC UA NodeSet2 export. No real measuring-range datasheet was
available for `massFlowRate`/`volumetricFlowRate` (the NodeSet2's own
`EURange` nodes for these two are unpopulated), so
`src/drivers/simulated/devices/af2-values.ts` uses a clearly-commented,
plausible-but-not-manual-verified placeholder range for those two metrics
only. Replace it there if a real AF2 datasheet with flow-rate specs
becomes available.

## Testing strategy

Unit tests target pure logic that's worth getting right (float32 codec,
value-range generators, port allocation, config validation, the reading
buffer's dedup/requeue behavior, the HTTP client against a real local
test server including a TLS case) - not a 1:1 copy of ferrion's
100%-coverage rule. The real `node-opcua`/`modbus-serial`/`aedes`/`mqtt`
server↔client wiring is deliberately **not** unit-tested; it's exercised
by actually running instances end-to-end via the Web UI (see "Quick
start" above).

## Before a pull request

`npm test`, `npm run typecheck` and `npm run lint` must pass; CI runs the same.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for the rest.
