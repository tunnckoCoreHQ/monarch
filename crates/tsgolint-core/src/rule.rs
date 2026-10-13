//! The rule framework: rule definitions, listeners and the rule context.
//!
//! A rule is created once per linted file: `RuleDefinition::create` gets the
//! context and the rule's JSON options, may report right away, and returns
//! the listeners it wants. A listener is a node event (`Listener`) and a
//! handler `fn(&mut State, &mut RuleContext, Node)`. The state is the rule's
//! own value for this file (its options, stacks for enter/exit pairs).

use std::cell::OnceCell;
use std::rc::Rc;

use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::Node;
use goport_core::frontend::vfs::Fs;
use goport_core::options::CompilerOptions;
use serde_json::Value;

use crate::diagnostic::{
    LabeledRange, RuleDiagnostic, RuleFix, RuleMessage, RuleSuggestion, TextRange,
};
use crate::fs::FsFactory;
use crate::text::{self, trim_node_text_range};

/// A rule as the registry knows it.
pub struct RuleDefinition {
    /// The rule name (kebab-case, as tsgolint has it).
    pub name: &'static str,
    /// Creates the rule for one file. `options` is the JSON value the rule
    /// was configured with (`null` for none).
    pub create: fn(&mut RuleContext<'_>, &Value) -> RuleListeners,
}

impl std::fmt::Debug for RuleDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuleDefinition")
            .field("name", &self.name)
            .finish()
    }
}

/// A rule to run on a file: its definition, its options and the name its
/// diagnostics carry.
#[derive(Clone, Debug)]
pub struct ConfiguredRule {
    pub name: String,
    pub definition: &'static RuleDefinition,
    pub options: Value,
}

impl ConfiguredRule {
    /// The rule under its own name.
    pub fn new(definition: &'static RuleDefinition, options: Value) -> Self {
        Self {
            name: definition.name.to_owned(),
            definition,
            options,
        }
    }
}

/// When a listener runs. tsgolint encodes these as `kind + 1000 * n`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Phase {
    /// Entering a node.
    Enter,
    /// Leaving a node (Go `ListenerOnExit`).
    Exit,
    /// Entering a node in an assignment pattern: the left side of a plain
    /// `=` assignment and the array/object literals, spreads and property
    /// values in it (Go `ListenerOnAllowPattern`). `Enter` runs first.
    EnterAllowPattern,
    ExitAllowPattern,
    /// Entering an array or object literal that is not in a pattern (Go
    /// `ListenerOnNotAllowPattern`). `Enter` runs first.
    EnterNotAllowPattern,
    ExitNotAllowPattern,
}

const PHASES: usize = 6;
const KINDS: usize = SyntaxKind::COUNT;
/// The number of distinct listeners (`Listener::index`).
pub(crate) const LISTENER_COUNT: usize = PHASES * KINDS;

/// A node event: a syntax kind and a phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Listener {
    pub kind: SyntaxKind,
    pub phase: Phase,
}

impl Listener {
    pub const fn enter(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::Enter,
        }
    }
    pub const fn exit(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::Exit,
        }
    }
    pub const fn allow_pattern(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::EnterAllowPattern,
        }
    }
    pub const fn exit_allow_pattern(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::ExitAllowPattern,
        }
    }
    pub const fn not_allow_pattern(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::EnterNotAllowPattern,
        }
    }
    pub const fn exit_not_allow_pattern(kind: SyntaxKind) -> Self {
        Self {
            kind,
            phase: Phase::ExitNotAllowPattern,
        }
    }

    #[inline]
    pub(crate) const fn index(self) -> usize {
        self.phase as usize * KINDS + self.kind as usize
    }
}

impl From<SyntaxKind> for Listener {
    fn from(kind: SyntaxKind) -> Self {
        Self::enter(kind)
    }
}

/// A listener handler.
pub type Handler<S> = fn(&mut S, &mut RuleContext<'_>, Node);

/// The listeners of a rule instance with their state; build one and turn it
/// into `RuleListeners` with `.into()`.
pub struct Listeners<S> {
    state: S,
    events: Vec<Listener>,
    handlers: Vec<Handler<S>>,
}

impl<S: 'static> Listeners<S> {
    pub fn new(state: S) -> Self {
        Self {
            state,
            events: Vec::new(),
            handlers: Vec::new(),
        }
    }

    /// Runs `handler` on `listener` (a `SyntaxKind` means `Listener::enter`).
    #[must_use]
    pub fn on(mut self, listener: impl Into<Listener>, handler: Handler<S>) -> Self {
        self.events.push(listener.into());
        self.handlers.push(handler);
        self
    }
}

/// The type-erased listeners of one rule instance.
pub struct RuleListeners {
    pub(crate) events: Vec<Listener>,
    pub(crate) rule: Option<Box<dyn ErasedRule>>,
}

impl RuleListeners {
    /// No listeners (a rule that reported during `create`, or did nothing).
    pub fn none() -> Self {
        Self {
            events: Vec::new(),
            rule: None,
        }
    }
}

