//! The lint engine for one program (Go `linter.RunLinterOnProgram`).
//!
//! TypeScript diagnostics come first, then rule diagnostics. The files are
//! grouped by the checker ts-rust assigns to them. Each group gets one job
//! for its semantic diagnostics and then one job that runs the rules on its
//! files, on that checker's thread; jobs for one checker run in send order.
//! Rule diagnostics travel as plain data over a channel to the calling
//! (loading) thread. On wasm ts-rust runs each job inline when it is sent,
//! so the same code needs no thread of its own, and each checker is dropped
//! after its jobs, before the next one is made.

use std::cell::OnceCell;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

use goport_core::ast::source_file_file_name;
use goport_core::checker::Checker;
use goport_core::core::{Diagnostic, Node};
use goport_core::effect::etscore::enter_command_line_mode;
use goport_core::gostd::context;
use goport_core::locale;
use goport_core::program as tsprogram;
use smallvec::SmallVec;

use crate::diagnostic::{InternalDiagnostic, LintEvent, RuleDiagnostic, diagnostic_range};
use crate::fs::FsFactory;
use crate::program::Program;
use crate::rule::{
    ConfiguredRule, ErasedRule, FixFlags, LISTENER_COUNT, LazyFs, Listener, RuleContext,
};
use crate::timing::{FileTimings, RuleTimings};
use crate::traverse::visit_lint_nodes;

/// A file to lint and the rules to run on it, in order.
#[derive(Clone, Debug)]
pub struct LintFile {
    pub file: Node,
    pub rules: Arc<[ConfiguredRule]>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LintSettings {
    pub fix: bool,
    pub fix_suggestions: bool,
    /// Report parse errors of the linted files (`TS1002`, ...).
    pub report_syntactic: bool,
    /// Report type errors of the linted files (`TS2322`, ...).
    pub report_semantic: bool,
}

/// Lints `files` of `program` (in program order) and calls `on_event` on
/// this thread for each diagnostic as it arrives: the TypeScript diagnostics
/// of all files first (syntactic, then semantic, file by file), then the rule
/// diagnostics. Within a file, rule diagnostics keep the order the rules
/// reported them. A panic in a rule continues here after the other jobs end.
/// On wasm the program's checkers are dropped on the way, so a program is
/// linted once.
pub fn lint_program(
    program: &Program,
    files: &[LintFile],
    settings: LintSettings,
    on_event: &mut dyn FnMut(LintEvent),
) {
    lint_program_with(program, files, settings, LintDebug::default(), on_event);
}

/// What the driver's debug options need from a lint run.
#[derive(Clone, Copy, Debug, Default)]
pub struct LintDebug {
    /// Time each rule's `create` and listener calls (`-debug timings`).
    pub timings: bool,
    /// Called with the file name of each file before its rules run, on the
    /// checker's thread (Go logs it with `OXC_LOG=debug`).
    pub on_file: Option<fn(&str)>,
}

/// `lint_program` with debug options. Returns the rule timings when
/// `debug.timings` is on (else empty).
pub fn lint_program_with(
    program: &Program,
    files: &[LintFile],
    settings: LintSettings,
    debug: LintDebug,
    on_event: &mut dyn FnMut(LintEvent),
) -> RuleTimings {
    let _cli_mode = enter_command_line_mode();
    let _scope = program.enter();

    // Groups of (file index, file) by checker, in order of first file.
    let mut groups: Vec<(usize, Vec<(usize, LintFile)>)> = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let checker = tsprogram::checker_index_of_file(file.file);
        match groups.iter_mut().find(|(c, _)| *c == checker) {
            Some((_, group)) => group.push((index, file.clone())),
            None => groups.push((checker, vec![(index, file.clone())])),
        }
    }

