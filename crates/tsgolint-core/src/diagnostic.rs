//! The data that leaves the lint engine: rule diagnostics, internal
//! diagnostics (tsconfig errors and TypeScript errors), fixes and
//! suggestions. These are plain `Send` values; they cross from the checker
//! threads to the loading thread.

/// A range of UTF-8 byte offsets into the source text (Go `core.TextRange`).
pub use goport_core::ast::TextRange;

/// The message of a diagnostic or a suggestion. An empty `help` means none.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuleMessage {
    pub id: String,
    pub description: String,
    pub help: String,
}

impl RuleMessage {
    pub fn new(id: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            description: description.into(),
            help: String::new(),
        }
    }

    #[must_use]
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = help.into();
        self
    }
}

/// One text edit. `range` is replaced with `text`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleFix {
    pub text: String,
    pub range: TextRange,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleSuggestion {
    pub message: RuleMessage,
    pub fixes: Vec<RuleFix>,
}

/// A secondary range of a diagnostic with its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LabeledRange {
    pub label: String,
    pub range: TextRange,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleDiagnostic {
    /// The configured rule name (`"test"` in the rule tester).
    pub rule: String,
    /// The file name of the program's source file.
    pub file_name: String,
    pub range: TextRange,
    pub message: RuleMessage,
    pub labeled_ranges: Vec<LabeledRange>,
    /// `None` when the rule reported no fixes or the fix closure did not run.
    pub fixes: Option<Vec<RuleFix>>,
    /// `None` when the rule reported no suggestions or the suggestion closure
    /// did not run.
    pub suggestions: Option<Vec<RuleSuggestion>>,
}

impl RuleDiagnostic {
    /// The fixes, empty when there are none (Go `Fixes()`).
    pub fn fixes(&self) -> &[RuleFix] {
        self.fixes.as_deref().unwrap_or_default()
    }

    /// The suggestions, empty when there are none (Go `GetSuggestions()`).
    pub fn suggestions(&self) -> &[RuleSuggestion] {
        self.suggestions.as_deref().unwrap_or_default()
    }
}

/// tsconfig errors (`tsconfig-error`) and TypeScript errors (`TS2322`):
/// kind 1 of the headless protocol.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InternalDiagnostic {
    /// `None` when the location is invalid (both ends negative).
    pub range: Option<TextRange>,
    pub id: String,
    pub description: String,
    pub help: String,
    pub file_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LintEvent {
    Rule(RuleDiagnostic),
    Internal(InternalDiagnostic),
}

/// The range of a TypeScript diagnostic as tsgolint emits it: `None` when
/// both ends are negative.
pub(crate) fn diagnostic_range(pos: i32, end: i32) -> Option<TextRange> {
    (pos >= 0 || end >= 0).then(|| TextRange::new(pos, end))
}
