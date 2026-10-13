#!/bin/sh
# The crates' test task: the Rust tests (rule cases, unit, golden and CLI
# tests), then tsgolint's e2e suite against the native binary and against the
# wasm32-wasip1 build under wasmtime. Runs from crates/ (turbo runs package
# scripts there).
set -eu

crates=$(cd "$(dirname "$0")/.." && pwd)
target=${CARGO_TARGET_DIR:-$crates/../target}

cargo test --workspace -- --test-threads 4
cargo build -p tsgolint-rust
cargo build -p tsgolint-rust --target wasm32-wasip1

TSGOLINT_BIN="$target/debug/tsgolint" pnpm --dir "$crates/tsgolint-rust/e2e" run e2e
TSGOLINT_WASM="$target/wasm32-wasip1/debug/tsgolint.wasm" \
  TSGOLINT_BIN="$crates/tsgolint-rust/e2e/tsgolint-wasm.sh" \
  pnpm --dir "$crates/tsgolint-rust/e2e" run e2e
