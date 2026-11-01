#!/usr/bin/env bash
# Pulls a released ferrion-gateway image on the VM and lets it run only if
# its signature checks out (R01, stage 1).
#
#   scripts/vm-release-pull.sh v0.1.57            # check, then pin in .env
#   scripts/vm-release-pull.sh v0.1.57 --check    # check only, change nothing
#   scripts/vm-release-pull.sh <tag> --force      # pull even while a pg_dump is running
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

tag="${1:?usage: vm-release-pull.sh <tag> [--check] [--force]}"
shift
check=0
force=0
for option in "$@"; do
  case "$option" in
    --check) check=1 ;;
    --force) force=1 ;;
    *) echo "unknown option: ${option} (usage: vm-release-pull.sh <tag> [--check] [--force])" >&2; exit 2 ;;
  esac
done
repository="${RELEASE_REPOSITORY:-hendrikpriemer/ferrion-gateway}"
image="ghcr.io/${repository}"
env_file="${ENV_FILE:-.env}"
variable="${IMAGE_VARIABLE:-GATEWAY_IMAGE}"
# A tag push signs as refs/tags/<tag>; a release started by hand runs from
# main. Nothing else may have signed it.
identity="^https://github\.com/${repository//./\\.}/\.github/workflows/release\.yml@refs/(tags/v[0-9][^ ]*|heads/main)$"
issuer="https://token.actions.githubusercontent.com"

command -v cosign >/dev/null || { echo "cosign is not installed" >&2; exit 2; }

# The first signed release (2026-11-01, ferrion#1067) pulled the 3.1 GB
# image while the pre-update pg_dump was still running: iowait went to 57 %,
# inserts took up to 58 s and about 30 readings were lost. A pull competes
# with a dump for the same disk, so it waits for the dump by default. The
# dump may run on the host or inside the database container; both show up
# in the host's process list.
if [ "$force" -ne 1 ] && pgrep -f '(^|/)pg_dump( |$)' >/dev/null 2>&1; then
  echo "a pg_dump is running - pulling now would compete with it for disk I/O and cost readings (ferrion#1067); wait for the dump to finish, or pass --force" >&2
  exit 3
fi

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

if [ "$check" -eq 1 ]; then
  echo "== check only, ${env_file} unchanged"
  exit 0
fi

if [ -e "$env_file" ]; then
  backup="${env_file}.bak-$(date -u +%Y%m%d-%H%M%S)"
  cp "$env_file" "$backup"
else
  # A gateway instance that never needed one has no .env (ferrion#1067):
  # create it, readable by the owner only, instead of failing after the pull.
  (umask 077 && : >"$env_file")
  backup=""
  echo "== created ${env_file} (mode 600), nothing to back up"
fi
if grep -q "^${variable}=" "$env_file"; then
  # Replaced in place, the rest of the file untouched.
  tmp=$(mktemp)
  awk -v key="$variable" -v value="$reference" 'index($0, key "=") == 1 { print key "=" value; next } { print }' "$env_file" >"$tmp"
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
else
  printf '%s=%s\n' "$variable" "$reference" >>"$env_file"
fi
if [ -n "$backup" ]; then
  echo "== ${variable} pinned in ${env_file} (backup ${backup})"
else
  echo "== ${variable} pinned in ${env_file}"
fi
echo "   next: docker compose up -d"
