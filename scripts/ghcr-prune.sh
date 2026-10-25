#!/usr/bin/env bash
# Keeps the newest $KEEP released images of a GHCR container package and
# deletes the rest (R01, decision 2026-10-25: five, as a way back).
#
# A release is a version tagged v*. cosign stores the signature and the SBOM
# attestation of an image as two more versions, tagged
# sha256-<digest>.sig and sha256-<digest>.att; they go with their image. A
# version with no tag at all is a leftover of an overwritten tag and goes too.
#
#   GH_TOKEN=... KEEP=5 scripts/ghcr-prune.sh <package> [--dry-run]
#
# Runs in the release workflow; needs `packages: write`. The user-owned
# package path is used: the repositories belong to a user, not an org.
set -euo pipefail

package="${1:?package name}"
dry_run="${2:-}"
keep="${KEEP:-5}"
owner="${GITHUB_REPOSITORY_OWNER:-$(gh api user --jq .login)}"
base="/users/${owner}/packages/container/${package}/versions"

# id, digest (the version's name) and tags, newest first.
versions=$(gh api --paginate "${base}?per_page=100" \
  --jq '.[] | [.id, .name, ((.metadata.container.tags // []) | join(","))] | @tsv')

keep_digests=$(printf '%s\n' "$versions" | awk -F'\t' '$3 ~ /(^|,)v[0-9]/ {print $2}' | head -n "$keep")

delete=()
while IFS=$'\t' read -r id digest tags; do
  [ -z "$id" ] && continue
  if [[ "$tags" =~ (^|,)v[0-9] ]]; then
    grep -qxF "$digest" <<<"$keep_digests" || delete+=("$id $digest $tags")
  elif [[ "$tags" =~ ^sha256-([0-9a-f]{64})\.(sig|att)$ ]]; then
    # Signature or attestation: kept exactly as long as its image.
    grep -qxF "sha256:${BASH_REMATCH[1]}" <<<"$keep_digests" || delete+=("$id $digest $tags")
  elif [ -z "$tags" ]; then
    delete+=("$id $digest (untagged)")
  fi
done <<<"$versions"

echo "keeping $(printf '%s\n' "$keep_digests" | grep -c . || true) released images"
for entry in "${delete[@]+"${delete[@]}"}"; do
  echo "delete ${entry}"
  if [ "$dry_run" != "--dry-run" ]; then
    gh api --method DELETE "${base}/${entry%% *}" >/dev/null
  fi
done
