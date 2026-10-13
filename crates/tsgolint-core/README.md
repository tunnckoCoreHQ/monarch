# tsgolint-core

Program loading, the rule framework and the lint engine of tsgolint-rust. Read `crates/ARCHITECTURE.md` and `crates/CONTRIBUTING.md` first.

## Modules

| Module | What it has |
|---|---|
| `diagnostic` | The contract types: `TextRange` (ts-rust's `ast::TextRange`, UTF-8 byte offsets), `RuleMessage`, `RuleFix`, `RuleSuggestion`, `LabeledRange`, `RuleDiagnostic`, `InternalDiagnostic`, `LintEvent`. |
| `rule` | `RuleDefinition`, `ConfiguredRule`, `Listener` and `Phase`, `Listeners<S>`, `RuleListeners`, `RuleContext`, `Report`, `FixFlags`, and the fix constructors on `RuleFix`. |
| `traverse` | `visit_lint_nodes`: tsgolint's AST walk with the pattern events. |
| `engine` | `lint_program`, `lint_program_with` and `LintDebug` (timings, per-file hook), `LintFile`, `LintSettings`. |
| `timing` | `RuleTimings` and `RuleTimingRecord` for `-debug timings`. |
| `program` | `create_program`, `create_inferred_program`, `Program`, `CreatedProgram`, `ProgramSettings`. |
| `fs` | `FsFactory` (`base`, `exact_overlay`, `source_overrides`), `OverlayFs` (exact keys for the rule tester, canonical keys for `source_overrides`). |
| `fixer` | `apply_rule_fixes` (Go `linter.ApplyRuleFixes`). |
| `options` | `decode_options::<T>` and `BoolOr<T>`. |
| `text` | ECMA line starts, UTF-16 columns, `trim_node_text_range`, `token_range_at`, and byte-safe text slices (`text_slice`, `range_text`, `node_text`). |

## Writing a rule

A rule module in `crates/tsgolint-rules/src/rules/<snake_name>.rs` exports `RULE`, and `src/rules/mod.rs` lists it in `ALL_RULES`. `create` runs once per linted file. It gets the context and the rule's JSON options (`null` when none), may report at once, and returns its listeners. A listener is a `Listener` (a `SyntaxKind` means "enter") and a handler `fn(&mut State, &mut RuleContext, Node)`. `State` is the rule's value for this file: its options, and any stack it keeps between enter and exit events. Handlers are plain functions or non-capturing closures; everything they need is in the state or the context.

This is `no-meaningless-void-operator`, complete (`src/rules/no_meaningless_void_operator.rs`):

```rust
use goport_core::ast::{is_assignment_expression, skip_outer_expressions};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::{OuterExpressionKinds, TypeFlags};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    decode_options,
};

use crate::utils::union_type_parts;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-meaningless-void-operator",
    create,
};

// The schema.json defaults are the `Default` impl. Missing and `null`
// properties take them.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    check_never: bool,
}

fn meaningless_void_operator_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "meaninglessVoidOperator",
        format!(
            "void operator shouldn't be used on {type_name}; \
             it should convey that a return value is being ignored"
        ),
    )
}

fn remove_void_message() -> RuleMessage {
    RuleMessage::new("removeVoid", "Remove 'void'")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::VoidExpression, check_void)
        .into()
}

fn check_void(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let argument = node.expression();
    let inner = skip_outer_expressions(
        argument,
        OuterExpressionKinds::OEK_PARENTHESES
            | OuterExpressionKinds::OEK_ASSERTIONS
            | OuterExpressionKinds::OEK_COMMA,
    );
    // `void (x = value)` explicitly discards the assignment result.
    if is_assignment_expression(inner, false) {
        return;
    }
    let argument_type = ctx.checker.get_type_at_location(argument);
    let parts = union_type_parts(ctx.checker, argument_type);
    let all_have = |flags: TypeFlags| {
        parts
            .iter()
            .all(|&t| ctx.checker.ty(t).flags.intersects(flags))
    };
    let always_void_like = all_have(TypeFlags::VOID_LIKE);
    let always_void_like_or_never = all_have(TypeFlags::VOID_LIKE | TypeFlags::NEVER);

    let remove_void = |ctx: &mut RuleContext<'_>| {
        RuleFix::remove_range(ctx.trim_node_text_range(node).with_end(argument.pos()))
    };
    if always_void_like {
        // Compute the message first: it needs `ctx.checker` mutably.
        let message = meaningless_void_operator_message(&ctx.checker.type_to_string(argument_type));
        ctx.report_node_with_fixes(node, message, |ctx| vec![remove_void(ctx)]);
    } else if options.check_never && always_void_like_or_never {
        let message = meaningless_void_operator_message(&ctx.checker.type_to_string(argument_type));
        ctx.report_node_with_suggestions(node, message, |ctx| {
            vec![RuleSuggestion {
                message: remove_void_message(),
                fixes: vec![remove_void(ctx)],
            }]
        });
    }
}
```

### Listeners

| Go | Rust |
|---|---|
| `ast.KindX` | `SyntaxKind::X` (or `Listener::enter(SyntaxKind::X)`) |
| `rule.ListenerOnExit(ast.KindX)` | `Listener::exit(SyntaxKind::X)` |
| `rule.ListenerOnAllowPattern(k)` / its exit | `Listener::allow_pattern(k)` / `Listener::exit_allow_pattern(k)` |
| `rule.ListenerOnNotAllowPattern(k)` / its exit | `Listener::not_allow_pattern(k)` / `Listener::exit_not_allow_pattern(k)` |

Listeners of one event run in configured rule order. The walk skips the SourceFile node, uses `for_each_child` order, visits the operator token of `=`, and has pattern events only on the left of a plain `=` assignment (see `traverse.rs`).

A rule that needs nothing per file returns `RuleListeners::none()`. A rule with state per file puts it in the state value: `Listeners::new(State { options, stack: Vec::new() })`.

### The context

| Go `ctx.` | Rust `ctx.` |
|---|---|
| `TypeChecker` | `checker` (`&mut Checker`, a pub field) |
| `SourceFile` | `source_file` (`Node`), `source_text()` for its text, `range_text(r)` for `Text()[r.Pos():r.End()]`, `node_text(n)` for the text of a trimmed node |
| `Program.Options()` | `compiler_options()` |
| `Program.Host().FS()` | `fs()` (works on the checker thread) |
| `ReportNode(n, msg)` | `report_node(n, msg)` (trimmed range) |
| `ReportNodeWithFixes(n, msg, fn)` | `report_node_with_fixes(n, msg, \|ctx\| vec![...])` |
| `ReportNodeWithSuggestions(n, msg, fn)` | `report_node_with_suggestions(n, msg, \|ctx\| vec![...])` |
| `ReportRange(r, msg)` | `report_range(r, msg)` (range as given) |
| `ReportRangeWithSuggestions` | `report_range_with_suggestions(r, msg, \|ctx\| ...)` |
| `ReportDiagnostic(d)` | `report_diagnostic(Report::new(range, msg).with_label(label, range))` |
| `ReportDiagnosticWithFixes(d, fn)` / `...WithSuggestions` | `report_diagnostic_with_fixes(report, \|ctx\| ...)` / `report_diagnostic_with_suggestions` |
| `rule.ReportNodeWithFixesOrSuggestions(ctx, n, fix, msg, sugMsg, fixes...)` | `report_node_with_fixes_or_suggestions(n, fix, msg, sug_msg, fixes)` |

A fix or suggestion closure runs only when its flag is on, as in Go. It gets the context back, so it can use the checker and the source file. The rule name and the file of a diagnostic come from the context.

Fix constructors (`RuleFix::`): `insert_before(sf, node, text)` and `replace(sf, node, text)` and `remove(sf, node)` use the trimmed node range; `insert_after(node, text)` uses `node.end()`; `wrap_in_parens(sf, node)` is both, with `(` and `)`; `replace_range(range, text)` and `remove_range(range)` use the range as given. `ctx.fix_insert_before`, `ctx.fix_replace`, `ctx.fix_remove` and `ctx.fix_wrap_in_parens` fill in the source file.

### Options

`decode_options::<T>(options, RULE.name)` decodes the JSON value as Go's generated `UnmarshalJSON` does: `null` or missing properties (top level and nested) take the `Default` value, unknown keys are ignored, keys are case-sensitive, and a non-object or a wrong type panics with `<rule>: failed to unmarshal options: ...`. Put `#[serde(default, rename_all = "camelCase")]` on the struct and write `Default` from `schema.json`. Use `BoolOr<T>` for options that are a boolean or an object. Rules that ignore options in Go ignore the value.

## Porting recipe

Read the Go rule and its helpers, then map each call. ts-rust keeps typescript-go's names in snake case and its module layout (`goport_core::checker`, `ast`, `scanner_util`, `program`); its `crates/ts_goport/PORTING.md` gives the naming rules.

- `ctx.TypeChecker.GetTypeAtLocation(n)` is `ctx.checker.get_type_at_location(n)`. Exported Go methods whose snake name clashes with an unexported one end in `_exported` (`get_symbol_at_location_exported`, `resolve_alias_exported`, `get_resolved_signature_exported`). `TypeToString` is `type_to_string`.
- `checker.Checker_xxx(ctx.TypeChecker, args)` (the shim's linked unexported functions) is `ctx.checker.xxx(args)`, e.g. `Checker_isArrayOrTupleType` is `is_array_or_tuple_type`, `Checker_getBaseConstraintOfType` is `get_base_constraint_of_type`. A nil result is `TypeId::NIL` (test with `.is_some()`).
- `checker.Type_flags(t)`, `t.Flags()` is `ctx.checker.ty(t).flags`; `t.Types()` is `ctx.checker.ty(t).types()` (or `types_list()` to keep it across `&mut` calls); `checker.Type_symbol(t)` is `ctx.checker.ty(t).symbol`; symbol fields are `ctx.checker.sym(s).declarations`, `.flags`, `.value_declaration`.
- Flags: `checker.TypeFlagsUnion` is `goport_core::flags::TypeFlags::UNION`, tested with `.intersects(..)`.
- `ast.IsX(n)` is `goport_core::ast::is_x(n)`; `ast.SkipParentheses` is `skip_parentheses`; `node.AsX().Field` is `node.field()` (`node.expression()`, `node.left()`, `node.arguments()`, `node.argument_expression()`, ...); `node.Kind` is `node.kind()`. `sourceFile.Text()` is `ctx.source_text()`; `node.text()` returns `""` on a SourceFile.
- `scanner.GetRangeOfTokenAtPosition(sf, pos)` is `tsgolint_core::text::token_range_at(sf, pos)`; `utils.TrimNodeTextRange(sf, n)` is `ctx.trim_node_text_range(n)`; other scanner helpers are in `goport_core::scanner_util`.
- Slice source text with `ctx.range_text(range)` or `ctx.node_text(node)`, not `&text[a..b]`. Go slices bytes, so a bound inside a char does not panic there; these helpers cut the char the same way.
- `utils.X` helpers are ported to `crate::utils` (`src/utils`).
- Ids are `Copy`. Copy them out of `ctx.checker.ty(..)` and `sym(..)` borrows before the next checker call. Build a message that needs the checker before the `ctx.report_*` call.
- Messages, help texts and suggestion texts are output: copy them byte for byte. Keep the order in which Go reports.

## Running the rule tests

```
cargo test -p tsgolint-rules --test rules -- <rule-name or case key> --test-threads 4
```

Trials are `<rule>::<GoTest>/valid-<i>` and `<rule>::<GoTest>/invalid-<i>`. Cases that tsgolint skips are ignored. Each case builds a program over `tests/data/fixtures` with the case file in an overlay, runs the rule as `"test"` with fixes and suggestions on, and checks the diagnostics, positions, fix passes, suggestion outputs and the snapshot entry in `tests/data/snapshots/<rule>.snap`. Accepted differences from tsgolint are pinned in `tests/data/divergences/` (see `tests/data/divergences.md`). An entry that names no case fails the run.

## Running the engine

All ts-rust work runs on a loading thread with `goport_core::gostd::stack::max_stack_size()`. Create, lint and drop a program on that thread.

```rust
use std::sync::Arc;
use tsgolint_core::*;

let fs = FsFactory::base();
let program = match create_program(&fs, &config_dir, &config_path, ProgramSettings { single_threaded: false, suppress_program_diagnostics: false })? {
    CreatedProgram::Program(program) => program,
    CreatedProgram::Invalid(diagnostics) => { /* emit each as kind 1, skip the program */ }
};
let rules: Arc<[ConfiguredRule]> = Arc::new([ConfiguredRule::new(tsgolint_rules::find_rule("no-floating-promises").unwrap(), options)]);
let files: Vec<LintFile> = program
    .source_files()
    .into_iter()
    .filter(|&file| wanted(file))
    .map(|file| LintFile { file, rules: rules.clone() })
    .collect();
lint_program(&program, &files, LintSettings { fix, fix_suggestions, report_syntactic, report_semantic }, &mut |event| emit(event));
drop(program); // releases the ts-rust program version
```

- `lint_program` delivers TypeScript diagnostics first (syntactic, then semantic, file by file in `files` order), then rule diagnostics as checker threads produce them. Diagnostics of one file keep their report order. A rule panic continues on the calling thread after the other jobs end.
- `create_inferred_program(&fs, cwd, file_names, single_threaded)` makes the program of unmatched files with tsgolint's fixed options.
- `Program::source_file(name)` finds a file; `source_files()` lists them in program order; `enter()` makes the program current for direct `goport_core` reads.
- Program loads are serialized in the process (ts-rust gives the stores of one load consecutive ids); loaded programs can be linted in parallel.
- Parsed files are cached per loading thread, keyed by file name, path, parse options and text, as tsgolint's host does. Programs on one thread share the parses of libs and common files, so memory grows by about the size of the new files per program.
- On wasm, ts-rust runs checker jobs inline; the engine starts no thread of its own, and drops each checker after its jobs (`release_checker`), so it lints a program once.
- `FsFactory` describes a file system that each thread can make (`Rc<dyn Fs>` is per thread). `FsFactory::base()` is the OS file system with the process read cache (tsgolint patch 0005), lookup caches and bundled libs. `FsFactory::source_overrides(files)` (keys from `OverlayFs::canonical_key`) is the headless overlay under the same caches (Go `bundled.WrapFS(cachedvfs.From(overlay(osvfs)))`); each thread makes its value once, so programs and checker jobs of a thread share the caches, and `ctx.fs()` sees the overrides.
- `lint_program_with(.., LintDebug { timings, on_file }, ..)` returns `RuleTimings`: one call for each `create` plus one for each listener call, in nanoseconds, merged by rule name over files and checkers. `on_file` runs on the checker thread with each file name before its rules run.
- A rule name that is not in the registry is the driver's concern; tsgolint panics with `unknown rule: <name>` when it lints a file with it. A `RuleDefinition` whose `create` panics with `ctx.rule_name()` reproduces that.
