//! Program loading, the rule framework and the lint engine of tsgolint-rust.
//!
//! See `README.md` in this crate for how to write a rule and how to run the
//! engine.

pub mod diagnostic;
pub mod engine;
pub mod fixer;
pub mod fs;
mod host;
pub mod options;
pub mod program;
pub mod rule;
pub mod text;
pub mod timing;
pub mod traverse;

pub use diagnostic::{
    InternalDiagnostic, LabeledRange, LintEvent, RuleDiagnostic, RuleFix, RuleMessage,
    RuleSuggestion, TextRange,
};
pub use engine::{LintDebug, LintFile, LintSettings, lint_program, lint_program_with};
pub use fixer::{FixResult, HasFixes, apply_rule_fixes};
pub use fs::{FsFactory, OverlayFs};
pub use options::{BoolOr, decode_options};
pub use program::{
    CreatedProgram, Program, ProgramSettings, create_inferred_program, create_program,
};
pub use rule::{
    ConfiguredRule, FixFlags, Handler, Listener, Listeners, Phase, Report, RuleContext,
    RuleDefinition, RuleListeners,
};
pub use text::{node_text, range_text, trim_node_text_range};
pub use timing::{RuleTimingRecord, RuleTimings};
