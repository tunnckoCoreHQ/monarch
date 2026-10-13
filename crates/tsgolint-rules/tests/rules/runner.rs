//! Runs one case the way tsgolint's rule tester does (Go
//! `rule_tester.RunRuleTester`), and checks the result.

use std::sync::Arc;

use goport_core::frontend::tspath;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use tsgolint_core::text::{ecma_line_starts, line_and_utf16_column};
use tsgolint_core::{
    ConfiguredRule, CreatedProgram, FsFactory, LintEvent, LintFile, LintSettings, ProgramSettings,
    RuleDefinition, RuleDiagnostic, apply_rule_fixes, create_program, lint_program,
};

use crate::cases::{Case, ExpectedSuggestion};
use crate::snapshot::format_diagnostics_snapshot;

/// What a case produced: the part the Go test checks. An accepted
/// divergence pins this value.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub diagnostics: Vec<ObservedDiagnostic>,
    /// The code after each fix pass (invalid cases).
    pub outputs: Vec<String>,
    /// The snapshot text of the first pass.
    pub snapshot: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedDiagnostic {
    pub message_id: String,
    pub line: i32,
    pub column: i32,
    pub end_line: i32,
    pub end_column: i32,
    pub suggestions: Vec<ExpectedSuggestion>,
}

/// Everything a case needs besides its own data.
pub struct CaseSetup<'a> {
    pub fixtures: &'a str,
    pub default_tsconfig: &'a str,
    pub rule: &'static RuleDefinition,
}

impl CaseSetup<'_> {
    /// Lints `code` as the case's file (Go `runLinter`).
    fn lint(&self, case: &Case, code: &str) -> Result<Vec<RuleDiagnostic>, String> {
        let file_name = if !case.file_name.is_empty() {
            case.file_name.as_str()
        } else if case.tsx {
            "react.tsx"
        } else {
            "file.ts"
        };
        let resolved_file_name = tspath::resolve_path(self.fixtures, &[file_name]);
        let mut files = FxHashMap::default();
        files.insert(resolved_file_name.clone(), code.to_owned());
        for (path, text) in &case.files {
            files.insert(tspath::resolve_path(self.fixtures, &[path]), text.clone());
        }
        let fs = FsFactory::exact_overlay(FsFactory::base(), Arc::new(files));
        let tsconfig = if case.tsconfig.is_empty() {
            self.default_tsconfig
        } else {
            &case.tsconfig
        };
        let settings = ProgramSettings {
            single_threaded: true,
            suppress_program_diagnostics: false,
        };
        let program = match create_program(&fs, self.fixtures, tsconfig, settings) {
            Ok(CreatedProgram::Program(program)) => program,
            Ok(CreatedProgram::Invalid(diagnostics)) => {
                return Err(format!(
                    "couldn't create program due to internal diagnostics: {diagnostics:?}"
                ));
            }
            Err(error) => return Err(format!("couldn't create program: {error}")),
        };
        let Some(source_file) = program
            .source_file(file_name)
            .or_else(|| program.source_file(&resolved_file_name))
        else {
            return Err(format!(
                "couldn't get source file: {file_name} (resolved: {resolved_file_name})"
            ));
        };
        let rules: Arc<[ConfiguredRule]> = Arc::new([ConfiguredRule {
            name: "test".to_owned(),
            definition: self.rule,
            options: case.options.clone(),
        }]);
        let mut diagnostics = Vec::new();
        lint_program(
            &program,
            &[LintFile {
                file: source_file,
                rules,
            }],
            LintSettings {
                fix: true,
                fix_suggestions: true,
                report_syntactic: false,
                report_semantic: false,
            },
            &mut |event| {
                if let LintEvent::Rule(diagnostic) = event {
                    diagnostics.push(diagnostic);
                }
            },
        );
        Ok(diagnostics)
    }

    /// A valid case: the result and its failures against the Go test.
    pub fn run_valid(&self, case: &Case) -> Result<(Observed, Vec<String>), String> {
        let diagnostics = self.lint(case, &case.code)?;
        let observed = observe(&case.code, &diagnostics, Vec::new());
        let mut failures = Vec::new();
        if !diagnostics.is_empty() {
            failures.push(format!(
                "Expected valid test case not to contain errors. Code:\n{}",
                case.code
            ));
            for (i, d) in diagnostics.iter().enumerate() {
                failures.push(format!(
                    "error {} - ({}-{}) {}",
                    i + 1,
                    d.range.pos(),
                    d.range.end(),
                    d.message.description
                ));
            }
        }
        Ok((observed, failures))
    }

    /// An invalid case: up to 10 lint and fix passes, then the checks of the
    /// Go test. `snapshot` is the expected snapshot entry, if any.
    pub fn run_invalid(
        &self,
        case: &Case,
        snapshot: Option<&str>,
        snapshot_key: &str,
    ) -> Result<(Observed, Vec<String>), String> {
        let initial = self.lint(case, &case.code)?;
        let mut outputs: Vec<String> = Vec::new();
        let mut result = apply_rule_fixes(&case.code, initial.clone());
        while result.fixed {
            outputs.push(result.output);
            if outputs.len() == 10 {
                break;
            }
            let code = outputs.last().unwrap();
            result = apply_rule_fixes(code, self.lint(case, code)?);
        }
        let observed = observe(&case.code, &initial, outputs);

        let mut failures = Vec::new();
        match snapshot {
            Some(expected) if expected == observed.snapshot => {}
            Some(expected) => failures.push(format!(
                "Snapshot mismatch for {snapshot_key}.\n\n--- Snapshot ---\n{expected}\n\n--- Actual ---\n{}",
                observed.snapshot
            )),
            None => failures.push(format!(
                "No snapshot entry {snapshot_key}.\n\n--- Actual ---\n{}",
                observed.snapshot
            )),
        }
        if case.output.len() != observed.outputs.len() {
            failures.push(format!(
                "Expected to have {} outputs but had {}:\n--- Expected ---\n{:#?}\n--- Actual ---\n{:#?}",
                case.output.len(),
                observed.outputs.len(),
                case.output,
                observed.outputs
            ));
        } else {
            for (i, (expected, actual)) in case.output.iter().zip(&observed.outputs).enumerate() {
                if expected != actual {
                    failures.push(format!(
                        "Expected code after fix {}:\n--- Expected ---\n{expected}\n--- Actual ---\n{actual}",
                        i + 1
                    ));
                }
            }
        }
        if observed.diagnostics.len() != case.errors.len() {
            failures.push(format!(
                "Expected invalid test case to contain exactly {} errors (reported {} errors - {:#?}). Code:\n{}",
                case.errors.len(),
                observed.diagnostics.len(),
                observed.diagnostics,
                case.code
            ));
            return Ok((observed, failures));
        }
        for (i, (expected, actual)) in case.errors.iter().zip(&observed.diagnostics).enumerate() {
            let at = |what: &str| format!("error {}: {what}", i + 1);
            if expected.message_id != actual.message_id {
                failures.push(at(&format!(
                    "Invalid message id {}. Expected {}",
                    actual.message_id, expected.message_id
                )));
            }
            for (name, want, got) in [
                ("line", expected.line, actual.line),
                ("column", expected.column, actual.column),
                ("end line", expected.end_line, actual.end_line),
                ("end column", expected.end_column, actual.end_column),
            ] {
                if want != 0 && want != got {
                    failures.push(at(&format!("Error {name} should be {want}. Got {got}")));
                }
            }
            if expected.suggestions.len() != actual.suggestions.len() {
                failures.push(at(&format!(
                    "Expected to have {} suggestions but had {}",
                    expected.suggestions.len(),
                    actual.suggestions.len()
                )));
                continue;
            }
            for (want, got) in expected.suggestions.iter().zip(&actual.suggestions) {
                if want.message_id != got.message_id {
                    failures.push(at(&format!(
                        "Invalid suggestion message id {}. Expected {}",
                        got.message_id, want.message_id
                    )));
                } else if want.output != got.output {
                    failures.push(at(&format!(
                        "Expected code after suggestion fix:\n--- Expected ---\n{}\n--- Actual ---\n{}",
                        want.output, got.output
                    )));
                }
            }
        }
        Ok((observed, failures))
    }
}

