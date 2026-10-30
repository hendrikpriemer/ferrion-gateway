# Margo and FLECS compatibility

Status as of 2026-10-30. Tracked in
[ferrion#814](https://github.com/hendrikpriemer/ferrion/issues/814).

**Short answer: not yet.** The gateway was built to fit a Margo device
(one image, Compose-deployable, named volume only, non-root, health check,
Apache-2.0 with NOTICE, signed release images), but it cannot be packaged for
the current Margo specification or for FLECS today. `margo.yaml` follows an
older draft, the Compose file still says `build:`, one environment variable has
no parameter, release images exist for `amd64` only, icon and release notes are
missing, and the control-plane UI is reachable from the local machine only.
The sections below say exactly what each target demands, where the gateway
stands, and in which order the gaps should be closed.

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
| 1 | Application description in the current schema | `margo.yaml` uses `apiVersion: margo.org/v1-alpha1` with a `kind`, `metadata.id`, `packageLocation` and `requiredResources` with `storage`/`interfaces` – an older draft that neither Margo PR3 nor BART accepts | Rewrite against BART's `margo/v1alpha1` (top-level `id`, `metadata.version: "0.0.0"`, `requiredResources.cpu.architectures`), drop unknown fields, run `bart validate` |
| 2 | No `build:` in Compose | `docker-compose.yml` builds from the working tree | Reference the signed release image (`image: ghcr.io/hendrikpriemer/ferrion-gateway:<version>`, see [releases.md](releases.md)); keep building only in a development override |
| 3 | Package layout and file name | one `docker-compose.yml` at the repository root | Add `app/` and `compose/compose.yaml` for packaging (the root file stays for development), or generate them in CI |
| 4 | Every `${VAR}` has a parameter | `FG_CONTROL_PLANE_PORT` has `controlPlanePort`; `FG_DISCOVERY_ALLOWED_CIDRS` has none | Add a string parameter with a CIDR-list `regexMatch` and `allowEmpty: true`; `FG_BIND_HOST` is a fixed value, not a variable, and stays |
| 5 | No bind mounts, `container_name`, `privileged`, `pid: host`, host network | Compliant: one named volume, nothing else; `network_mode: host` is only a commented alternative | Keep. Consequence: on a Margo device the gateway always runs on a bridge network, so device discovery works only within what that network reaches ([device-discovery.md](device-discovery.md)) |
| 6 | Icon, release notes, licence, description | `LICENSE` (Apache-2.0) and `README.md` are referenced; `docs/assets/ferrion-icon.svg` exists but is not referenced; no release-notes file | Point `icon` at an SVG/PNG under `app/`, write `app/release-notes.md` per release (the GitHub release already carries generated notes) |
| 7 | Images for the declared architectures | `margo.yaml` declares `amd64` and `arm64`; `release.yml` builds without `platforms`, i.e. `amd64` only | Either build multi-arch (QEMU, check the `@serialport/bindings-cpp` musl `arm64` prebuild) or declare `amd64` only. Most edge devices are `arm64`, so multi-arch is the useful answer |
| 8 | Version | `metadata.version: 0.1.0` is stale (package is 0.1.65); release tags are `v0.1.x` | Use BART's placeholder; tags already fit SemVer |
| 9 | Signing | Release images are signed keyless with Sigstore ([releases.md](releases.md)) | BART signs with its own cosign key as a second step; when FLECS replicates the image into an on-premises registry, the Sigstore signature does not travel unless copied. Decide whether both signatures are kept |
| 10 | Operator access to the UI | The control plane has no authentication and is published on `127.0.0.1` of the host only; inside the container it binds `0.0.0.0` | FLECS routes app UIs (`editors`) through its reverse proxy but does **not** put its own login in front of them (section 5). On a headless edge device the operator could not reach the UI, and publishing it on the device network would expose an unauthenticated API that holds the ferrion API key. **The control plane needs its own login, built on the device's identity provider (OIDC), before any Margo deployment** – the largest functional gap; see section 5 and ferrion#1051 |
| 11 | Health and start-up | `HEALTHCHECK` on `/api/health`, `init: true`, `stop_grace_period`, log-size limits | Compliant; none of these settings is on BART's forbidden list |
| 12 | Resource needs | 0.5 cores, 512 Mi memory, measured | Keep the numbers, move them into the schema the target expects (`requiredResources` for BART) |
| 13 | End-to-end test on a device | Nothing has been tested against a FLECS device or BART | `bart validate` is offline and can run now; `bart push`/Device Client need a FLECS publishing package |

## 3. Suggested order

1. Restructure for BART (`app/`, `compose/`), rewrite `margo.yaml`, add the
   missing parameter, run `bart validate` until clean. No runtime change.
2. Switch the packaged Compose file to the signed release image.
3. Build release images for `linux/amd64` and `linux/arm64`; verify the
   serial-port native module on `arm64`.
4. Add icon and release notes to the package.
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
