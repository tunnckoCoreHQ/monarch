# Contributing to tsgolint-rust

Read [ARCHITECTURE.md](ARCHITECTURE.md) first, then [tsgolint-core/README.md](tsgolint-core/README.md) for how a rule is written.

## Goal

Same behavior as [tsgolint v7.0.2003](https://github.com/oxc-project/tsgolint/tree/v7.0.2003), written as idiomatic Rust. Port the behavior, not the code: no Go structure, goroutines, channels, `defer` or Go naming. When tsgolint does something surprising that the output depends on (an odd sort, a quirk in a range, a skipped node), keep the behavior and write a one-line comment that says what tsgolint does.

The Go sources to compare with are tsgolint at that tag and the typescript-go revision it pins (its `typescript-go` submodule, with its `patches/`). ts-rust comes from [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust), branch `main`, at the commit in `Cargo.lock`.

## Code rules

- Rust 2024 on the toolchain in `rust-toolchain.toml`. `unsafe` is forbidden.
- Rules get `&mut Checker` and read types through ts-rust's handles (`TypeId`, `SymbolId`, `SignatureId`, `Node`). Copy ids out of a borrow before the next checker call.
- Rule names and message ids stay as tsgolint has them (kebab-case rule names, camelCase message ids). Messages, help texts and suggestion texts are part of the output: copy them byte for byte from the Go source.
- Options decode with serde from the rule's `schema.json` defaults. A missing or `null` property takes its default. A wrong type panics with `<rule-name>: failed to unmarshal options: ...`, as tsgolint does.
- Shared helpers live in `tsgolint-rules/src/utils` and in `tsgolint-core`. Check them before writing a local one.
- Keep comments short. Explain why, not what.

## Tests

- `pnpm exec turbo run check test --filter=./crates` runs fmt, clippy, the Rust tests and the e2e suite on the native and the wasm build.
- `cargo test -p tsgolint-rules --test rules -- <rule-name or case key>` runs tsgolint's rule cases for one rule against tsgolint's snapshots.
- `crates/tsgolint-compare` compares the Go binary (`node_modules/.bin/tsgolint`, from the root `oxlint-tsgolint` devDependency) with this one on a real project.

## Differences from tsgolint

ts-rust ports a newer TypeScript (7.1.0-dev) than tsgolint (7.0). When a case fails only because the newer checker returns another type, type string or diagnostic, pin it in `tsgolint-rules/tests/data/divergences/` and list it in `tsgolint-rules/tests/data/divergences.md` and [DIFFERENCES.md](DIFFERENCES.md), with the evidence: what Go prints, what we print, and the TypeScript change or checker function that explains it. A minimal repro that `typescript@7.0.2` and `typescript@7.1.0-dev.20261008.1` compile differently is the usual proof. Never pin a difference that comes from a bug in the port.
