# tsgolint-rust

The `tsgolint` binary: the command line, the `headless` protocol that oxlint speaks, tsconfig discovery and the multi-program driver. Program loading, the lint engine and the rules are `tsgolint-core` and `tsgolint-rules`. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the whole port.

## Layout

| Module | What it does |
|---|---|
| `flags` | Go's `flag` package: `-x` and `--x`, `=value` or a separate value, errors with usage and exit 2. |
| `headless` | `tsgolint headless`: reads stdin to EOF, then lints and writes the output on the loading thread. |
| `legacy` | The unsupported `tsgolint [OPTIONS]` command line with its ANSI code frames. |
| `payload`, `json` | The V1 and V2 payloads with JSON v2's rules (duplicate keys, UTF-8, case-sensitive names) and error texts. |
| `protocol` | Message framing, the diagnostic, error and timing JSON byte for byte as tsgolint writes it, and tsgolint's 400 KB output buffer. |
| `stdout` | Standard output that ends the process by SIGPIPE when its reader has gone, as Go does. |
| `overrides` | `source_overrides`: canonical keys and texts for tsgolint-core's canonical `OverlayFs` (`FsFactory::source_overrides`). Only `file_exists` and `read_file` see them. |
| `rules` | The rules of each payload file by canonical path (Go `fileConfigs`), as tsgolint-core `ConfiguredRule`s with their options. |
| `discovery` | Which tsconfig lints each file: nearest config, references BFS, ancestor configs. |
| `driver` | The loading thread, and on it one program at a time, then the inferred program, through `tsgolint_core::create_program` and `lint_program_with`. |
| `panic` | Go's panic behavior: `panic: <message>` and exit code 2. |
| `wasi` | The current directory under WASI (`PWD`). |
| `profiling` | `-trace`, `-cpuprof`, `-heap`, `-allocs`. |

## How the driver uses tsgolint-core

- The file system is one `FsFactory` for the whole run: `FsFactory::source_overrides` with the payload's overrides (Go `bundled.WrapFS(cachedvfs.From(overlayFS(osvfs.FS())))`), or the base file system without them. Each thread makes its value once, so the rules that read files on checker threads (`ctx.fs()`) see the same overrides as program loading.
- Without overrides, the compiler hosts read through ts-rust's own OS file system (`FsFactory::host_fs`), not the process read cache. ts-rust recognizes it, so the parse workers of a program load read the files and resolve their imports in parallel; behind any other file system the loading thread does both itself, one file at a time. The parse cache (`tsgolint-core` `host.rs`) then reuses a parse for the same path and options without reading the file again, as Go with patch 0005 reads each file once.
- The last program of a run is not released (`RunSettings::keep_last_program`): the process exits right after it, and freeing its checkers and frontend first only costs time.
- Each payload config becomes one `Arc<[ConfiguredRule]>` in payload order, shared by its files. A file listed by several configs gets the last one. A file is linted with the rules of its program source file's path.
- A config with a name the registry does not know becomes one rule that panics with `unknown rule: <name>` when a file with it is linted. As in tsgolint, that happens on the checker thread after the TypeScript diagnostics, before any rule of the file runs, and only for files that are linted. The panic reaches the loading thread (`lint_program_with` re-raises it) and ends the process with exit code 2, as any rule panic does.
- `-debug timings` and `OXC_LOG=debug` go through `LintDebug`: the engine times each rule's `create` call and each listener call, and logs the name of each file before its rules run, as Go's `RunLinterOnProgram` does.

## Build and test

```sh
cargo build -p tsgolint-rust
cargo test -p tsgolint-rust
```

The unit tests cover flags, payload decoding, JSON escaping and key order, framing, source overrides, rule configs, tsconfig discovery, and the driver on real programs in temp directories (program order, tsconfig errors, missing files, unknown rules, timings). Some compare against output captured from the Go binary:

