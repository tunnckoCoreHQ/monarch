//! Program creation and the lint engine against tsgolint's e2e
//! expectations (fixtures copied from tsgolint's `e2e/fixtures`).

use std::sync::Arc;

use goport_core::astdata::SyntaxKind;
use rustc_hash::FxHashMap;
use serde_json::Value;
use tsgolint_core::{
    ConfiguredRule, CreatedProgram, FsFactory, InternalDiagnostic, LintEvent, LintFile,
    LintSettings, Listener, Listeners, Program, ProgramSettings, RuleContext, RuleDefinition,
    RuleFix, RuleListeners, RuleMessage, TextRange, create_program,
};

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Runs `f` on a thread with ts-rust's stack size.
fn on_loading_thread<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::Builder::new()
        .stack_size(goport_core::gostd::stack::max_stack_size())
        .spawn(f)
        .unwrap()
        .join()
        .unwrap_or_else(|payload| std::panic::resume_unwind(payload))
}

fn settings(single_threaded: bool) -> ProgramSettings {
    ProgramSettings {
        single_threaded,
        suppress_program_diagnostics: false,
    }
}

fn invalid(dir: &str) -> Vec<InternalDiagnostic> {
    match create_program(&FsFactory::base(), dir, "tsconfig.json", settings(false)) {
        Ok(CreatedProgram::Invalid(diagnostics)) => diagnostics,
        Ok(CreatedProgram::Program(_)) => panic!("expected an invalid tsconfig"),
        Err(error) => panic!("{error}"),
    }
}

fn program(fs: &FsFactory, dir: &str, single_threaded: bool) -> Program {
    match create_program(fs, dir, "tsconfig.json", settings(single_threaded)) {
        Ok(CreatedProgram::Program(program)) => program,
        Ok(CreatedProgram::Invalid(diagnostics)) => panic!("invalid: {diagnostics:?}"),
        Err(error) => panic!("{error}"),
    }
}

/// Lints `names` (in program order) of `program` with `rules`.
fn lint(
    program: &Program,
    names: &[&str],
    rules: Vec<ConfiguredRule>,
    settings: LintSettings,
) -> Vec<LintEvent> {
    let rules: Arc<[ConfiguredRule]> = rules.into();
    let mut files: Vec<LintFile> = names
        .iter()
        .map(|name| LintFile {
            file: program
                .source_file(name)
                .unwrap_or_else(|| panic!("no file {name}")),
            rules: rules.clone(),
        })
        .collect();
    let order = program.source_files();
    files.sort_by_key(|f| order.iter().position(|&n| n == f.file));
    let mut events = Vec::new();
    tsgolint_core::lint_program(program, &files, settings, &mut |event| events.push(event));
    events
}

#[test]
fn missing_tsconfig_is_an_error() {
    on_loading_thread(|| {
        let dir = fixture("report-type-errors");
        let result = create_program(&FsFactory::base(), &dir, "nope.json", settings(true));
        assert_eq!(
            result.err().unwrap(),
            format!("couldn't read tsconfig at {dir}/nope.json")
        );
    });
}

#[test]
fn unparsable_tsconfig_reports_its_first_parse_error() {
    on_loading_thread(|| {
        let dir = fixture("with-invalid-tsconfig-json");
        let diagnostics = invalid(&dir);
        assert_eq!(
            diagnostics,
            [InternalDiagnostic {
                range: Some(TextRange::new(25, 25)),
                id: "tsconfig-error".into(),
                description: "Invalid tsconfig".into(),
                help: "Unterminated string literal.".into(),
                file_path: format!("{dir}/tsconfig.json"),
            }]
        );
    });
}

#[test]
fn removed_option_gets_the_issue_link() {
    on_loading_thread(|| {
        let dir = fixture("with-invalid-tsconfig-option");
        let diagnostics = invalid(&dir);
        assert_eq!(
            diagnostics,
            [InternalDiagnostic {
                range: Some(TextRange::new(35, 44)),
                id: "tsconfig-error".into(),
                description: "Invalid tsconfig".into(),
                help: "Option 'baseUrl' has been removed. Please remove it from your configuration.\nSee https://github.com/oxc-project/tsgolint/issues/351 for more information.".into(),
                file_path: format!("{dir}/tsconfig.json"),
            }]
        );
        // The suppress flag ignores program diagnostics.
        let suppressed = create_program(
            &FsFactory::base(),
            &dir,
            "tsconfig.json",
            ProgramSettings {
                single_threaded: false,
                suppress_program_diagnostics: true,
            },
        );
        assert!(matches!(suppressed, Ok(CreatedProgram::Program(_))));
    });
}

fn internal(events: &[LintEvent]) -> Vec<(String, String, Option<TextRange>, String)> {
    events
        .iter()
        .map(|event| match event {
            LintEvent::Internal(d) => (
                d.file_path.rsplit('/').next().unwrap().to_owned(),
                d.id.clone(),
                d.range,
                d.description.clone(),
            ),
            LintEvent::Rule(d) => panic!("rule diagnostic {d:?}"),
        })
        .collect()
}

