# Security

## Reporting a vulnerability

Please report vulnerabilities **privately**, through GitHub's private
vulnerability reporting: open the **Security** tab of this repository and choose
**Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you can: the affected version or commit, how to reproduce it, and
what an attacker could do with it. We aim to acknowledge a report within ten
working days, keep you informed while we work on it, and credit you in the
advisory unless you prefer otherwise.

Fixed vulnerabilities are published as GitHub Security Advisories in this
repository. A security fix gets its own release instead of waiting for the next
regular one.

These are goals, not commitments. The software is provided under the
[Apache License 2.0](LICENSE) "as is", without warranty or support obligation
(sections 7 and 8). Commercial support for installations of the ferrion
platform is governed by the respective customer agreement.

Vulnerabilities in the ferrion platform itself (not this gateway) can be
reported the same way; they are forwarded.

## Supported versions

Only the latest release receives security fixes. Release images are signed and
carry an SBOM; see [docs/releases.md](docs/releases.md) for how to verify them.

## Security model

- **Outbound only.** The gateway connects to ferrion and to field devices; it
  needs no inbound port from outside the machine.
- **Local web UI without authentication.** It binds to `127.0.0.1` (published
  to loopback only in Docker), and that is the trust boundary: whoever can use
  the gateway machine can configure it, as with a configuration file.
  State-changing requests must be same-origin by Fetch Metadata, and every
  request must name this machine in its `Host` header, which closes DNS
  rebinding. Do not expose port 4000 to a network; if you open the UI under a
  LAN name with `network_mode: host`, list exactly that name in
  `FG_ALLOWED_HOSTS`.
- **The ferrion API key** is stored in `data/settings.json` with mode `0600`,
  sent to instance processes over IPC only, not on a command line or in the
  environment, and the gateway's own log messages do not contain it. Changing the
  ferrion base URL to another host requires entering the key again.
- **Field devices are only read.** The device search is bounded by
  `FG_DISCOVERY_ALLOWED_CIDRS`, which ferrion cannot widen, and opens no session
  at devices already in use ([docs/device-discovery.md](docs/device-discovery.md)).
- **Supply chain.** Dependencies are watched by Dependabot with security
  updates enabled; secret scanning with push protection is on; CodeQL scans
  every push and pull request (Security tab → Code scanning). Release images
  are built in CI, signed keyless with Sigstore, and carry a CycloneDX SBOM;
  a host verifies both before it starts an image
  ([docs/releases.md](docs/releases.md)).

The penetration test of September 2026 and the code review that followed are
published in [docs/security/](docs/security/) and
[docs/review-2026-09.md](docs/review-2026-09.md) (German). All findings are fixed.