impl<S: 'static> From<Listeners<S>> for RuleListeners {
    fn from(listeners: Listeners<S>) -> Self {
        Self {
            events: listeners.events,
            rule: Some(Box::new(Instance {
                state: listeners.state,
                handlers: listeners.handlers,
            })),
        }
    }
}

pub(crate) trait ErasedRule {
    fn call(&mut self, handler: usize, ctx: &mut RuleContext<'_>, node: Node);
}

struct Instance<S> {
    state: S,
    handlers: Vec<Handler<S>>,
}

impl<S> ErasedRule for Instance<S> {
    #[inline]
    fn call(&mut self, handler: usize, ctx: &mut RuleContext<'_>, node: Node) {
        (self.handlers[handler])(&mut self.state, ctx, node);
    }
}

/// Fix and suggestion flags. A closure that makes fixes or suggestions runs
/// only when its flag is on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FixFlags {
    pub fix: bool,
    pub fix_suggestions: bool,
}

/// A diagnostic for `RuleContext::report_diagnostic*`: the parts a rule
/// sets. The rule name and the file come from the context.
#[derive(Clone, Debug)]
pub struct Report {
    pub range: TextRange,
    pub message: RuleMessage,
    pub labeled_ranges: Vec<LabeledRange>,
    pub fixes: Option<Vec<RuleFix>>,
    pub suggestions: Option<Vec<RuleSuggestion>>,
}

impl Report {
    pub fn new(range: TextRange, message: RuleMessage) -> Self {
        Self {
            range,
            message,
            labeled_ranges: Vec::new(),
            fixes: None,
            suggestions: None,
        }
    }

    #[must_use]
    pub fn with_label(mut self, label: impl Into<String>, range: TextRange) -> Self {
        self.labeled_ranges.push(LabeledRange {
            label: label.into(),
            range,
        });
        self
    }
}

/// The host file system of the program on the current thread, made on first
/// use.
pub(crate) struct LazyFs<'a> {
    pub(crate) factory: &'a FsFactory,
    pub(crate) fs: OnceCell<Rc<dyn Fs>>,
}

/// What a rule sees while it runs on a file.
pub struct RuleContext<'a> {
    /// The checker of this file. Copy ids out of its borrows before the next
    /// call.
    pub checker: &'a mut Checker,
    /// The source file being linted.
    pub source_file: Node,
    pub(crate) rule_name: &'a str,
    pub(crate) file_name: &'a str,
    pub(crate) flags: FixFlags,
    pub(crate) sink: &'a mut dyn FnMut(RuleDiagnostic),
    pub(crate) fs: &'a LazyFs<'a>,
}

impl<'a> RuleContext<'a> {
    /// The configured name of the rule that runs now.
    pub fn rule_name(&self) -> &str {
        self.rule_name
    }

