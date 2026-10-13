//! `tsgolint headless` (Go `runHeadless` in `cmd/tsgolint/headless.go`).
//!
//! The main thread parses the flags, reads stdin to EOF and decodes the
//! payload. The loading thread resolves the tsconfigs, runs the driver and
//! writes each diagnostic it gets to stdout through tsgolint's 400 KB
//! buffer, so the output streams while the run goes on. Under WASI the
//! same code runs on the main thread.

use std::io::{Read, Write};

use goport_core::gostd::strconv;
use goport_util::frontend::vfs::{getwd_error_text, os_current_dir, osvfs_fs};
use goport_util::fswatch::syscall::io_error_text;
use tsgolint_core::{FixFlags, FsFactory, LintEvent, LintSettings, RuleTimingRecord};

use crate::discovery::{TsConfigResolver, Workload};
use crate::driver::{RunSettings, on_loading_thread, run_linter};
use crate::flags::{Flag, FlagKind, FlagSet, Usage};
use crate::log;
use crate::overrides::headless_fs;
use crate::payload::{self, Payload};
use crate::profiling::Profiling;
use crate::protocol::{DiagnosticWriter, MessageType, encode_error, encode_timings, write_message};
use crate::rules::FileRules;

/// The flags of `tsgolint headless`.
pub const HEADLESS_FLAGS: &[Flag] = &[
    Flag {
        name: "trace",
        kind: FlagKind::String,
        usage: "file to put trace to",
    },
    Flag {
        name: "cpuprof",
        kind: FlagKind::String,
        usage: "file to put cpu profiling to",
    },
    Flag {
        name: "heap",
        kind: FlagKind::String,
        usage: "file to put heap profiling to",
    },
    Flag {
        name: "allocs",
        kind: FlagKind::String,
        usage: "file to put allocs profiling to",
    },
    Flag {
        name: "fix",
        kind: FlagKind::Bool,
        usage: "generate fixes for code problems",
    },
    Flag {
        name: "fix-suggestions",
        kind: FlagKind::Bool,
        usage: "generate suggestions for code problems",
    },
    Flag {
        name: "debug",
        kind: FlagKind::String,
        usage: "enable debug output options",
    },
];

/// Go `parseDebugTimings`: a comma-separated list where only `timings` is
/// known and empty items are skipped.
pub fn parse_debug_timings(options: &str) -> Result<bool, String> {
    let mut timings = false;
    for option in options.split(',') {
        match option {
            "" => {}
            "timings" => timings = true,
            _ => return Err(format!("unknown debug option {}", strconv::quote(option))),
        }
    }
    Ok(timings)
}

/// Go `runtime.GOMAXPROCS(0)`: `GOMAXPROCS` when it is a positive integer,
/// else the number of CPUs this process may use.
pub fn gomaxprocs() -> usize {
    std::env::var("GOMAXPROCS")
        .ok()
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, std::num::NonZero::get))
}

/// Go `suppressProgramDiagnostics`.
fn suppress_program_diagnostics() -> bool {
    std::env::var_os("OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS")
        .is_some_and(|v| v == "true")
}

/// The settings of a headless run after the flags.
#[derive(Clone, Copy, Debug)]
struct HeadlessOptions {
    fix: FixFlags,
    debug_timings: bool,
}

/// Runs `tsgolint headless <args>` and returns the exit code.
pub fn run(
    program: &str,
    args: &[String],
    stdin: impl Read,
    stdout: impl Write + Send + 'static,
    stderr: &mut dyn Write,
) -> i32 {
    log::debug(|| "Starting tsgolint".to_string());

    let set = FlagSet {
        program: program.to_string(),
        flags: HEADLESS_FLAGS.to_vec(),
        usage: Usage::Default,
    };
    let values = match set.parse(args, stderr) {
        Ok(values) => values,
        Err(code) => return code,
    };
    let debug_timings = match parse_debug_timings(values.string("debug")) {
        Ok(timings) => timings,
        Err(e) => {
            let _ = write!(stderr, "error parsing options: {e}");
            return 1;
        }
    };
    let fix = FixFlags {
        fix: values.bool("fix"),
        fix_suggestions: values.bool("fix-suggestions"),
    };
    let options = HeadlessOptions { fix, debug_timings };

    let profiling = match Profiling::start(
        values.string("trace"),
        values.string("cpuprof"),
        values.string("heap"),
        values.string("allocs"),
    ) {
        Ok(profiling) => profiling,
        Err(e) => {
            let _ = write!(stderr, "error starting profiling: {e}");
            return 1;
        }
    };
    let code = run_with_options(options, stdin, stdout);
    profiling.finish();
    code
}

