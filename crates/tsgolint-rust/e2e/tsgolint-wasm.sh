#!/bin/sh
# Runs the wasm32-wasip1 build of tsgolint under wasmtime as a drop-in for the
# native binary: `TSGOLINT_BIN=<this>` for the e2e suite,
# `OXLINT_TSGOLINT_PATH=<this>` for oxlint. Arguments, stdin, stdout, stderr,
# the environment and the exit code pass through.
#
# TSGOLINT_WASM   the module (default: next to this script, tsgolint.wasm)
# WASMTIME        the runtime (default: wasmtime on PATH)
#
# The module is compiled once to `<module>.cwasm` (rebuilt when the module is
# newer), so each run skips the compile. The current directory goes in as
# `PWD` (physical, as the native binary's getcwd sees it), and `/` is
# preopened at `/`, because realpath walks every parent from the root.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
wasm=${TSGOLINT_WASM:-$here/tsgolint.wasm}
wasmtime=${WASMTIME:-wasmtime}
cwasm=$wasm.cwasm

if [ ! -f "$cwasm" ] || [ "$wasm" -nt "$cwasm" ]; then
  # Parallel runs compile to their own file; the rename is atomic.
  tmp=$cwasm.$$
  "$wasmtime" compile -o "$tmp" "$wasm"
  mv -f "$tmp" "$cwasm"
fi

exec "$wasmtime" run --allow-precompiled -S inherit-env --env PWD="$(pwd -P)" --dir /::/ "$cwasm" "$@"
