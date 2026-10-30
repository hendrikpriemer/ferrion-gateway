# Margo and FLECS compatibility

Status as of 2026-10-30. Tracked in
[ferrion#814](https://github.com/hendrikpriemer/ferrion/issues/814).

**Short answer: packageable for FLECS since 2026-10-30, not yet deployable.**
The gateway was built to fit a Margo device (one image, Compose-deployable,
named volume only, non-root, health check, Apache-2.0 with NOTICE, signed
release images). Since 2026-10-30 the repository carries a BART package
(`app/`, `compose/`, section 7): `bart validate` passes every check and
`bart package` produces the catalog and components artifacts. What remains:
release images exist for `amd64` only, the control-plane UI has no login and
stays on the device's loopback, and nothing has run on a FLECS device or
through `bart push`. The sections below say exactly what each target demands,
where the gateway stands, and in which order the gaps should be closed.

Both targets are moving: the Margo specification is a pre-draft (Preview
Release 3, tags `v1.0.0-rc.3`), FLECS's packaging tool BART is in public beta,
and the FLECS Device Client is "still in development; interfaces and commands
may change". Re-check the sources before building against them.

## 1. What the targets demand

### Margo (specification, Preview Release 3)

Source: <https://docs.margo.org/> → Specification → Applications
(`application-description`, `application-registry`), 2026-10-30.

- **ApplicationDescription:** `apiVersion: v1`, no `kind`. Top-level `id`
  (lowercase letters, digits, dashes, max 200). `metadata.name`,
  `metadata.version` and `metadata.catalog.organization[].name` are required;
  `catalog.application` (`descriptionFile`, `icon`, `licenseFile`,
  `releaseNotes`, `site`, `tagline`, `tags`) and `catalog.author` are optional.
- **Deployment profiles:** `type` is `compose`, `helm` or `custom`; each
  component has `name` and `properties.repository` (an `oci://` reference) plus
  `properties.revision` (SemVer 2.0 without a leading `v`), optionally `wait`
  and `timeout`. Resource needs live under
  `deviceConstraints.capacityRequirements` (`cpu.cores`, `cpu.architectures`
  from `amd64`/`arm64`/`arm`, `memory`, `storage`).
- **Parameters and configuration:** `parameters.<name>.targets[].pointer` is
  an environment variable name for Compose components; `configuration.sections`
  and `configuration.schema` describe the operator form (string, integer,
  double, boolean, select).
- **Compose component as OCI artifact:** a gzip-compressed tar with exactly one
  top-level directory that contains a file named `compose.yaml` (the names
  `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` are invalid),
  plus any `env_file` and file-sourced `configs` as relative paths. No
  bind-mount paths, no file-sourced `secrets`, no absolute paths or `../`, no
  symlinks leaving the directory. Pushed with `oras push` (not
  `docker compose publish`) with `artifactType`
  `application/vnd.org.margo.component.compose+json`, layer media type
  `application/vnd.org.margo.component.compose.tar+gzip`, and the annotations
  `org.margo.component.type=compose` and `org.margo.component.version=<semver>`
  matching the OCI tag and `revision`.
- **Devices** verify the SHA-256 digest of every artifact before a workload
  starts; with `wait: true` all containers must be running, waiting for
  `healthy` is recommended where health checks exist.

### FLECS (Margo compatibility, BART, Device Client)

Sources: <https://docs.flecs.tech/foundation/margo/>,
<https://docs.flecs.tech/engineering/app-publishing-guide/bart/>,
<https://docs.flecs.tech/device-client/>,
<https://docs.flecs.tech/engineering/app-publishing-guide/app-publishing-packages/>,
2026-10-30.

- FLECS implements Margo across the five lifecycle phases of Margo PR1 and
  contributes to later releases. Apps that run through the FLECS Fleet Manager
  **must** be built and published with **BART**; classic (non-Margo) FLECS apps
  use `manifest.json` and a different guide.
- **BART project layout:** `app/margo.yaml`, `app/icon.png` (`.png`, `.jpg`,
  `.jpeg`, `.svg` allowed), `app/release-notes.md` (`.md`, `.pdf`),
  `compose/compose.yaml` with any config/env files beside it, optionally
  `src/<service>/Dockerfile`.
- **BART's `margo.yaml`:** API version `margo/v1alpha1`, top-level `id`,
  `metadata.version` is injected at package time (`"0.0.0"` placeholder),
  `deploymentProfiles[]` with `type`, `id`, `components` and
  `requiredResources.cpu.architectures` (at least one of `amd64`, `arm64`,
  `arm`, `riscv64`). Catalog files: `icon`, `releaseNotes`, `descriptionFile`
  (`.md`), `licenseFile` (`.txt`, `.md`, `.pdf`). Note that this schema differs
  from Margo PR3 above (`requiredResources` vs. `deviceConstraints`,
  `margo/v1alpha1` vs. `v1`); BART validates against its own version.
- **Compose rules (`bart validate`, 17 offline checks):** forbidden are
  `build:`, bind-mount volumes (`/`, `./`, `../`), `container_name:`,
  `network_mode: host`, `privileged: true`, `pid: host`. `env_file:` is
  allowed if the file is in `compose/`. Every `${VAR}` in the Compose file
  needs a matching parameter target and every target must be used (checks
  V15/V16).
- **Pipeline:** `bart validate` → `bart build` (buildx, `linux/<arch>` per
  declared architecture) → `bart package` → `bart push` (staging registry,
  default `apps.flecs.tech`) → `bart release --app <id> --version <semver>` →
  `bart sign … --key <KEY>` (cosign with a key). Versions are SemVer and come
  from a git tag on a clean `HEAD` by default.
- **Device Client:** checks for an OCI runtime, the expected CPU architecture
  and a Compose-capable orchestrator before it registers; devices authenticate
  with X.509 certificates; operators replicate approved versions into an
  on-premises registry (Harbor in the Fleet Manager).
- **Publishing packages:** Free (public GitHub repository provided by FLECS,
  up to 10 users, releases by git tag), Medium (private repository, FLECS image
  registry, commercial apps), Enterprise. Access is requested through the FLECS
  contact page with company, package, app name and GitHub users.

## 2. Where the gateway stands

| # | Requirement | Gateway today | Gap |
| --- | --- | --- | --- |
| 1 | Application description in the current schema | `app/margo.yaml` in BART's `margo/v1alpha1` shape: top-level `id`, `kind`, component `repository`/`revision` as placeholders, `requiredResources` with `memory`, `storage` and `interfaces` (all valid in BART's schema); V01 passes | **Done 2026-10-30.** Margo PR3 itself (`apiVersion: v1`, `deviceConstraints`) differs; follow BART, which is what FLECS devices consume |
| 2 | No `build:` in Compose | `compose/compose.yaml` references `ghcr.io/hendrikpriemer/ferrion-gateway:v0.1.65`; the root `docker-compose.yml` keeps `build:` for development | **Done.** The referenced tag must exist in ghcr.io when `bart push` mirrors it, i.e. after the first regular release ([releases.md](releases.md)) |
| 3 | Package layout and file name | `app/` (margo.yaml, icon.svg, release-notes.md, description.md, license.txt) and `compose/compose.yaml`; `bart package` writes the catalog, a components tarball with `compose/compose.yaml` as its single top-level directory, and the image manifest | **Done** |
| 4 | Every `${VAR}` has a parameter | `controlPlanePort`, `discoveryAllowedCidrs` and `logLevel` target `FG_CONTROL_PLANE_PORT`, `FG_DISCOVERY_ALLOWED_CIDRS` and `FG_LOG_LEVEL`, with an operator form under `configuration`. Pointers are the bare variable names: BART compares them verbatim, an `ENV.` prefix fails V15 and V16 | **Done.** `FG_BIND_HOST` is a fixed value, not a variable |
| 5 | No bind mounts, `container_name`, `privileged`, `pid: host`, host network | Compliant: one named volume, nothing else; `network_mode: host` is only a commented alternative | Keep. Consequence: on a Margo device the gateway always runs on a bridge network, so device discovery works only within what that network reaches ([device-discovery.md](device-discovery.md)) |
| 6 | Icon, release notes, licence, description | All four under `app/` and declared in the catalog. `license.txt` is a copy of `LICENSE`, because BART requires a file extension and a path inside `app/`; `description.md` is a short marketplace text, not the README | **Done.** `app/release-notes.md` is written by hand per release; the GitHub release keeps the generated full list |
| 7 | Images for the declared architectures | `app/margo.yaml` declares `amd64` only, matching `release.yml`, which builds without `platforms` | Add a multi-arch build (QEMU; check the `@serialport/bindings-cpp` musl `arm64` prebuild), then list `arm64` too. BART builds and mirrors one image per listed architecture, and most edge devices are `arm64` |
| 8 | Version | `metadata.version` and the component `revision` are `0.0.0` placeholders; BART injects the version from the git tag on `HEAD` or `--version` (a `v` prefix is accepted and stored without it) | **Done** |
| 9 | Signing | Release images are signed keyless with Sigstore ([releases.md](releases.md)) | BART signs with its own cosign key as a second step; when FLECS replicates the image into an on-premises registry, the Sigstore signature does not travel unless copied. Decide whether both signatures are kept |
| 10 | Operator access to the UI | The control plane has no authentication and is published on `127.0.0.1` of the host only; inside the container it binds `0.0.0.0` | FLECS routes app UIs (`editors`) through its reverse proxy but does **not** put its own login in front of them (section 5). On a headless edge device the operator could not reach the UI, and publishing it on the device network would expose an unauthenticated API that holds the ferrion API key. **The control plane needs its own login, built on the device's identity provider (OIDC), before any Margo deployment** – the largest functional gap; see section 5 and ferrion#1051 |
| 11 | Health and start-up | `HEALTHCHECK` on `/api/health`, `init: true`, `stop_grace_period`, log-size limits | Compliant; none of these settings is on BART's forbidden list |
| 12 | Resource needs | 0.5 cores, 512 Mi memory, 512 Mi storage, `interfaces: ethernet` under `requiredResources` | **Done** |
| 13 | End-to-end test on a device | `bart validate` and `bart package` run clean in a container (section 7); nothing has run on a FLECS device or through `bart push` | `bart push` and the Device Client need a FLECS publishing package |