    let (sender, receiver) = mpsc::channel::<RuleDiagnostic>();
    let flags = FixFlags {
        fix: settings.fix,
        fix_suggestions: settings.fix_suggestions,
    };
    let mut semantic_jobs = Vec::new();
    let mut lint_jobs = Vec::new();
    for (checker_index, group) in groups {
        let first = group[0].1.file;
        if settings.report_semantic {
            let targets: Vec<(usize, Node)> = group.iter().map(|(i, f)| (*i, f.file)).collect();
            semantic_jobs.push(tsprogram::send_type_checker_job_for_file(
                first,
                move |checker| {
                    targets
                        .into_iter()
                        .map(|(index, file)| (index, semantic_diagnostics(checker, file)))
                        .collect::<Vec<_>>()
                },
            ));
        }
        let sender = sender.clone();
        let fs = program.fs().clone();
        lint_jobs.push(tsprogram::send_type_checker_job_for_file(
            first,
            move |checker| lint_files(checker, &group, flags, debug, &fs, &sender),
        ));
        // wasm ran both jobs when they were sent. Dropping the checker now
        // keeps one checker's tables alive at a time.
        #[cfg(target_family = "wasm")]
        tsprogram::release_checker(checker_index);
        #[cfg(not(target_family = "wasm"))]
        let _ = checker_index;
    }
    drop(sender);

    if settings.report_syntactic {
        for file in files {
            let file_name = source_file_file_name(file.file);
            for d in tsprogram::get_syntactic_diagnostics(file.file) {
                if is_in_file(&d, file_name) {
                    on_event(LintEvent::Internal(typescript_diagnostic(&d, file_name)));
                }
            }
        }
    }

    if settings.report_semantic {
        let mut by_file: Vec<Vec<InternalDiagnostic>> = vec![Vec::new(); files.len()];
        for job in semantic_jobs {
            for (index, diagnostics) in job.wait() {
                by_file[index] = diagnostics;
            }
        }
        for diagnostics in by_file {
            for d in diagnostics {
                on_event(LintEvent::Internal(d));
            }
        }
    }

    for diagnostic in receiver {
        on_event(LintEvent::Rule(diagnostic));
    }
    let mut timings = RuleTimings::default();
    for job in lint_jobs {
        timings.merge(job.wait());
    }
    timings
}

/// The semantic diagnostics of `file` as tsgolint reports them (Go
/// `GetSemanticDiagnosticsWithoutNoEmitFiltering` for one file, then
/// `FilterNoEmitSemanticDiagnostics` and the include-processor
/// diagnostics).
fn semantic_diagnostics(checker: &mut Checker, file: Node) -> Vec<InternalDiagnostic> {
    let checked = tsprogram::sort_and_deduplicate_diagnostics(
        tsprogram::get_bind_and_check_diagnostics_with_checker(
            &context::background(),
            checker,
            file,
            false,
        ),
    );
    let mut diagnostics =
        tsprogram::filter_no_emit_semantic_diagnostics(checked, tsprogram::options());
    let include = tsprogram::get_include_processor_diagnostics(file);
    if diagnostics.is_empty() && include.is_empty() {
        return Vec::new();
    }
    diagnostics.extend(include);
    if diagnostics.len() > 1 {
        diagnostics = tsprogram::sort_and_deduplicate_diagnostics(diagnostics);
    }
    let file_name = source_file_file_name(file);
    diagnostics
        .iter()
        .filter(|d| is_in_file(d, file_name))
        .map(|d| typescript_diagnostic(d, file_name))
        .collect()
}

fn is_in_file(d: &Diagnostic, file_name: &str) -> bool {
    d.file.is_some() && source_file_file_name(d.file) == file_name
}

/// `TS<code>` with the top-level message only.
fn typescript_diagnostic(d: &Diagnostic, file_name: &str) -> InternalDiagnostic {
    InternalDiagnostic {
        range: diagnostic_range(d.pos, d.end),
        id: format!("TS{}", d.code),
        description: d.localize(&locale::DEFAULT),
        help: String::new(),
        file_path: file_name.to_owned(),
    }
}

/// Listeners by `Listener::index`: (rule index, handler index), in rule
/// order. Reused from file to file.
struct DispatchTable {
    slots: Vec<SmallVec<[(u16, u16); 2]>>,
    used: Vec<usize>,
}

