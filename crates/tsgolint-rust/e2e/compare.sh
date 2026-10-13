#!/usr/bin/env bash
# Runs the Go binary and a port binary on the same payload and diffs the
# sorted messages (tsgolint's program order is random).
#   compare.sh <go-binary> <port-binary> <frames-decoder> <payload.json> [flags...]
set -u
go_bin=$1 port_bin=$2 frames=$3 payload=$4
shift 4
go_out=$(mktemp) port_out=$(mktemp)
GOMAXPROCS=1 "$go_bin" headless "$@" < "$payload" > "$go_out.bin" 2> "$go_out.err"; go_code=$?
GOMAXPROCS=1 "$port_bin" headless "$@" < "$payload" > "$port_out.bin" 2> "$port_out.err"; port_code=$?
"$frames" --sort < "$go_out.bin" > "$go_out"
"$frames" --sort < "$port_out.bin" > "$port_out"
status=0
if [ "$go_code" != "$port_code" ]; then
  echo "exit code: go $go_code, port $port_code"; status=1
fi
if ! diff -u --label go "$go_out" --label port "$port_out"; then status=1; fi
if [ "$status" != 0 ]; then
  echo "--- go stderr"; head -5 "$go_out.err"; echo "--- port stderr"; head -5 "$port_out.err"
fi
rm -f "$go_out" "$port_out" "$go_out.bin" "$port_out.bin" "$go_out.err" "$port_out.err"
exit $status