    /// The program's compiler options.
    pub fn compiler_options(&self) -> &'static CompilerOptions {
        goport_core::program::options()
    }

    /// The text of the source file.
    pub fn source_text(&self) -> goport_core::ast::FileText {
        goport_core::ast::source_file_text(self.source_file)
    }

    /// The program host's file system (Go `Program.Host().FS()`).
    pub fn fs(&self) -> Rc<dyn Fs> {
        self.fs.fs.get_or_init(|| self.fs.factory.make()).clone()
    }

    /// `node`'s range without leading trivia (Go `utils.TrimNodeTextRange`).
    pub fn trim_node_text_range(&self, node: Node) -> TextRange {
        trim_node_text_range(self.source_file, node)
    }

    /// The text of `range` in the source file, cut as Go slices bytes
    /// (`text::text_slice`).
    pub fn range_text(&self, range: TextRange) -> String {
        text::range_text(self.source_file, range)
    }

    /// The text of `node` without its leading trivia.
    pub fn node_text(&self, node: Node) -> String {
        text::node_text(self.source_file, node)
    }

    fn emit(&mut self, report: Report) {
        let diagnostic = RuleDiagnostic {
            rule: self.rule_name.to_owned(),
            file_name: self.file_name.to_owned(),
            range: report.range,
            message: report.message,
            labeled_ranges: report.labeled_ranges,
            fixes: report.fixes,
            suggestions: report.suggestions,
        };
        (self.sink)(diagnostic);
    }

    fn fixes(&mut self, make: impl FnOnce(&mut Self) -> Vec<RuleFix>) -> Option<Vec<RuleFix>> {
        self.flags.fix.then(|| make(self))
    }

    fn suggestions(
        &mut self,
        make: impl FnOnce(&mut Self) -> Vec<RuleSuggestion>,
    ) -> Option<Vec<RuleSuggestion>> {
        self.flags.fix_suggestions.then(|| make(self))
    }

    /// Reports `report` as is (Go `ReportDiagnostic`).
    pub fn report_diagnostic(&mut self, report: Report) {
        self.emit(report);
    }

    /// Reports `report` with the fixes of `make`, which runs only when fixes
    /// are on (Go `ReportDiagnosticWithFixes`).
    pub fn report_diagnostic_with_fixes(
        &mut self,
        mut report: Report,
        make: impl FnOnce(&mut Self) -> Vec<RuleFix>,
    ) {
        report.fixes = self.fixes(make);
        self.emit(report);
    }

    /// Reports `report` with the suggestions of `make`, which runs only when
    /// suggestions are on (Go `ReportDiagnosticWithSuggestions`).
    pub fn report_diagnostic_with_suggestions(
        &mut self,
        mut report: Report,
        make: impl FnOnce(&mut Self) -> Vec<RuleSuggestion>,
    ) {
        report.suggestions = self.suggestions(make);
        self.emit(report);
    }

    /// Reports `range` as given (Go `ReportRange`).
    pub fn report_range(&mut self, range: TextRange, message: RuleMessage) {
        self.emit(Report::new(range, message));
    }

    /// Go `ReportRangeWithSuggestions`.
    pub fn report_range_with_suggestions(
        &mut self,
        range: TextRange,
        message: RuleMessage,
        make: impl FnOnce(&mut Self) -> Vec<RuleSuggestion>,
    ) {
        let mut report = Report::new(range, message);
        report.suggestions = self.suggestions(make);
        self.emit(report);
    }

    /// Reports `node` with its trimmed range (Go `ReportNode`).
    pub fn report_node(&mut self, node: Node, message: RuleMessage) {
        let range = self.trim_node_text_range(node);
        self.emit(Report::new(range, message));
    }

    /// Go `ReportNodeWithFixes`.
    pub fn report_node_with_fixes(
        &mut self,
        node: Node,
        message: RuleMessage,
        make: impl FnOnce(&mut Self) -> Vec<RuleFix>,
    ) {
        let mut report = Report::new(self.trim_node_text_range(node), message);
        report.fixes = self.fixes(make);
        self.emit(report);
    }

    /// Go `ReportNodeWithSuggestions`.
    pub fn report_node_with_suggestions(
        &mut self,
        node: Node,
        message: RuleMessage,
        make: impl FnOnce(&mut Self) -> Vec<RuleSuggestion>,
    ) {
        let mut report = Report::new(self.trim_node_text_range(node), message);
        report.suggestions = self.suggestions(make);
        self.emit(report);
    }

    /// Reports `node` with `fixes` as fixes when `fix` is true, else as one
    /// suggestion with `suggestion_message` (Go
    /// `rule.ReportNodeWithFixesOrSuggestions`).
    pub fn report_node_with_fixes_or_suggestions(
        &mut self,
        node: Node,
        fix: bool,
        message: RuleMessage,
        suggestion_message: RuleMessage,
        fixes: Vec<RuleFix>,
    ) {
        if fix {
            self.report_node_with_fixes(node, message, |_| fixes);
        } else {
            self.report_node_with_suggestions(node, message, |_| {
                vec![RuleSuggestion {
                    message: suggestion_message,
                    fixes,
                }]
            });
        }
    }

    /// `RuleFix::insert_before` in this file.
    pub fn fix_insert_before(&self, node: Node, text: impl Into<String>) -> RuleFix {
        RuleFix::insert_before(self.source_file, node, text)
    }

    /// `RuleFix::replace` in this file.
    pub fn fix_replace(&self, node: Node, text: impl Into<String>) -> RuleFix {
        RuleFix::replace(self.source_file, node, text)
    }

    /// `RuleFix::remove` in this file.
    pub fn fix_remove(&self, node: Node) -> RuleFix {
        RuleFix::remove(self.source_file, node)
    }

    /// `RuleFix::wrap_in_parens` in this file.
    pub fn fix_wrap_in_parens(&self, node: Node) -> [RuleFix; 2] {
        RuleFix::wrap_in_parens(self.source_file, node)
    }
}

impl RuleFix {
    /// Inserts `text` before the first token of `node` (Go
    /// `RuleFixInsertBefore`).
    pub fn insert_before(source_file: Node, node: Node, text: impl Into<String>) -> Self {
        let trimmed = trim_node_text_range(source_file, node);
        Self::replace_range(trimmed.with_end(trimmed.pos()), text)
    }

    /// Inserts `text` at `node.end()` (Go `RuleFixInsertAfter`).
    pub fn insert_after(node: Node, text: impl Into<String>) -> Self {
        Self::replace_range(TextRange::new(node.end(), node.end()), text)
    }

    /// Wraps `node` in parentheses: `(` before its first token and `)` at
    /// its end.
    pub fn wrap_in_parens(source_file: Node, node: Node) -> [Self; 2] {
        [
            Self::insert_before(source_file, node, "("),
            Self::insert_after(node, ")"),
        ]
    }

    /// Replaces the trimmed range of `node` (Go `RuleFixReplace`).
    pub fn replace(source_file: Node, node: Node, text: impl Into<String>) -> Self {
        Self::replace_range(trim_node_text_range(source_file, node), text)
    }

    pub fn replace_range(range: TextRange, text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            range,
        }
    }

    /// Removes the trimmed range of `node` (Go `RuleFixRemove`).
    pub fn remove(source_file: Node, node: Node) -> Self {
        Self::replace(source_file, node, "")
    }

    pub fn remove_range(range: TextRange) -> Self {
        Self::replace_range(range, "")
    }
}