## 3. Suggested order

1. Restructure for BART (`app/`, `compose/`), rewrite `margo.yaml`, add the
   missing parameters, run `bart validate` until clean: **done 2026-10-30**
   (section 7), no runtime change.
2. Switch the packaged Compose file to the signed release image: **done**
   (`compose/compose.yaml`); the tag it names must exist before `bart push`.
3. Build release images for `linux/amd64` and `linux/arm64`; verify the
   serial-port native module on `arm64`.
4. Add icon and release notes to the package: **done**; keep
   `app/release-notes.md` current with each release.
5. Give the control plane an OIDC login that uses the device's identity
   provider (section 5, ferrion#1051); ferrion#1030 covers the ferrion-facing
   side.
6. Request a FLECS publishing package and run `bart push` to staging; test with
   the Device Client once it is generally available.

## 4. What already holds, independent of the packaging

One image from a single `Dockerfile`, non-root user, outbound-only connection
to ferrion, field devices only read, data in one named volume, CycloneDX SBOM,
Apache-2.0 with a generated NOTICE, signed release images with digest pinning.
These are the properties a Margo device or a FLECS review will look at first,
and they do not depend on the manifest format.

## 5. Users and roles on a FLECS device

Read from the FLECS Core sources and release notes (GitHub mirror
`FLECS-Technologies/flecs-public`, archived 2026-07; current development at
<https://git.flecs.tech/flecs/flecs-core>), the FLECS web app
(`FLECS-Technologies/flecs-webapp`, `src/features/auth/`) and the Core README,
2026-10-30. There is **no developer guide** for this on docs.flecs.tech yet, and
the provider endpoints are tagged *Experimental*; confirm with FLECS before
building against them.

**How FLECS itself authenticates and authorises**

- Since Core `5.0.0-red-deer` (2025-11) the Core API is locked without a
  login. Core is configured with exactly one **auth provider**: either
  **fence**, FLECS's own OAuth 2.0 server (`FLECS_CORE_AUTH_KIND=oauth`, with
  `FLECS_CORE_ISSUER_URL`, `FLECS_CORE_JWK_URL`, `FLECS_CORE_AUTHORIZE_URL`,
  `FLECS_CORE_TOKEN_URL`; since 2026-10-22 run as a system container), or
  **any standard OpenID Connect provider** (`FLECS_CORE_AUTH_KIND=oidc`,
  only `FLECS_CORE_ISSUER_URL`). The product pages list LDAP, Active
  Directory and OpenID Connect as supported identity providers; the setup
  guide currently allows exactly one local super-admin in fence.
- The web app logs in with OAuth 2.0 **authorization code + PKCE**
  (`oauth4webapi`, `client_id: flecs`, scope `api:read` for fence or
  `openid email` for OIDC) and sends the JWT access token as a Bearer token.
  It reads standard OIDC claims plus Keycloak-style role claims
  (`realm_access.roles`, `resource_access.<client>.roles`) from the token.
- Authorisation is **Casbin**: a policy maps permissions such as
  `tech.flecs.core.read_instances` to `GET /v2/instances`, groups (`g`) build
  roles from permissions, and the request subject comes from the token. Policy
  and model are files (`casbin_policy.csv`, `casbin_model.conf`) that an
  operator can replace.

**What that means for an app's own UI**

- App UIs (`editors`) are reached through `GET /v2/instances/{id}/editor/{port}`,
  which is **public in the Casbin policy** (`p,*,…/editor/:port,GET`) and
  answers with a redirect to the app's port or its reverse-proxy location.
  FLECS does not add authentication in front of the app. An app that needs
  users and roles authenticates them itself.
- The configured provider is discoverable: `GET /v2/providers/auth/default`
  (also public) returns the default auth provider with `kind`, `issuer_url`
  and, for fence, `jwk_url`, `authorize_url` and `token_url`, rewritten to the
  host the caller used. Core passes its own address to app containers as the
  gateway of the default network (release note FLX-1116), and the provider's
  URLs are reachable from inside a container (release note "use container ip
  and port to access core auth provider"). The earlier idea that an *app*
  provides the identity provider through its manifest was removed from Core
  on 2026-10-22; the provider is a Core-level setting.

**The pieces behind it, from FLECS's own Forgejo (git.flecs.tech/flecs, 23
repositories, read 2026-10-30)**

- **fence** (Rust, updated daily) is FLECS's OAuth 2.0 server. It issues
  RS256 JWTs (`/meta/jwk`) with `sub`, `exp`, `iss`,
  `aud: ["flecs-core-api", "fence-api"]`, `email`, `preferred_username`,
  `realm_access.roles` and `resource_access.account.roles`; roles are the
  names of the user's **groups** including subgroups (e.g.
  `tech.flecs.core.admin`). It has a user and group API
  (`/users`, `/users/{uid}/roles`, `/users/super-admin`), **machine clients**
  with `client_credentials` by secret or certificate (`/clients`, a client
  gets the roles of its groups), authorization code with PKCE
  (`client_id=flecs`, `scope=admin`), a login page, and its own Casbin policy.
  The docs page that allows "exactly one super-admin" is behind the code.
  Runs as a system container on port 27000; floxy exposes it under `/auth/`.
