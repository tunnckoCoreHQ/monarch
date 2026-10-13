#!/usr/bin/env bash
# Runs oxlint on oxc's tsgolint CLI fixtures twice, once with each tsgolint
# binary, and compares oxlint's output and exit code.
#
# usage: oxlint-fixtures.sh <oxlint-bin> <go-tsgolint> <rust-tsgolint> <oxc-checkout>
#
# The fixtures are copied to a temporary directory for each run, so `--fix`
# cases do not touch the checkout. Timing lines ("Finished in ...") are dropped
# before the comparison, and lines are sorted because oxlint prints files in a
# varying order.
set -uo pipefail

oxlint=$1
go_bin=$2
rust_bin=$3
oxc=$4
fixtures="$oxc/apps/oxlint/fixtures/cli"

# cwd|args (one oxlint invocation per line), from apps/oxlint/src/lint.rs.
cases=(
  "tsgolint|--type-aware"
  "tsgolint|--type-aware --silent"
  "tsgolint|--type-aware -c config-test.json"
  "tsgolint|-c config-type-aware.json"
  "tsgolint|-c config-type-aware-with-overrides.json no-floating-promises.ts"
  "tsgolint|-c config-type-aware-false.json no-floating-promises.ts"
  "tsgolint|--type-aware -c config-type-aware-false.json no-floating-promises.ts"
  "tsgolint|--type-aware test.svelte"
  "tsgolint_type_error|--type-aware --type-check"
  "tsgolint_type_error|--type-check-only"
  "tsgolint_type_error|--type-check"
  "tsgolint_type_error|-c config-type-check.json"
  "tsgolint_type_error|-c config-type-check-zero-rules.json"
  "tsgolint_type_error|-c config-type-check-false.json"
  "tsgolint_type_error|--type-check -c config-type-check-false.json"
  "tsgolint_type_check_only_rules|--type-check-only"
  "tsgolint_type_check_only_syntax_error|--type-check-only"
  "tsgolint_type_check_only_svelte_syntax_error|--type-check-only"
  "tsgolint_disable_directives|--type-aware --report-unused-disable-directives unused.ts"
  "tsgolint_disable_directives|--type-aware"
  "tsgolint_config_error|--type-aware"
  "tsgolint_tsconfig_extends_config_err|--type-aware -D no-floating-promises"
  "tsgolint_rule_options|--type-aware"
  "tsgolint_fix|--type-aware --fix"
  "tsgolint_fix|--type-aware --fix-suggestions"
)

run() {
  local bin=$1 dir=$2 args=$3 tmp
  tmp=$(mktemp -d)
  cp -r "$fixtures/$dir" "$tmp/$dir"
  # Run inside the copy; keep the copy's absolute path out of the output.
  (
    cd "$tmp/$dir" || exit 99
    # shellcheck disable=SC2086
    OXLINT_TSGOLINT_PATH=$bin "$oxlint" $args 2>&1
    echo "exit=$?"
    if [[ $args == *--fix* ]]; then
      find . -type f -name '*.ts' -print0 | sort -z | xargs -0 cat
    fi
  ) | sed -e "s#$tmp#<tmp>#g" -e '/^Finished in /d' -e 's/ in [0-9.]*m\?s / in <time> /' | LC_ALL=C sort
  rm -rf "$tmp"
}

pass=0
fail=0
for case in "${cases[@]}"; do
  dir=${case%%|*}
  args=${case#*|}
  if [[ ! -d $fixtures/$dir ]]; then
    echo "SKIP $dir (missing)"
    continue
  fi
  go_out=$(run "$go_bin" "$dir" "$args")
  rust_out=$(run "$rust_bin" "$dir" "$args")
  if [[ $go_out == "$rust_out" ]]; then
    pass=$((pass + 1))
    echo "same  $dir: $args"
  else
    fail=$((fail + 1))
    echo "DIFF  $dir: $args"
    diff <(echo "$go_out") <(echo "$rust_out") | head -40
  fi
done
echo "same: $pass, different: $fail"
[[ $fail -eq 0 ]]
