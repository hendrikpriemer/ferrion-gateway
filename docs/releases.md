# Releases and image verification

Release images are built by GitHub Actions, not on the machine that runs them,
signed with Sigstore, and published with an SBOM. A gateway host pulls an image
and starts it only if the signature proves it came from this repository's
release workflow.

## How a release is made

A tag `vX.Y.Z` on `main` starts `.github/workflows/release.yml`:

1. The tag must match the version in `package.json` (a suffix such as `-rc.1`
   marks a trial run).
2. The `Dockerfile` is built and pushed to `ghcr.io/hendrikpriemer/ferrion-gateway:<tag>`.
3. The image is signed **keyless** with `cosign`: the workflow proves its
   identity through GitHub's OIDC token, Sigstore issues a short-lived
   certificate for it, and the signature is recorded in the public
   transparency log. There is no signing key to keep or lose.
4. The SBOM (CycloneDX, from `package-lock.json`) is attached to the image as a
   signed attestation and to the GitHub release as a file.
5. A GitHub release is created with notes since the previous tag and the image
   digest.
6. The registry keeps the newest five releases with their signatures and
   attestations; older ones are deleted (`scripts/ghcr-prune.sh`).

Releases are collected, about once a month; a security fix gets its own release
at once. The workflow was tried with `v0.1.65-rc.1` on 2026-10-30 (under two
minutes, signature and attestation verified); `v0.1.65` is planned as the first
regular release with the ferrion update in November 2026. Until then only
`-rc` trial images exist in the registry, and they are pruned by later releases.

## Verifying an image

On the gateway host:

```sh
scripts/vm-release-pull.sh v0.1.65            # verify, then pin in .env
scripts/vm-release-pull.sh v0.1.65 --check    # verify only
```

The script pulls the tag, resolves it to the image digest (a tag can be moved, a
digest cannot), and verifies signature and SBOM attestation at that digest
against the identity of this repository's release workflow. Only then does it
write `GATEWAY_IMAGE=ghcr.io/hendrikpriemer/ferrion-gateway@sha256:…` into
`.env`, after a backup. The compose file on the host uses
`image: ${GATEWAY_IMAGE}`, so `docker compose up -d` starts exactly the
verified image. An invalid signature leaves `.env` unchanged.

To verify by hand with [cosign](https://github.com/sigstore/cosign):

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/hendrikpriemer/ferrion-gateway/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/hendrikpriemer/ferrion-gateway@sha256:<digest>

cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github\.com/hendrikpriemer/ferrion-gateway/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/hendrikpriemer/ferrion-gateway@sha256:<digest>
```

Updating a running installation step by step, including the data check and the
way back, is in [deployment.md](deployment.md) (German).

## Building it yourself

`docker compose up -d --build` builds from the working tree, as in development.
Such an image is not signed; that is fine for your own use, but it is not what
a release verification accepts.