- **floxy** is the nginx-based reverse proxy in front of the device: `/api/`
  to Core, `/ui/` to the web app, `/auth/` to fence, plus one generated
  `location` per app editor (`proxy_pass` to the instance's IP and port).
  The generated editor locations carry **no `auth_request`**: the proxy does
  not authenticate app UIs, which confirms the point above.
- **picket** ("reading and sharing roles for authentication") is an empty
  stub so far, i.e. a shared roles library for apps is planned, not built.
- **app-manifest 3.x** (classic FLECS apps) carries `provides`, which fence
  uses to announce itself (`provides.auth` with `kind`, `issuer_url`,
  `jwk_url`, `authorize_url`, `token_url`, `port`); Core keeps a generic
  provider/dependency model (`providers`, `depends`) behind the Experimental
  endpoints.
- **Release notes** (repository `release-notes`): 5.3 (July 2026) brought
  the RBAC rework ("roles now inherit permissions from their corresponding
  core roles") and mandatory user creation; 5.4 moved Core configuration to
  `/usr/local/etc/flecsd.d/*.conf` and signs Core and web-app images; 5.5
  (October 2026) adds OpenTelemetry export, passes collector endpoints to
  every Margo workload as environment variables, and lets FILiP install
  headless (`--webapp-version none`) and offline.
- Also there: **filip** (installer, `curl -fsSL install.flecs.tech | bash`, or
  one container with the Docker socket), **wfm-client-rs** (generated client
  for the Margo Workload Fleet Manager API 1.0.0-rc.2), **margo-types-rs**,
  **composers** (the compose parser BART uses), **otel-collector**,
  **console-api**, **net-spider**.

For the gateway this adds one option: besides users logging in through the
browser, the gateway process itself could hold a fence **client** (secret or
certificate) and obtain a token with `client_credentials`, should it ever need
to call the Core API or prove its identity to another app on the device.

**What the gateway should do (ferrion#1051)**

1. Add an optional **OIDC login** to the control plane, generic rather than
   FLECS-specific: issuer URL, client id and scope from the environment
   (`FG_OIDC_ISSUER_URL`, `FG_OIDC_CLIENT_ID`, …), with a FLECS mode that
   fills them from `/v2/providers/auth/default` of the Core host. Standard
   OIDC discovery covers Keycloak, Entra ID, Authentik and fence; nothing in
   the gateway needs to know Casbin.
2. Web UI: authorization code + PKCE in the browser, as the FLECS web app does;
   the control plane verifies the access token against the provider's JWKS
   (`jose`) on every request and keeps no password store of its own.
3. **Roles in the gateway**, mapped from token claims (`realm_access.roles`,
   `resource_access`, or a configurable claim): *viewer* (status, instances,
   logs), *operator* (start/stop instances, run a device search),
   *administrator* (ferrion connection and API key, discovery limit,
   simulated instances). Unknown or missing roles see nothing but the login.
4. Without a configured issuer the gateway keeps today's behaviour (loopback
   only, no login), so a developer's machine does not change. With an issuer
   configured, the control plane may be published on the device network,
   because the same-origin and `Host` guards stay in place and every
   state-changing request now also carries a verified identity.
5. Audit: log user (`sub`, `preferred_username`) and role on every
   state-changing request, so a FLECS operator's audit trail continues into
   the gateway.

This closes gap 10 of the table above and is a precondition for any Margo
deployment of the gateway, independent of the packaging work.

## 6. Data exchange over the FLECS Service Mesh

Read from <https://docs.flecs.tech/flecs-core/exchanging-data-between-apps/>,
the flunder integration guide, the Node-RED example, the repositories
`FLECS-Technologies/flunder`, `apps-tech.flecs.flunder` and
`apps-tech.flecs.mqtt-bridge`, and the Zenoh REST documentation, 2026-10-30.
Tracked in ferrion#1052.

**What the mesh is**

- The Service Mesh is a **Zenoh** router: the app `tech.flecs.service-mesh`
  (image `tech.flecs.flunder`) runs `zenohd` with the REST plugin on port
  `8000` and the storage manager, under the hostname `flecs-flunder` on TCP
  `7447`. It is not installed by default; operators add it, the MQTT bridge
  and a Mosquitto broker from the marketplace. All apps share the Docker
  network `flecs`, so these hostnames resolve inside every app container.
- **flunder** is FLECS's C/C++ client library (over `zenoh-c` 1.5): typed
  `publish(topic, value)` for booleans, integers, floats, doubles, strings and
  raw bytes with an encoding string; `subscribe(topic, callback)` with Zenoh
  wildcards (`*`, `**`); `add_mem_storage(name, keyexpr)` for retention in
  memory. Latency is quoted at 35–45 µs; FLECS claims no hard real time.
- The **MQTT bridge** connects to `flecs-mqtt:1883`, subscribes to `#` and
  forwards every MQTT message as a mesh key with the same name (payload as
  bytes, encoding `application/octet-stream;bridge=mqtt`), and every mesh
  sample back to MQTT. Mesh and MQTT are therefore one topic tree; a loop
  guard on the encoding keeps bridged messages from bouncing.
- There is **no prescribed data model** (topic names are free; the docs
  suggest names such as `sensor/temperature`) and **no access control inside
  the mesh**. Field devices and PLCs reach the mesh through adapter apps
  (any2x, Node-RED with OPC UA nodes, AnyViz); the Device Client itself only
  onboards devices.

**What a Node.js app can use**

- `@eclipse-zenoh/zenoh-ts` needs the `zenoh-plugin-remote-api` on the router,
  which the FLECS mesh does not load, and it runs in browsers only. A direct
  Zenoh session from Node is therefore not available today.
- **MQTT via the bridge:** `mqtt://flecs-mqtt:1883`, plain MQTT 3.1.1/5, no
  TLS, no authentication. The gateway's MQTT data source already speaks this
  (broker URL, topic, `jsonField`), so a mesh value that arrives as JSON on an
  MQTT topic can be read with no code change, provided the gateway container
  is on the `flecs` network.
- **Zenoh REST plugin:** `GET http://flecs-flunder:8000/<key or wildcard>`
  returns a JSON array of `{key, value, encoding, time}`; the same request
  with `Accept: text/event-stream` subscribes over Server-Sent Events;
  `PUT` with a `Content-Type` (`text/plain`, `application/json`,
  `application/integer`, `application/float`) publishes. No library needed.
  How flunder's binary-typed values (an `int32` published from C++) are
  rendered in the REST reply must be checked live before relying on it.

**What the gateway could do (ferrion#1052)**

1. *No code:* on a FLECS device with mesh, bridge and broker, point an MQTT
   data source at `flecs-mqtt:1883` and the mesh topic; confirm the gateway
   container joins the `flecs` network (automatic for classic FLECS apps,
   open for Margo workloads).
2. *Mesh key as a data source* through the REST plugin (current value by
   `GET`, updates by SSE), as a fourth read path beside OPC UA, Modbus TCP and
   MQTT, with the typed-value question from above answered first.
3. *Publish readings to the mesh, opt-in:* `ferrion/<gateway>/<asset>/<metric>`
   as JSON `{value, unit, timestamp}` by REST `PUT` or MQTT, so dashboards
   and PLC adapters on the device see the values ferrion receives anyway. The
   mesh is device-local, so the gateway's outbound-only rule towards ferrion
   is untouched; the key namespace and units should be agreed with FLECS,
   because the mesh prescribes none.

None of this depends on the packaging work in sections 2 and 3; step 1 works
with any container on the `flecs` network.

## 7. The BART package in this repository

| Path | Role |
| --- | --- |
| `app/margo.yaml` | Margo ApplicationDescription in BART's `margo/v1alpha1` shape; placeholders for version and component repository are overwritten by BART |
| `app/icon.svg`, `app/release-notes.md`, `app/description.md`, `app/license.txt` | Catalog files the marketplace shows; the licence is a copy of `LICENSE` (BART needs an extension and a path inside `app/`) |
| `compose/compose.yaml` | The deployable compose: signed release image, loopback-only control plane, three `${VAR}` parameters, named volume. No simulator port ranges |
| `docker-compose.yml` (root) | Development only; builds from the working tree and publishes the simulator ports |

`app/` and `compose/` are excluded from the Docker build context
(`.dockerignore`); the image does not change.

**Validating without installing anything.** BART publishes Linux binaries on
its Forgejo releases page; macOS builds from source. Running the release
binary in a throwaway container keeps it off the host:

```sh
curl -fsSL -o /tmp/bart https://git.flecs.tech/flecs/bart/releases/download/0.4.0/bart-linux-arm64-release
chmod +x /tmp/bart   # amd64 hosts: bart-linux-amd64-release
docker run --rm --network none --read-only --cap-drop ALL \
  -v /tmp/bart:/usr/local/bin/bart:ro -v "$PWD":/work:ro \
  debian:trixie-slim bart validate --dir /work
```

`bart package --dir /work --version <semver> --out /work/dist` on a writable
copy writes `dist/catalog/`, `dist/components/ferrion-gateway-components.tar.gz`
and `dist/images/manifest.yaml` (source image → `apps.flecs.tech/staging-ferrion-gateway/ferrion-gateway:<version>`).

**Result 2026-10-30, BART 0.4.0** (sha256 `86a8bf98…aa63`): `bart validate`
passes every check ("Validation passed"); `bart package --version 0.1.65`
produces the three artifacts, the components tarball holds exactly
`compose/compose.yaml` with the image rewritten to the staging path. Counter
check on a copy with `build:`, `licenseFile: ../LICENSE` and an `ENV.`-prefixed
pointer: four errors, as expected (V03, V12, V15, V16).

Not done with this: `bart push` (needs a FLECS publishing package and the
release tag in ghcr.io), multi-arch images (gap 7), the control-plane login
(section 5), and any test on a device.
