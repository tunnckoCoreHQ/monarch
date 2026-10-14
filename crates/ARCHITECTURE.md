# tsgolint-rust architecture

tsgolint-rust is a Rust port of [oxc-project/tsgolint](https://github.com/oxc-project/tsgolint) at tag v7.0.2003. It is the type-aware linter that oxlint spawns for `--type-aware` and `--type-check`. It builds on [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) (tsc-rs, a Rust port of TypeScript 7) as the parser, binder and checker.

The port matches tsgolint's behavior, not its code. Same command line, same `headless` protocol, same rules, options, messages, fixes and suggestions. The design is a Rust design: no goroutine, channel-everywhere or `defer` patterns copied from Go.

## Crates

| Crate | Kind | Owns |
|---|---|---|
| `crates/tsgolint-core` | lib | Program loading over ts-rust, the file systems (overlay, cache, in-memory), the rule framework (`RuleDefinition`, `RuleContext`, listeners, diagnostics, fixes, suggestions), the AST traversal, the per-program lint engine with TypeScript diagnostics, fix application, options decoding, text helpers (ECMA lines, UTF-16 columns, trimmed node ranges). |
| `crates/tsgolint-rules` | lib | The 60 rules, the helpers they share (`src/utils`), the rule registry, and the rule test harness (`tests/rules`) with tsgolint's test cases and snapshots. |
| `crates/tsgolint-rust` | bin `tsgolint` + lib | The command line (Go `flag` syntax), the `headless` protocol (payload decoding, message framing, JSON encoding), the rules of each payload file, tsconfig discovery, the multi-program driver on tsgolint-core, the legacy CLI output, the WASI build, and the e2e suite. |

Dependency direction: `tsgolint-rust` uses `tsgolint-rules` and `tsgolint-core`; `tsgolint-rules` uses `tsgolint-core`. All three use `goport_core` (ts-rust) directly. Nothing uses ts-rust's `ts_goport` crate (language server, project service), so the build stays at `goport_core` + `goport_util`. `goport_core` compiles its modules from `crates/ts_goport/src` of the ts-rust repository.

## Execution model

ts-rust keeps the program as per-thread state, and each checker lives on its own thread. The design follows that model.

1. The main thread parses flags, reads stdin to EOF and decodes the payload. It turns each payload config into tsgolint-core `ConfiguredRule`s (one shared list per config) and makes the run's file system: one `FsFactory` with the payload's `source_overrides`, from which each thread makes its own value.
2. A loading thread with a large stack (`gostd::stack::max_stack_size()`) resolves each file to a tsconfig (or to the inferred program), then handles one program at a time: create the program, check program diagnostics, bind, collect TypeScript diagnostics, lint, release the program. The driver calls tsgolint-core directly (`create_program`, `create_inferred_program`, `lint_program_with`).
3. Linting runs as checker jobs. The engine groups the files of a program by the checker that ts-rust assigns to them, and sends one job per group. A job builds the rule instances for each file on the checker thread, walks the AST, and sends each diagnostic as plain data to the loading thread. Rules get `&mut Checker`; no rule state crosses threads. A rule panic, or the `unknown rule: <name>` panic of a file whose config names an unknown rule, comes back to the loading thread when the jobs end and ends the process with exit code 2.
4. The loading thread also writes the output. It frames each diagnostic (u32 LE length, type byte, compact JSON) into a 400 KB buffer, which it flushes when less than 4 KB is free and at the end, as tsgolint does. So the output streams while later files are linted. When stdout's reader has gone, the next write ends the process by SIGPIPE, as in Go.
5. Under `target_os = "wasi"` there are no threads. The same code runs on the main thread, and ts-rust runs checker jobs inline on wasm. ts-rust makes each checker on its first job, and the engine drops it after its jobs, so one checker's tables are alive at a time. The binary links a 4 MiB wasm shadow stack, takes the current directory from `PWD`, and needs `/` preopened at `/` (see `crates/tsgolint-rust/README.md`).

A panic on any thread prints `panic: <message>` on stderr and ends the process with exit code 2, as a Go panic does.

The order of TypeScript diagnostics before rule diagnostics in each program, the order of rule diagnostics in each file, and the per-file rule order match tsgolint. tsgolint itself emits programs in random map order and interleaves files across workers; oxlint and the e2e suite do not depend on that order.

## The contract between the crates

These types are the shared vocabulary. Their names and fields are fixed; their methods can grow.

```rust
// tsgolint_core::diagnostic
pub use goport_core::ast::TextRange;  // UTF-8 byte offsets, read with pos() and end()
pub struct RuleMessage { pub id: String, pub description: String, pub help: String }   // empty help = none
pub struct RuleFix { pub text: String, pub range: TextRange }
pub struct RuleSuggestion { pub message: RuleMessage, pub fixes: Vec<RuleFix> }
pub struct LabeledRange { pub label: String, pub range: TextRange }
pub struct RuleDiagnostic {
    pub rule: String,                 // the configured rule name
    pub file_name: String,            // the program's SourceFile file name
    pub range: TextRange,
    pub message: RuleMessage,
    pub labeled_ranges: Vec<LabeledRange>,
    pub fixes: Option<Vec<RuleFix>>,               // None when the fix closure did not run
    pub suggestions: Option<Vec<RuleSuggestion>>,  // None when the suggestion closure did not run
}
pub struct InternalDiagnostic {       // tsconfig errors and TSxxxx type errors, kind 1 in the protocol
    pub range: Option<TextRange>,     // None when the location is invalid
    pub id: String,                   // "tsconfig-error" or "TS2322"
    pub description: String,
    pub help: String,
    pub file_path: String,
}
pub enum LintEvent { Rule(RuleDiagnostic), Internal(InternalDiagnostic) }
```

The core crate exposes program creation (configured and inferred, with tsgolint's error and suppression rules), the file systems (`FsFactory`, with `FsFactory::source_overrides` for the headless overlay), and one entry point that lints a set of files of one program with TypeScript diagnostics first, delivering `LintEvent`s to a callback on the loading thread (`lint_program`; `lint_program_with` adds `LintDebug`: per-rule timings as `RuleTimings`, and a per-file hook for the `OXC_LOG=debug` lines). The rules crate exposes `ALL_RULES` and a lookup by name.

## Tests

- **Rule tests.** `cargo test -p tsgolint-rules --test rules [-- <filter>]` runs the 7,574 test cases that tsgolint's Go tests define (`tests/data/cases/*.json`, dumped from the Go tests with options serialized as the rules receive them). Each case checks the diagnostics, message ids, positions, fix passes and suggestion outputs, and each invalid case checks the snapshot in `tests/data/snapshots` (tsgolint's `.snap` files, verbatim). Accepted differences that come from ts-rust's newer TypeScript revision are listed, with the reason, in `tests/data/divergences.md` and recorded in `tests/data/divergences/`.
- **e2e.** `crates/tsgolint-rust/e2e` is tsgolint's vitest suite with its fixtures. It spawns the binary named by `TSGOLINT_BIN`.
- **Oracle comparison.** The Go binary is the repository's `oxlint-tsgolint` devDependency. `crates/tsgolint-rust/tests/cli.rs` runs its platform binary next to this binary on flag errors, payload errors and empty payloads. `crates/tsgolint-compare` runs both binaries on the payload of a real project, normalizes the outputs and diffs them.

## TypeScript version

tsgolint v7.0.2003 uses typescript-go `2bd066d87f5b` (the TypeScript 7.0 release branch, 2026-07-07). ts-rust comes from [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust), branch `main`, at the commit in `Cargo.lock` (now `598e6416`). It ports microsoft/TypeScript `fed0bf24149f` (7.1.0-dev, 2026-10-08). Checker output can differ between the two revisions, so some type strings in messages, and rarely a diagnostic, can differ. Each such difference is listed with its cause.
