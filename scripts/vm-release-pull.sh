#!/usr/bin/env bash
# Pulls a released ferrion-gateway image on the VM and lets it run only if
# its signature checks out (R01, stage 1).
#
#   scripts/vm-release-pull.sh v0.1.57            # check, then pin in .env
#   scripts/vm-release-pull.sh v0.1.57 --check    # check only, change nothing
#
# 1. pulls ghcr.io/hendrikpriemer/ferrion-gateway:<tag>
# 2. resolves the tag to the image digest - from here on only the digest
#    counts, a tag can be moved, a digest cannot
# 3. verifies the Sigstore signature and the SBOM attestation against the
#    identity of this repository's release workflow
# 4. only then writes GATEWAY_IMAGE=<image>@<digest> into .env (backup
#    first), which the VM's compose file uses for the gateway
#
# An unsigned image, one signed by anything but the release workflow, or a
# changed one stops at step 3, and .env stays as it was. Then:
# `docker compose up -d` starts exactly the checked image.
#
# Needs: docker logged in to ghcr.io (a token with read:packages), cosign
# (https://github.com/sigstore/cosign/releases), outbound access to
# ghcr.io and the Sigstore services (checked 2026-10-21, #834).
set -euo pipefail

tag="${1:?usage: vm-release-pull.sh <tag> [--check]}"
mode="${2:-}"
repository="${RELEASE_REPOSITORY:-hendrikpriemer/ferrion-gateway}"
image="ghcr.io/${repository}"
env_file="${ENV_FILE:-.env}"
variable="${IMAGE_VARIABLE:-GATEWAY_IMAGE}"
# A tag push signs as refs/tags/<tag>; a release started by hand runs from
# main. Nothing else may have signed it.
identity="^https://github\.com/${repository//./\\.}/\.github/workflows/release\.yml@refs/(tags/v[0-9][^ ]*|heads/main)$"
issuer="https://token.actions.githubusercontent.com"

command -v cosign >/dev/null || { echo "cosign is not installed" >&2; exit 2; }

echo "== pulling ${image}:${tag}"
docker pull --quiet "${image}:${tag}" >/dev/null
reference=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image}:${tag}" | grep -m1 "^${image}@sha256:" || true)
[ -n "$reference" ] || { echo "no digest for ${image}:${tag}" >&2; exit 1; }
echo "   ${reference}"

echo "== verifying signature and SBOM attestation"
if ! cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$reference" >/dev/null; then
  echo "SIGNATURE INVALID - ${env_file} unchanged, do not start this image" >&2
  exit 1
fi
if ! cosign verify-attestation --type cyclonedx --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$reference" >/dev/null; then
  echo "SBOM ATTESTATION INVALID - ${env_file} unchanged, do not start this image" >&2
  exit 1
fi
echo "   signed by the release workflow of ${repository}"

if [ "$mode" = "--check" ]; then
  echo "== check only, ${env_file} unchanged"
  exit 0
fi

backup="${env_file}.bak-$(date -u +%Y%m%d-%H%M%S)"
cp "$env_file" "$backup"
if grep -q "^${variable}=" "$env_file"; then
  # Replaced in place, the rest of the file untouched.
  tmp=$(mktemp)
  awk -v key="$variable" -v value="$reference" 'index($0, key "=") == 1 { print key "=" value; next } { print }' "$env_file" >"$tmp"
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
else
  printf '%s=%s\n' "$variable" "$reference" >>"$env_file"
fi
echo "== ${variable} pinned in ${env_file} (backup ${backup})"
echo "   next: docker compose up -d"