#[test]
fn reports_type_errors() {
    on_loading_thread(|| {
        let dir = fixture("report-type-errors");
        let program = program(&FsFactory::base(), &dir, false);
        let all = LintSettings {
            report_syntactic: true,
            report_semantic: true,
            ..Default::default()
        };
        let events = lint(&program, &["index.ts"], Vec::new(), all);
        assert_eq!(
            internal(&events),
            [(
                "index.ts".into(),
                "TS2322".into(),
                Some(TextRange::new(6, 7)),
                "Type 'number' is not assignable to type 'string'.".into()
            )]
        );
        assert!(lint(&program, &["index.ts"], Vec::new(), LintSettings::default()).is_empty());
    });
}

#[test]
fn reports_syntactic_then_semantic_diagnostics() {
    on_loading_thread(|| {
        let dir = fixture("semantic-syntactic-diagnostics");
        let program = program(&FsFactory::base(), &dir, false);
        let all = LintSettings {
            report_syntactic: true,
            report_semantic: true,
            ..Default::default()
        };
        let events = lint(&program, &["src/a.ts", "src/b.mts"], Vec::new(), all);
        assert_eq!(
            internal(&events),
            [
                (
                    "a.ts".into(),
                    "TS1002".into(),
                    Some(TextRange::new(24, 24)),
                    "Unterminated string literal.".into()
                ),
                (
                    "b.mts".into(),
                    "TS2322".into(),
                    Some(TextRange::new(6, 7)),
                    "Type 'string' is not assignable to type 'number'.".into()
                ),
            ]
        );
    });
}

fn message(id: &str) -> RuleMessage {
    RuleMessage::new(id, id)
}

/// Reports at creation, then on pattern events. Its fix closure panics, so
/// a run with fixes off proves the closure does not run.
static EVENTS_RULE: RuleDefinition = RuleDefinition {
    name: "events",
    create: |ctx, options| {
        ctx.report_range(TextRange::new(0, 0), message(&format!("created {options}")));
        Listeners::new(0usize)
            .on(
                Listener::allow_pattern(SyntaxKind::ArrayLiteralExpression),
                |n, ctx, node| {
                    *n += 1;
                    ctx.report_node(node, message(&format!("allow-array {n}")));
                },
            )
            .on(
                Listener::not_allow_pattern(SyntaxKind::ArrayLiteralExpression),
                |n, ctx, node| {
                    *n += 1;
                    ctx.report_node(node, message(&format!("not-allow-array {n}")));
                },
            )
            .on(SyntaxKind::EqualsToken, |_, ctx, node| {
                ctx.report_node_with_fixes(node, message("operator"), |_| {
                    panic!("fix closure ran")
                });
            })
            .on(
                Listener::exit(SyntaxKind::BinaryExpression),
                |_, ctx, node| {
                    ctx.report_node(node, message("exit-binary"));
                },
            )
            .into()
    },
};

static SECOND_RULE: RuleDefinition = RuleDefinition {
    name: "second",
    create: |_ctx: &mut RuleContext<'_>, _options: &Value| -> RuleListeners {
        Listeners::new(())
            .on(SyntaxKind::EqualsToken, |_, ctx, node| {
                ctx.report_node_with_fixes(node, message("second"), |ctx| {
                    vec![ctx.fix_replace(node, "==")]
                });
            })
            .into()
    },
};

#[test]
fn runs_listeners_in_traversal_and_rule_order() {
    on_loading_thread(|| {
        let dir = fixture("report-type-errors");
        let code = "let a = 0, b = 0;\n[a, b] = [1, 2];\n";
        let files: FxHashMap<String, String> = [(format!("{dir}/index.ts"), code.to_owned())]
            .into_iter()
            .collect();
        let fs = FsFactory::exact_overlay(FsFactory::base(), Arc::new(files));
        let program = program(&fs, &dir, true);
        let rules = vec![
            ConfiguredRule {
                name: "first".into(),
                definition: &EVENTS_RULE,
                options: serde_json::json!({"x": 1}),
            },
            ConfiguredRule::new(&SECOND_RULE, Value::Null),
        ];
        let events = lint(&program, &["index.ts"], rules, LintSettings::default());
        let seen: Vec<(String, String, String)> = events
            .iter()
            .map(|event| match event {
                LintEvent::Rule(d) => (
                    d.rule.clone(),
                    d.message.id.clone(),
                    code[d.range.pos() as usize..d.range.end() as usize].to_owned(),
                ),
                LintEvent::Internal(d) => panic!("{d:?}"),
            })
            .collect();
        let expect =
            |rule: &str, id: &str, text: &str| (rule.to_owned(), id.to_owned(), text.to_owned());
        assert_eq!(
            seen,
            [
                expect("first", "created {\"x\":1}", ""),
                // `let a = 0` is not an assignment expression.
                expect("first", "allow-array 1", "[a, b]"),
                expect("first", "operator", "="),
                expect("second", "second", "="),
                expect("first", "not-allow-array 2", "[1, 2]"),
                expect("first", "exit-binary", "[a, b] = [1, 2]"),
            ]
        );
        let LintEvent::Rule(second) = &events[3] else {
            unreachable!()
        };
        assert_eq!(second.fixes, None, "fixes are off");

        let with_fixes = LintSettings {
            fix: true,
            ..Default::default()
        };
        let rules = vec![ConfiguredRule::new(&SECOND_RULE, Value::Null)];
        let events = lint(&program, &["index.ts"], rules, with_fixes);
        let LintEvent::Rule(d) = &events[0] else {
            unreachable!()
        };
        assert_eq!(
            d.fixes,
            Some(vec![RuleFix::replace_range(TextRange::new(25, 26), "==")])
        );
    });
}
