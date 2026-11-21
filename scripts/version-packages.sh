#!/usr/bin/env bash
# Applies the pending changesets like `changeset version`, but keeps the held packages out of the
# release: their versions stay, and their changesets stay pending. The nightly publish does not
# use this script, so a held package still gets its nightly versions.
# Usage: bash scripts/version-packages.sh

set -euo pipefail

# Packages to keep out of the release. Remove a name to release that package.
held=()

if [ "${#held[@]}" -eq 0 ]; then
  exec pnpm exec changeset version
fi

# changeset version stops when a public package depends on an ignored one, so hold those too.
manifests=$(pnpm ls -r --depth -1 --json | jq -r '.[].path + "/package.json"')
mapfile -t held < <(jq -rs '
  map(select(.private != true) | {
    name,
    deps: ((.dependencies // {}) + (.peerDependencies // {}) + (.optionalDependencies // {}) | keys)
  }) as $packages
  | def with_dependents:
      . as $held
      | ($held + ($packages | map(select(.deps | any(IN($held[]))) | .name)) | unique) as $next
      | if $next == $held then $held else $next | with_dependents end;
  $ARGS.positional | unique | with_dependents | .[]
' $manifests --args "${held[@]}")

# changeset version also stops on a changeset that names both a held package and another one.
# Move the held lines of such a changeset into their own file, which stays pending. The commit
# line keeps the changelog links on the commit that added the original changeset.
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
# A shallow clone reports its oldest commit as the one that added every older file.
[ "$(git rev-parse --is-shallow-repository)" = false ] || git fetch --quiet --unshallow
for file in .changeset/*.md; do
  [ "$(basename "$file")" != README.md ] || continue
  awk -v held="${held[*]}" -v held_file="$out/held.md" -v rest_file="$out/rest.md" '
    BEGIN { count = split(held, names, " "); for (i = 1; i <= count; i++) is_held[names[i]] = 1 }
    /^---$/ && fences < 2 { fences++; print > held_file; print > rest_file; next }
    fences == 1 {
      name = $0; sub(/:.*/, "", name); gsub(/["\047 ]/, "", name)
      if (name in is_held) { print > held_file; held_lines++ } else { print > rest_file; rest_lines++ }
      next
    }
    { print > held_file; print > rest_file }
    END { exit !(held_lines && rest_lines) }
  ' "$file" || continue

  commit=$(git log --diff-filter=A --format=%H -1 -- "$file")
  if [ -n "$commit" ] && ! grep -qiE '^\s*(pr|pull|pull\s+request|commit):' "$out/held.md"; then
    printf '\ncommit: %s\n' "$commit" >> "$out/held.md"
  fi
  mv "$out/held.md" "${file%.md}-held.md"
  mv "$out/rest.md" "$file"
done

ignores=()
for name in "${held[@]}"; do
  ignores+=(--ignore "$name")
done
pnpm exec changeset version "${ignores[@]}"
