//! The multi-program driver (Go `linter.RunLinter`). Programs are created,
//! linted and released one at a time on the loading thread; the inferred
//! program comes last, when some file has no tsconfig.

use goport_core::ast::{source_file_file_name, source_file_info};
use goport_core::core::Node;
use goport_util::frontend::tspath::{get_directory_path, to_path};
use rustc_hash::FxHashMap;
use tsgolint_core::{
    CreatedProgram, FsFactory, LintDebug, LintEvent, LintFile, LintSettings, Program,
    ProgramSettings, RuleTimings, create_inferred_program, create_program, lint_program_with,
};

use crate::discovery::Workload;
use crate::log;
use crate::rules::FileRules;

/// The settings of one run that do not change between programs.
#[derive(Clone, Copy, Debug, Default)]
pub struct RunSettings {
    pub lint: LintSettings,
    /// `-debug timings`.
    pub timings: bool,
    /// `OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS=true`.
    pub suppress_program_diagnostics: bool,
    /// The process exits after the run: the last program is not released.
    /// Its checkers and its frontend go with the process instead of being
    /// freed one by one first.
    pub keep_last_program: bool,
}

/// Lints every program of `workload` and returns the rule timings (empty
/// without `settings.timings`). `Err` is the text after
/// `error running linter: `; it stops the run at that program.
///
/// # Panics
///
/// As tsgolint does: when a file is missing from the program that should
/// contain it, when a linted file has an unknown rule, and when a rule
/// panics.
pub fn run_linter(
    fs: &FsFactory,
    current_directory: &str,
    workload: &Workload,
    rules: &FileRules,
    settings: RunSettings,
    on_event: &mut dyn FnMut(LintEvent),
) -> Result<RuleTimings, String> {
    let case_sensitive = fs.make().use_case_sensitive_file_names();
    let debug = LintDebug {
        timings: settings.timings,
        // Go logs the name of each file it lints with `OXC_LOG=debug`.
        on_file: log::debug_enabled().then_some(log::print as fn(&str)),
    };
    let mut timings = RuleTimings::default();
    let total = workload.programs.len();
    for (index, (config_file_name, file_paths)) in workload.programs.iter().enumerate() {
        log::debug(|| {
            format!(
                "[{}/{total}] Running linter on program: {config_file_name}",
                index + 1
            )
        });

        let program_directory = get_directory_path(config_file_name);
        let program_settings = ProgramSettings {
            single_threaded: false,
            suppress_program_diagnostics: settings.suppress_program_diagnostics,
        };
        let program =
            match create_program(fs, &program_directory, config_file_name, program_settings)? {
                CreatedProgram::Program(program) => program,
                CreatedProgram::Invalid(diagnostics) => {
                    for d in diagnostics {
                        on_event(LintEvent::Internal(d));
                    }
                    continue;
                }
            };
        let source_files = program.source_files();
        log::debug(|| format!("Program created with {} source files", source_files.len()));

        // Program membership uses paths relative to the tsconfig directory.
        let mut wanted: FxHashMap<String, &str> = FxHashMap::default();
        let mut wanted_order: Vec<String> = Vec::new();
        for file in file_paths {
            let path = to_path(file, &program_directory, case_sensitive).0;
            if wanted.insert(path.clone(), file).is_none() {
                wanted_order.push(path);
            }
        }
        let files: Vec<LintFile> = {
            let _scope = program.enter();
            source_files
                .iter()
                .filter_map(|&file| {
                    let path = &source_file_info(file).path;
                    wanted.remove(path.as_str()).map(|_| LintFile {
                        file,
                        rules: rules.rules_for_path(path),
                    })
                })
                .collect()
        };
        if !wanted.is_empty() {
            let unmatched: Vec<&str> = wanted_order
                .iter()
                .filter_map(|path| wanted.get(path).copied())
                .collect();
            let unmatched = unmatched.join(", ");
            log::print(&format!("Unmatched files found: {unmatched}"));
            let names = file_names(&program, &source_files);
            log::print(&format!(
                "Program source files ({}): {}",
                names.len(),
                names.join(", ")
            ));
            panic!("Expected file '{unmatched}' to be in program '{config_file_name}'");
        }

        timings.merge(lint_program_with(
            &program,
            &files,
            settings.lint,
            debug,
            on_event,
        ));
        if settings.keep_last_program && index + 1 == total && workload.unmatched_files.is_empty() {
            std::mem::forget(program);
        }
    }

    // tsgolint always creates the inferred program. Without files it has no
    // diagnostics and lints nothing, so it only costs a parse and bind of the
    // libs (t3web-chat: 0.3 s).
    if workload.unmatched_files.is_empty() {
        return Ok(timings);
    }
    let program = create_inferred_program(
        fs,
        current_directory,
        workload.unmatched_files.clone(),
        false,
    );
    let files: Vec<LintFile> = workload
        .unmatched_files
        .iter()
        .map(|file| {
            let Some(node) = program.source_file(file) else {
                panic!("Expected file '{file}' to be in inferred program");
            };
            let _scope = program.enter();
            LintFile {
                file: node,
                rules: rules.rules_for_path(&source_file_info(node).path),
            }
        })
        .collect();
    timings.merge(lint_program_with(
        &program,
        &files,
        settings.lint,
        debug,
        on_event,
    ));
    if settings.keep_last_program {
        std::mem::forget(program);
    }
    Ok(timings)
}