/// The checked parts of `diagnostics` of `code`: message ids, 1-based
/// untrimmed positions with UTF-16 columns, suggestions applied to `code`,
/// and the snapshot.
fn observe(code: &str, diagnostics: &[RuleDiagnostic], outputs: Vec<String>) -> Observed {
    let line_starts = ecma_line_starts(code);
    let position = |pos: i32| {
        let (line, column) = line_and_utf16_column(&line_starts, code, pos);
        (line + 1, column + 1)
    };
    let observed = diagnostics
        .iter()
        .map(|d| {
            let (line, column) = position(d.range.pos());
            let (end_line, end_column) = position(d.range.end());
            let suggestions = d
                .suggestions()
                .iter()
                .map(|suggestion| ExpectedSuggestion {
                    message_id: suggestion.message.id.clone(),
                    output: apply_rule_fixes(code, vec![suggestion.clone()]).output,
                })
                .collect();
            ObservedDiagnostic {
                message_id: d.message.id.clone(),
                line,
                column,
                end_line,
                end_column,
                suggestions,
            }
        })
        .collect();
    Observed {
        diagnostics: observed,
        outputs,
        snapshot: format_diagnostics_snapshot(code, diagnostics),
    }
}

/// An accepted divergence from tsgolint (`tests/data/divergences/<rule>.json`).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Divergence {
    /// Why the Rust result differs (the TypeScript change behind it).
    pub reason: String,
    /// The pinned Rust result.
    pub result: Observed,
}

pub type Divergences = FxHashMap<String, Divergence>;
