#!/usr/bin/env bash
# Publishes the stable versions one registry is missing, with latest and package tags, then pushes
# the new tags and creates a GitHub Release for each, with its changelog entry. The vlt argument
# takes the @tunnckocore packages, which go to npm.wgw.lol with the prod vault's OIDC token. The
# npm argument takes the unscoped packages, which go to npmjs.com with NPM_TOKEN. Each share
# builds and publishes only its own packages, so either one can move to another CI on its own.
# With DRY_RUN set, it rehearses the release from master and writes nothing outside the checkout:
# it applies the pending changesets without a commit, packs the same tarballs, runs each publish
# and the tag push as a dry run, and prints the release notes. The registry upload and the GitHub
# Releases are the two steps it cannot rehearse.
# Usage: pnpm run packages:publish <vlt|npm>

set -euo pipefail

case "${1:-}" in
  vlt)
    share='startswith("@tunnckocore/")'
    builds=(--filter='@tunnckocore/*')
    ;;
  npm)
    share='startswith("@tunnckocore/") | not'
    builds=(--filter='./packages/*' --filter='!@tunnckocore/*')
    ;;
  *)
    echo "Usage: pnpm run packages:publish <vlt|npm>" >&2
    exit 1
    ;;
esac

dry_run=${DRY_RUN:-}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# master still has the pending changesets, so this gives the versions of the release PR.
[ -z "$dry_run" ] || bash scripts/version-packages.sh
pnpm exec turbo run build "${builds[@]}"
pnpm exec changeset publish-plan --output "$out/plan.json"
jq ".plan |= (map(map(select(.name | $share))) | map(select(length > 0)))" "$out/plan.json" > "$out/share.json"
pnpm exec changeset pack --from-publish-plan "$out/share.json" --out-dir "$out/pack"
# The vlt share needs no auth here: pnpm exchanges NPM_ID_TOKEN at npm.wgw.lol, as it did on Depot.
[ "$1" = vlt ] || echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" >> "$HOME/.npmrc"
# The package tags are annotated, so git needs an identity, and RWX has none.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if [ -z "$dry_run" ]; then
  # changeset publish creates the local tags and reports each one as a git-tag event.
  CHANGESETS_OUTPUT="$out/events.jsonl" pnpm exec changeset publish --from-pack-dir "$out/pack"
else
  # changeset publish has no dry run, so this runs its pnpm publish and git tag commands itself.
  releases=$(jq -r '.plan[][] | select(.kind == "publish") | [.name, .version, .tag, .access, .tarball.path] | @tsv' "$out/pack/publish-plan.json")
  while IFS=$'\t' read -r name version tag access tarball; do
    [ -n "$name" ] || continue
    pnpm publish "$out/pack/$tarball" --dry-run --access "$access" --tag "$tag" --no-git-checks < /dev/null 2>&1 | tee -a "$out/publish.log"
    git tag "$name@$version" -m "$name@$version"
    jq -cn --arg tag "$name@$version" --arg name "$name" '{type: "git-tag", tag: $tag, packageName: $name}' >> "$out/events.jsonl"
  done <<< "$releases"

  # pnpm only warns when the registry rejects the OIDC token, and the dry run still exits 0.
  if grep -q 'Skipped OIDC' "$out/publish.log" 2> /dev/null; then
    echo "Dry run failed: the registry rejected the OIDC token" >&2
    exit 1
  fi
fi

tags=$(jq -r 'select(.type == "git-tag") | "\(.tag)\t\(.packageName)"' "$out/events.jsonl" 2> /dev/null || true)
if [ -z "$tags" ]; then
  echo "No new package tags"
  exit 0
fi
git push ${dry_run:+--dry-run} "https://x-access-token:${GITHUB_TOKEN}@github.com/tunnckoCoreHQ/monarch.git" $(cut -f1 <<< "$tags")
while IFS=$'\t' read -r tag name; do
  dir=$(pnpm ls --filter "$name" --json --depth -1 | jq -r '.[0].path')
  version=${tag##*@}
  # The changelog entry is everything between this version's heading and the next one.
  awk -v heading="## $version" '$0 == heading { found = 1; next } found && /^## / { exit } found' \
    "$dir/CHANGELOG.md" > "$out/notes.md"
  if [ -n "$dry_run" ]; then
    printf '\nDry run: GitHub Release %s\n' "$tag"
    cat "$out/notes.md"
    continue
  fi
  gh release create "$tag" --repo tunnckoCoreHQ/monarch --title "$tag" --notes-file "$out/notes.md"
done <<< "$tags"