- `tests/golden.rs` checks diagnostic, error and timing bytes against `tests/data/*.bin`.
- `discovery::tests::matches_go_on_discovery_scenarios` checks the config of every file in `tests/data/discovery` against `expected-go.txt`, which holds the Go binary's `OXC_LOG=debug` lines.
- `tests/cli.rs` runs this binary and the Go binary side by side on flag errors, payload errors, empty payloads and a stdout whose reader has gone. The Go binary is `TSGOLINT_ORACLE`, else the platform binary of the repository's `oxlint-tsgolint` devDependency (`node_modules/.pnpm/node_modules/@oxlint-tsgolint/<platform>-<arch>/tsgolint`; its `node_modules/.bin/tsgolint` wrapper turns a death by signal into exit code 1). Without it, the cases check their written expectations only.

## e2e

`e2e` is tsgolint's vitest suite. It runs the binary that `TSGOLINT_BIN` names, so it checks the native build, the wasm build (through `e2e/tsgolint-wasm.sh`) and the Go binary alike. `crates/scripts/test.sh` runs it for the native and the wasm build; [e2e/README.md](e2e/README.md) shows how to run it by hand.

To compare with the Go binary on a whole project, use `crates/tsgolint-compare` (`tsgolint-compare payload <dir> [--rules a,b] [--type-check]`, then `tsgolint-compare run --go <bin> --rust <bin> --payload <file> [--flags "-fix -fix-suggestions"]`). Go is not deterministic with `--type-check`: run it twice to tell its noise from a real difference.

## WASI

The binary builds for `wasm32-wasip1` (the target is in `rust-toolchain.toml`) and runs under any WASI runtime:

```sh
cargo build --release --target wasm32-wasip1 -p tsgolint-rust
cd /path/to/project
wasmtime run --dir /::/ --env PWD="$PWD" /path/to/target/wasm32-wasip1/release/tsgolint.wasm headless < payload.json
```

- No threads: the loading code, the checker jobs (ts-rust runs them inline on wasm) and the output run on the main thread. The program still has ts-rust's default checker count, so files get the same checkers as natively and the output is the same.
- One checker at a time: the engine sends the semantic job and the lint job of one checker, then drops that checker before the next one is made on its first job. Each checker is still made with the ids it would have had natively, so type ids and union order do not change. Linear memory then holds the program plus one checker's tables instead of four.
- Memory: the bundled libs are unpacked once and their decoder is dropped, each lib parse uses the unpacked text with no copy, and the read cache keeps the text of each parse instead of its own copy. ts-rust's static file table is smaller on wasm, since all of BSS is part of linear memory. The module has no name section (`--strip-all`), so a trap's backtrace shows function indexes.
- The stack: `build.rs` links the binary with a 4 MiB shadow stack for wasm targets. The shadow stack holds only the locals whose address is taken; the runtime's own stack holds the call frames. Real projects use at most 114 KiB of it. The stack is first in memory, so an overflow traps.
- The current directory: WASI has none, and wasi-libc starts at `/`. The binary enters `PWD` when it is set and absolute, so pass `--env PWD=<dir>`.
- Preopen `/` at `/` (`--dir /::/`). Paths in the payload and in the output are host paths, and realpath (which follows pnpm's `node_modules` links) checks every parent directory from the root. With only the project preopened, linked packages resolve under their link paths and types from them go missing.
- Panics abort on wasm, so the panic hook prints `panic: <message>` and exits with code 2 itself.
- `e2e/tsgolint-wasm.sh` runs the module under wasmtime in place of the native binary (`TSGOLINT_BIN=` for the e2e suite, `OXLINT_TSGOLINT_PATH=` for oxlint). It takes the module from `TSGOLINT_WASM` and the runtime from `WASMTIME`, precompiles the module to `<module>.cwasm`, and passes through argv, stdin, the environment, the current directory (as `PWD`) and the exit code.
- With `TSGOLINT_WASM_MEMORY` set, the wasm build prints the size of its linear memory to stderr at exit. Memory only grows, so this is the peak.

## Differences from tsgolint

[DIFFERENCES.md](../DIFFERENCES.md) lists them: the TypeScript 7.1 changes, the deterministic checker per file, the payload order of programs, the empty profiling files, and the error texts after their fixed prefixes.