fn run_with_options(
    options: HeadlessOptions,
    mut stdin: impl Read,
    mut stdout: impl Write + Send + 'static,
) -> i32 {
    let cwd = match os_current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            return write_error(
                &mut stdout,
                &format!(
                    "error getting current directory: {}",
                    getwd_error_text(&err)
                ),
            );
        }
    };

    // oxlint writes the whole payload before it reads stdout.
    let mut data = Vec::new();
    if let Err(err) = stdin.read_to_end(&mut data) {
        return write_error(
            &mut stdout,
            &format!(
                "error reading from stdin: read /dev/stdin: {}",
                io_error_text(&err)
            ),
        );
    }
    let payload = match payload::decode(&data) {
        Ok(payload) => payload,
        Err(e) => return write_error(&mut stdout, &format!("error parsing config: {e}")),
    };
    drop(data);

    let case_sensitive = osvfs_fs().use_case_sensitive_file_names();
    let run = LintRun::new(payload, cwd, case_sensitive, options);
    on_loading_thread(move || {
        let mut writer = DiagnosticWriter::new(stdout, options.fix);
        let result = run.execute(&mut |event| writer.write(&event));
        finish(result, &mut writer.into_inner())
    })
}

/// Reports the end of the run after the diagnostics and gives the exit code.
fn finish(result: RunResult, stdout: &mut impl Write) -> i32 {
    match result {
        Err(e) => {
            // tsgolint writes this while its writer may still flush, so the
            // two can come in either order; here the diagnostics come first.
            log::print(&format!("ERROR: Linter failed: {e}"));
            write_error(stdout, &format!("error running linter: {e}"))
        }
        Ok(timings) => {
            if let Some(records) = timings
                && write_message(stdout, MessageType::Timing, encode_timings(&records)).is_err()
            {
                log::print("ERROR: failed to write timing output: json: invalid UTF-8");
                return 1;
            }
            log::debug(|| "Linting Complete".to_string());
            0
        }
    }
}

/// Writes a type-0 message and gives exit code 1.
fn write_error(stdout: &mut impl Write, text: &str) -> i32 {
    let _ = write_message(stdout, MessageType::Error, encode_error(text));
    1
}

/// Everything the loading thread needs. `Send`: each thread makes its own
/// file system from the factory.
struct LintRun {
    cwd: String,
    files: Vec<String>,
    rules: FileRules,
    fs: FsFactory,
    settings: RunSettings,
}

impl LintRun {
    fn new(payload: Payload, cwd: String, case_sensitive: bool, options: HeadlessOptions) -> Self {
        let total: usize = payload.configs.iter().map(|c| c.file_paths.len()).sum();
        log::debug(|| format!("Starting to assign files to programs. Total files: {total}"));
        let fs = headless_fs(&payload.source_overrides, case_sensitive);
        let (files, rules) = FileRules::from_payload_with_registry(&payload, &cwd, case_sensitive);
        LintRun {
            cwd,
            files,
            rules,
            fs,
            settings: RunSettings {
                lint: LintSettings {
                    fix: options.fix.fix,
                    fix_suggestions: options.fix.fix_suggestions,
                    report_syntactic: payload.report_syntactic,
                    report_semantic: payload.report_semantic,
                },
                timings: options.debug_timings,
                suppress_program_diagnostics: suppress_program_diagnostics(),
                keep_last_program: true,
            },
        }
    }

    /// Resolves the tsconfigs and lints. Runs on the loading thread.
    fn execute(self, on_event: &mut dyn FnMut(LintEvent)) -> RunResult {
        let workload = TsConfigResolver::new(self.fs.make(), &self.cwd).resolve(&self.files);
        log_workload(&workload);
        log::debug(|| format!("Starting linter with {} workers", gomaxprocs()));
        log::debug(|| {
            format!(
                "Workload distribution: {} programs",
                workload.programs.len()
            )
        });
        log::debug(|| "Running Linter".to_string());

        let timings = run_linter(
            &self.fs,
            &self.cwd,
            &workload,
            &self.rules,
            self.settings,
            on_event,
        )?;
        Ok(self.settings.timings.then(|| timings.records()))
    }
}

fn log_workload(workload: &Workload) {
    if !log::debug_enabled() {
        return;
    }
    for (config, files) in &workload.programs {
        for file in files {
            log::print(&format!("Got tsconfig for file {file}: {config}"));
        }
    }
    for file in &workload.unmatched_files {
        log::print(&format!("Got tsconfig for file {file}: <none>"));
    }
    log::print(&format!(
        "Done assigning files to programs. Total programs: {}. Unmatched files: {}",
        workload.programs.len(),
        workload.unmatched_files.len()
    ));
    for (config, files) in &workload.programs {
        log::print(&format!("  Program {config}: {} files", files.len()));
    }
    for file in &workload.unmatched_files {
        log::print(&format!("  Unmatched file: {file}"));
    }
}

type RunResult = Result<Option<Vec<RuleTimingRecord>>, String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_options() {
        assert_eq!(parse_debug_timings(""), Ok(false));
        assert_eq!(parse_debug_timings(",timings,"), Ok(true));
        assert_eq!(
            parse_debug_timings("timings,foo"),
            Err(r#"unknown debug option "foo""#.to_string())
        );
        assert_eq!(
            parse_debug_timings("Timings"),
            Err(r#"unknown debug option "Timings""#.to_string())
        );
    }
}