fn file_names(program: &Program, files: &[Node]) -> Vec<String> {
    let _scope = program.enter();
    files
        .iter()
        .map(|&file| source_file_file_name(file).to_owned())
        .collect()
}

/// Runs `f` on the loading thread, which has the large stack that ts-rust
/// needs, and returns its result. A panic in `f` ends the process with
/// exit code 2.
#[cfg(not(target_os = "wasi"))]
pub fn on_loading_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    // The result comes over a channel, not from `join`: after `f`, the
    // thread frees its thread-locals (the parse cache of every program),
    // which the process exit makes unneeded (t3web-chat: 0.1 s).
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("loading".into())
        .stack_size(goport_util::gostd::stack::max_stack_size())
        .spawn(move || {
            crate::panic::exit_on_panic(|| {
                let _ = sender.send(f());
            })
        })
        .expect("spawn the loading thread");
    receiver
        .recv()
        .unwrap_or_else(|_| unreachable!("panics exit the process"))
}

/// WASI has no threads: `f` runs on the current thread.
#[cfg(target_os = "wasi")]
pub fn on_loading_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    crate::panic::exit_on_panic(f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::{Payload, PayloadConfig, PayloadRule};

    /// A project in a fresh temp directory: `(relative path, text)` files.
    struct Project {
        dir: String,
    }

    impl Project {
        fn new(name: &str, files: &[(&str, &str)]) -> Self {
            let dir =
                std::env::temp_dir().join(format!("tsgolint-driver-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            for (path, text) in files {
                let path = dir.join(path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text).unwrap();
            }
            Self {
                dir: dir.to_str().unwrap().replace('\\', "/"),
            }
        }

        fn path(&self, relative: &str) -> String {
            format!("{}/{relative}", self.dir)
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn file_rules(dir: &str, files: &[String], names: &[&str]) -> FileRules {
        let payload = Payload {
            configs: vec![PayloadConfig {
                file_paths: files.to_vec(),
                rules: names
                    .iter()
                    .map(|n| PayloadRule {
                        name: n.to_string(),
                        options: None,
                    })
                    .collect(),
            }],
            ..Payload::default()
        };
        FileRules::from_payload_with_registry(&payload, dir, true).1
    }

    /// `rule <name> <file>` or `internal <id> <file>`, with file names
    /// relative to `dir`.
    fn describe(event: &LintEvent, dir: &str) -> String {
        let relative = |path: &str| {
            path.strip_prefix(dir)
                .unwrap_or(path)
                .trim_start_matches('/')
                .to_string()
        };
        match event {
            LintEvent::Rule(d) => format!("rule {} {}", d.rule, relative(&d.file_name)),
            LintEvent::Internal(d) => format!("internal {} {}", d.id, relative(&d.file_path)),
        }
    }

    type Outcome = Result<Result<(Vec<String>, RuleTimings), String>, String>;

    /// Runs the driver on a loading thread. The outer `Err` is a panic
    /// message.
    fn run(dir: &str, workload: Workload, rules: FileRules, settings: RunSettings) -> Outcome {
        let dir = dir.to_string();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        let joined = std::thread::Builder::new()
            .stack_size(goport_util::gostd::stack::max_stack_size())
            .spawn(move || {
                let fs = FsFactory::base();
                run_linter(&fs, &dir, &workload, &rules, settings, &mut |e| {
                    sink.lock().unwrap().push(describe(&e, &dir))
                })
            })
            .unwrap()
            .join();
        match joined {
            Ok(result) => Ok(result.map(|timings| (events.lock().unwrap().clone(), timings))),
            Err(payload) => Err(crate::panic::panic_message(payload.as_ref())),
        }
    }

    const TSCONFIG: &str = r#"{"compilerOptions":{"strict":true,"target":"esnext"}}"#;
    const DELETE: &str = "declare const arr: number[];\ndelete arr[0];\n";
    const TYPE_ERROR: &str = "const n: number = 'x';\n";

    fn semantic() -> RunSettings {
        RunSettings {
            lint: LintSettings {
                report_semantic: true,
                ..LintSettings::default()
            },
            ..RunSettings::default()
        }
    }

    #[test]
    fn programs_in_order_then_the_inferred_program() {
        let p = Project::new(
            "order",
            &[
                ("a/tsconfig.json", TSCONFIG),
                ("a/x.ts", DELETE),
                ("a/y.ts", TYPE_ERROR),
                ("b/tsconfig.json", "{ compilerOptions\": {"),
                ("b/w.ts", DELETE),
                ("z.ts", DELETE),
            ],
        );
        let files: Vec<String> = ["a/y.ts", "a/x.ts", "b/w.ts", "z.ts"]
            .iter()
            .map(|f| p.path(f))
            .collect();
        let workload = Workload {
            programs: vec![
                // Lint order is program order, not payload order.
                (
                    p.path("a/tsconfig.json"),
                    vec![files[0].clone(), files[1].clone()],
                ),
                (p.path("b/tsconfig.json"), vec![files[2].clone()]),
            ],
            unmatched_files: vec![files[3].clone()],
        };
        let rules = file_rules(&p.dir, &files, &["no-array-delete"]);
        let (events, timings) = run(&p.dir, workload, rules, semantic()).unwrap().unwrap();
        assert_eq!(
            events,
            [
                "internal TS2322 a/y.ts",
                "rule no-array-delete a/x.ts",
                "internal tsconfig-error b/tsconfig.json",
                "rule no-array-delete z.ts",
            ]
        );
        assert!(timings.is_empty());
    }

    #[test]
    fn config_read_error_aborts() {
        let p = Project::new(
            "read-error",
            &[("c/tsconfig.json", TSCONFIG), ("c/x.ts", DELETE)],
        );
        let workload = Workload {
            programs: vec![
                (p.path("b/tsconfig.json"), vec![p.path("b/x.ts")]),
                (p.path("c/tsconfig.json"), vec![p.path("c/x.ts")]),
            ],
            unmatched_files: vec![],
        };
        let rules = file_rules(&p.dir, &[p.path("c/x.ts")], &["no-array-delete"]);
        let err = run(&p.dir, workload, rules, RunSettings::default())
            .unwrap()
            .unwrap_err();
        assert_eq!(
            err,
            format!("couldn't read tsconfig at {}", p.path("b/tsconfig.json"))
        );
    }

    #[test]
    fn file_missing_from_its_program_panics() {
        let p = Project::new(
            "missing",
            &[
                ("a/tsconfig.json", r#"{"files":["x.ts"]}"#),
                ("a/x.ts", DELETE),
                ("a/y.ts", DELETE),
            ],
        );
        let workload = Workload {
            programs: vec![(
                p.path("a/tsconfig.json"),
                vec![p.path("a/x.ts"), p.path("a/y.ts")],
            )],
            unmatched_files: vec![],
        };
        let message = run(
            &p.dir,
            workload,
            FileRules::default(),
            RunSettings::default(),
        )
        .unwrap_err();
        assert_eq!(
            message,
            format!(
                "Expected file '{}' to be in program '{}'",
                p.path("a/y.ts"),
                p.path("a/tsconfig.json")
            )
        );
    }

    #[test]
    fn file_missing_from_the_inferred_program_panics() {
        let p = Project::new("gone", &[]);
        let workload = Workload {
            programs: vec![],
            unmatched_files: vec![p.path("gone.ts")],
        };
        let message = run(
            &p.dir,
            workload,
            FileRules::default(),
            RunSettings::default(),
        )
        .unwrap_err();
        assert_eq!(
            message,
            format!(
                "Expected file '{}' to be in inferred program",
                p.path("gone.ts")
            )
        );
    }

    #[test]
    fn unknown_rule_panics_after_typescript_diagnostics() {
        let p = Project::new("unknown", &[("z.ts", TYPE_ERROR)]);
        let file = p.path("z.ts");
        let workload = Workload {
            programs: vec![],
            unmatched_files: vec![file.clone()],
        };
        let rules = file_rules(&p.dir, &[file], &["no-array-delete", "nope"]);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (dir, sink) = (p.dir.clone(), events.clone());
        let joined = std::thread::Builder::new()
            .stack_size(goport_util::gostd::stack::max_stack_size())
            .spawn(move || {
                run_linter(
                    &FsFactory::base(),
                    &dir,
                    &workload,
                    &rules,
                    semantic(),
                    &mut |e| sink.lock().unwrap().push(describe(&e, &dir)),
                )
            })
            .unwrap()
            .join();
        let message = crate::panic::panic_message(joined.unwrap_err().as_ref());
        assert_eq!(message, "unknown rule: nope");
        assert_eq!(*events.lock().unwrap(), ["internal TS2322 z.ts"]);
    }

    #[test]
    fn duplicate_unmatched_files_are_linted_twice() {
        let p = Project::new("dup", &[("z.ts", DELETE)]);
        let workload = Workload {
            programs: vec![],
            unmatched_files: vec![p.path("z.ts"), p.path("./z.ts")],
        };
        let rules = file_rules(&p.dir, &[p.path("z.ts")], &["no-array-delete"]);
        let (events, _) = run(&p.dir, workload, rules, RunSettings::default())
            .unwrap()
            .unwrap();
        assert_eq!(
            events,
            ["rule no-array-delete z.ts", "rule no-array-delete z.ts"]
        );
    }

    #[test]
    fn timings_count_create_and_listener_calls() {
        let p = Project::new("timings", &[("z.ts", DELETE), ("y.ts", "export {};\n")]);
        let files = vec![p.path("z.ts"), p.path("y.ts")];
        let workload = Workload {
            programs: vec![],
            unmatched_files: files.clone(),
        };
        let rules = file_rules(
            &p.dir,
            &files,
            &["no-array-delete", "require-array-sort-compare"],
        );
        let settings = RunSettings {
            timings: true,
            ..RunSettings::default()
        };
        let (_, timings) = run(&p.dir, workload, rules, settings).unwrap().unwrap();
        let mut records: Vec<(String, u64)> = timings
            .records()
            .into_iter()
            .map(|r| (r.rule_name, r.calls))
            .collect();
        records.sort();
        // no-array-delete listens to `delete` expressions (one), and
        // require-array-sort-compare to call expressions (none); each rule is
        // created once per file.
        assert_eq!(
            records,
            [
                ("no-array-delete".to_string(), 3),
                ("require-array-sort-compare".to_string(), 2)
            ]
        );
    }
}
