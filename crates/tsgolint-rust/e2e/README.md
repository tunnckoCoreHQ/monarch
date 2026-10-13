# tsgolint end-to-end tests

tsgolint's end-to-end suite (Vitest), with its fixtures. It runs whichever binary `TSGOLINT_BIN` names, so the same suite checks the Go tsgolint, the native tsgolint-rust, and the wasm build.

## Running

The root `pnpm install` installs the suite's dependencies. `crates/scripts/test.sh` (the crates' `test` task) builds both binaries and runs the suite twice. To run it by hand:

```bash
cargo build -p tsgolint-rust
TSGOLINT_BIN=$PWD/target/debug/tsgolint pnpm --dir crates/tsgolint-rust/e2e run e2e

# The wasm build, under wasmtime
cargo build -p tsgolint-rust --target wasm32-wasip1
TSGOLINT_WASM=$PWD/target/wasm32-wasip1/debug/tsgolint.wasm \
  TSGOLINT_BIN=$PWD/crates/tsgolint-rust/e2e/tsgolint-wasm.sh \
  pnpm --dir crates/tsgolint-rust/e2e run e2e

# The Go binary, from the root oxlint-tsgolint devDependency
TSGOLINT_BIN=$PWD/node_modules/.bin/tsgolint pnpm --dir crates/tsgolint-rust/e2e run e2e
```

Add `-- --update` to rewrite the Vitest snapshot. The snapshot comes from tsgolint; change it only for a listed difference (see `crates/DIFFERENCES.md`).

## How it works

The main snapshot test in [`snapshot.test.ts`](./snapshot.test.ts):

1. Collects the TypeScript files of `fixtures/basic/`.
2. Builds a headless payload with all rules on.
3. Runs `tsgolint headless -fix -fix-suggestions` with `GOMAXPROCS=1`.
4. Reads the framed output and keeps the JSON diagnostics.
5. Sorts them, so the order does not depend on scheduling.
6. Compares them with the snapshot.

The other tests cover rule options, project references, source overrides, TypeScript diagnostics, and regressions found in tsgolint. Three tests run only on Windows or on case-insensitive file systems.
