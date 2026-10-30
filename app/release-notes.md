# Release notes

The full list of changes per version is on the GitHub release of each tag
(<https://github.com/hendrikpriemer/ferrion-gateway/releases>), generated
from the merged pull requests. This file carries the summary that a Margo
catalog shows.

## 0.1.65

First version packaged for Margo/FLECS (validation only, not yet published to
a catalog).

- Device discovery (OPC UA): second sweep pass over silent targets, so two
  searches of the same network find the same devices.
- Gateway status: the `node-unknown` state of a data point is shown instead
  of "no current data" for the whole instance.
- Signed release images from CI (Sigstore keyless, CycloneDX SBOM), verified
  on the host before start.