impl DispatchTable {
    fn new() -> Self {
        Self {
            slots: vec![SmallVec::new(); LISTENER_COUNT],
            used: Vec::new(),
        }
    }

    fn add(&mut self, listener: Listener, rule: usize, handler: usize) {
        let slot = &mut self.slots[listener.index()];
        if slot.is_empty() {
            self.used.push(listener.index());
        }
        slot.push((rule as u16, handler as u16));
    }

    fn clear(&mut self) {
        for index in self.used.drain(..) {
            self.slots[index].clear();
        }
    }
}

/// Runs the rules of each file of a checker group, on the checker's thread.
fn lint_files(
    checker: &mut Checker,
    group: &[(usize, LintFile)],
    flags: FixFlags,
    debug: LintDebug,
    fs: &FsFactory,
    sender: &mpsc::Sender<RuleDiagnostic>,
) -> RuleTimings {
    let lazy_fs = LazyFs {
        factory: fs,
        fs: OnceCell::new(),
    };
    let mut table = DispatchTable::new();
    let mut sink = |diagnostic: RuleDiagnostic| {
        // The receiver lives until every job ends.
        let _ = sender.send(diagnostic);
    };
    let mut timings = RuleTimings::default();
    let mut file_timings = debug.timings.then(FileTimings::default);
    for (_, file) in group {
        if let Some(on_file) = debug.on_file {
            on_file(source_file_file_name(file.file));
        }
        lint_file(
            checker,
            file,
            flags,
            &lazy_fs,
            &mut table,
            &mut sink,
            file_timings.as_mut(),
        );
        if let Some(file_timings) = &file_timings {
            let names = file.rules.iter().map(|rule| rule.name.as_str());
            file_timings.merge_into(names, &mut timings);
        }
    }
    timings
}

/// Lints one file: creates each rule (which may report at once), then walks
/// the file and runs the listeners in rule order. With `timings`, each
/// `create` and listener call is timed (Go times them the same way).
fn lint_file<'a>(
    checker: &'a mut Checker,
    file: &'a LintFile,
    flags: FixFlags,
    fs: &'a LazyFs<'a>,
    table: &mut DispatchTable,
    sink: &'a mut dyn FnMut(RuleDiagnostic),
    mut timings: Option<&mut FileTimings>,
) {
    let rules: &[ConfiguredRule] = &file.rules;
    if let Some(timings) = timings.as_deref_mut() {
        timings.reset(rules.len());
    }
    let mut ctx = RuleContext {
        checker,
        source_file: file.file,
        rule_name: "",
        file_name: source_file_file_name(file.file),
        flags,
        sink,
        fs,
    };
    let mut instances: Vec<Option<Box<dyn ErasedRule>>> = Vec::with_capacity(rules.len());
    for (index, rule) in rules.iter().enumerate() {
        ctx.rule_name = &rule.name;
        let start = timings.is_some().then(Instant::now);
        let listeners = (rule.definition.create)(&mut ctx, &rule.options);
        if let (Some(timings), Some(start)) = (timings.as_deref_mut(), start) {
            timings.record(index, start.elapsed());
        }
        for (handler, &listener) in listeners.events.iter().enumerate() {
            table.add(listener, index, handler);
        }
        instances.push(listeners.rule);
    }
    if table.used.is_empty() {
        return;
    }
    let slots = &table.slots;
    match timings {
        None => visit_lint_nodes(file.file, &mut |listener, node| {
            for &(rule, handler) in &slots[listener.index()] {
                ctx.rule_name = &rules[rule as usize].name;
                if let Some(instance) = instances[rule as usize].as_mut() {
                    instance.call(handler as usize, &mut ctx, node);
                }
            }
        }),
        Some(timings) => visit_lint_nodes(file.file, &mut |listener, node| {
            for &(rule, handler) in &slots[listener.index()] {
                ctx.rule_name = &rules[rule as usize].name;
                if let Some(instance) = instances[rule as usize].as_mut() {
                    let start = Instant::now();
                    instance.call(handler as usize, &mut ctx, node);
                    timings.record(rule as usize, start.elapsed());
                }
            }
        }),
    }
    table.clear();
}
