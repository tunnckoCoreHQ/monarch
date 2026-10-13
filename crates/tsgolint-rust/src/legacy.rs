//! The unsupported `tsgolint [OPTIONS]` command line (Go `runMain` in
//! `cmd/tsgolint/main.go`): lints one tsconfig with every rule and prints
//! ANSI code frames.

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use goport_core::ast::{source_file_file_name, source_file_info, source_file_text};
use goport_core::core::Node;
use goport_core::gostd::strconv;
use goport_util::frontend::tspath::{
    ComparePathsOptions, convert_to_relative_path, get_directory_path, normalize_path,
    resolve_path, to_path,
};
use goport_util::frontend::vfs::{getwd_error_text, os_current_dir};
use goport_util::gostd::slices::sort_func;
use rustc_hash::FxHashMap;
use serde_json::Value;
use tsgolint_core::text::{ecma_line_starts, line_and_utf16_column};
use tsgolint_core::{
    ConfiguredRule, CreatedProgram, FsFactory, LintDebug, LintEvent, LintFile, LintSettings,
    ProgramSettings, RuleDiagnostic, RuleTimingRecord, create_program, lint_program_with,
};

use crate::driver::on_loading_thread;
use crate::flags::{Flag, FlagKind, FlagSet, Usage};
use crate::headless::{gomaxprocs, parse_debug_timings};
use crate::profiling::{start_cpu_profile, start_trace};

const UNSUPPORTED_CLI_WARNING: &str = "Warning: the `tsgolint` CLI entrypoint is unsupported!\nUse Oxlint type-aware linting instead: https://oxc.rs/docs/guide/usage/linter/type-aware\n\n";

/// tsgolint's `usage` text, byte for byte (the two tabs are in the Go
/// source).
pub const USAGE: &str = "Warning: the `tsgolint` CLI entrypoint is unsupported!
Use Oxlint type-aware linting instead: https://oxc.rs/docs/guide/usage/linter/type-aware

\u{2728} tsgolint - speedy TypeScript linter

Usage:
    tsgolint [OPTIONS]

Options:
    --tsconfig PATH   Which tsconfig to use. Defaults to tsconfig.json.
\t\t--list-files      List matched files
    --debug OPTIONS   Enable debug output options. Possible values: timings.
    -h, --help        Show help
";

pub const LEGACY_FLAGS: &[Flag] = &[
    Flag {
        name: "tsconfig",
        kind: FlagKind::String,
        usage: "which tsconfig to use",
    },
    Flag {
        name: "list-files",
        kind: FlagKind::Bool,
        usage: "list matched files",
    },
    Flag {
        name: "debug",
        kind: FlagKind::String,
        usage: "enable debug output options",
    },
    Flag {
        name: "help",
        kind: FlagKind::Bool,
        usage: "show help",
    },
    Flag {
        name: "h",
        kind: FlagKind::Bool,
        usage: "show help",
    },
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
        name: "singleThreaded",
        kind: FlagKind::Bool,
        usage: "run in single threaded mode",
    },
];

struct LegacyOptions {
    tsconfig: String,
    list_files: bool,
    debug_timings: bool,
    single_threaded: bool,
}

/// Runs the legacy command line and returns the exit code.
pub fn run(program: &str, args: &[String]) -> i32 {
    let mut stderr = std::io::stderr();
    let set = FlagSet {
        program: program.to_string(),
        flags: LEGACY_FLAGS.to_vec(),
        usage: Usage::Text(USAGE),
    };
    let values = match set.parse(args, &mut stderr) {
        Ok(values) => values,
        Err(code) => return code,
    };
    if values.bool("help") || values.bool("h") {
        set.print_usage(&mut stderr);
        return 0;
    }
    let debug_timings = match parse_debug_timings(values.string("debug")) {
        Ok(timings) => timings,
        Err(e) => {
            let _ = writeln!(stderr, "error parsing debug options: {e}");
            return 1;
        }
    };
    let _ = stderr.write_all(UNSUPPORTED_CLI_WARNING.as_bytes());
    let started = Instant::now();
    if let Err(e) = start_trace(values.string("trace"))
        .and_then(|()| start_cpu_profile(values.string("cpuprof")))
    {
        let _ = stderr.write_all(e.as_bytes());
        return 1;
    }
    let options = LegacyOptions {
        tsconfig: values.string("tsconfig").to_string(),
        list_files: values.bool("list-files"),
        debug_timings,
        single_threaded: values.bool("singleThreaded"),
    };
    on_loading_thread(move || lint(&options, started))
}

fn lint(options: &LegacyOptions, started: Instant) -> i32 {
    let mut stderr = std::io::stderr();
    let current_directory = match os_current_dir() {
        Ok(cwd) => normalize_path(&cwd),
        Err(err) => {
            let _ = writeln!(
                stderr,
                "error getting current directory: {}",
                getwd_error_text(&err)
            );
            return 1;
        }
    };

    let mut fs = FsFactory::base();
    let config_file_name = if options.tsconfig.is_empty() {
        let config_file_name = resolve_path(&current_directory, &["tsconfig.json"]);
        if !fs.make().file_exists(&config_file_name) {
            let files: FxHashMap<String, String> = [(config_file_name.clone(), "{}".to_string())]
                .into_iter()
                .collect();
            fs = FsFactory::exact_overlay(fs, Arc::new(files));
        }
        config_file_name
    } else {
        let config_file_name = resolve_path(&current_directory, &[&options.tsconfig]);
        if !fs.make().file_exists(&config_file_name) {
            let _ = write!(
                stderr,
                "error: tsconfig {} doesn't exist",
                strconv::quote(&options.tsconfig)
            );
            return 1;
        }
        config_file_name
    };
    let current_directory = get_directory_path(&config_file_name);
    let case_sensitive = fs.make().use_case_sensitive_file_names();
    let compare_options = ComparePathsOptions {
        use_case_sensitive_file_names: case_sensitive,
        current_directory: current_directory.clone(),
    };

    let settings = ProgramSettings {
        single_threaded: options.single_threaded,
        suppress_program_diagnostics: false,
    };
    let program = match create_program(&fs, &current_directory, &config_file_name, settings) {
        Err(e) => {
            let _ = write!(stderr, "error creating TS program: {e}");
            return 1;
        }
        // tsconfig errors are not shown here.
        Ok(CreatedProgram::Invalid(_)) => {
            let _ = write!(stderr, "error creating TS program");
            return 1;
        }
        Ok(CreatedProgram::Program(program)) => program,
    };

    let mut cwd_path = to_path("", &current_directory, case_sensitive).0;
    if !cwd_path.ends_with('/') {
        cwd_path.push('/');
    }
    // (file, file name, text) of the files to lint.
    let mut files: Vec<(Node, String, String)> = Vec::new();
    let mut listed = String::new();
    {
        let _scope = program.enter();
        for file in program.source_files() {
            let path = &source_file_info(file).path;
            if path.contains("/node_modules/") {
                continue;
            }
            if let Some(relative) = path.strip_prefix(&cwd_path) {
                if options.list_files {
                    listed.push_str("Found file: ");
                    listed.push_str(relative);
                    listed.push('\n');
                }
                files.push((
                    file,
                    source_file_file_name(file).to_owned(),
                    source_file_text(file).to_string(),
                ));
            }
        }
    }
    let mut stdout = crate::stdout::Stdout;
    if options.list_files {
        let _ = stdout.write_all(listed.as_bytes());
    }
    // Larger files first. tsgolint sorts with Go's unstable `slices.SortFunc`; `sort_func` puts
    // files of equal length in the same order, so the output order and checker history match.
    sort_func(&mut files, |a, b| b.2.len().cmp(&a.2.len()) as i32);

    let all_rules: Arc<[ConfiguredRule]> = tsgolint_rules::ALL_RULES
        .iter()
        .map(|&definition| ConfiguredRule::new(definition, Value::Null))
        .collect();
    let texts: FxHashMap<&str, &str> = files
        .iter()
        .map(|(_, name, text)| (name.as_str(), text.as_str()))
        .collect();
    let lint_files: Vec<LintFile> = files
        .iter()
        .map(|&(file, _, _)| LintFile {
            file,
            rules: all_rules.clone(),
        })
        .collect();

    let mut out = std::io::BufWriter::with_capacity(4096 * 100, stdout);
    let mut errors_count = 0usize;
    let lint_settings = LintSettings {
        fix: true,
        fix_suggestions: true,
        report_syntactic: false,
        report_semantic: false,
    };
    let debug = LintDebug {
        timings: options.debug_timings,
        on_file: crate::log::debug_enabled().then_some(crate::log::print as fn(&str)),
    };
    let timings = lint_program_with(&program, &lint_files, lint_settings, debug, &mut |event| {
        if let LintEvent::Rule(d) = event {
            errors_count += 1;
            if errors_count == 1 {
                let _ = out.write_all(b"\n");
            }
            let text = texts.get(d.file_name.as_str()).copied().unwrap_or("");
            let _ = out.write_all(&print_diagnostic(&d, text, &compare_options));
        }
    });
    let _ = out.flush();
    let mut stdout = out
        .into_inner()
        .unwrap_or_else(|e| e.into_inner().into_parts().0);

    let threads = if options.single_threaded {
        1
    } else {
        gomaxprocs()
    };
    let _ = writeln!(
        stdout,
        "Found {}{}\x1b[0m {} \x1b[2m(linted \x1b[1m{}\x1b[22m\x1b[2m {} with \x1b[1m{}\x1b[22m\x1b[2m {} in \x1b[1m{}\x1b[22m\x1b[2m using \x1b[1m{}\x1b[22m\x1b[2m threads)",
        if errors_count == 0 {
            "\x1b[1;32m"
        } else {
            "\x1b[1m"
        },
        errors_count,
        if errors_count == 1 { "error" } else { "errors" },
        files.len(),
        if files.len() == 1 { "file" } else { "files" },
        all_rules.len(),
        if all_rules.len() == 1 {
            "rule"
        } else {
            "rules"
        },
        go_duration_ms(started.elapsed()),
        threads,
    );
    if options.debug_timings {
        let _ = stdout.write_all(format_rule_timing_table(&timings.records()).as_bytes());
    }
    let _ = stdout.flush();
    0
}

/// Go `Duration.String()` of a duration rounded to milliseconds.
fn go_duration_ms(d: Duration) -> String {
    let ms = (d.as_nanos() + 500_000) / 1_000_000;
    if ms == 0 {
        return "0s".into();
    }
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let (hours, minutes) = (ms / 3_600_000, ms / 60_000 % 60);
    let seconds = format!("{}.{:03}", ms / 1000 % 60, ms % 1000);
    let seconds = seconds.trim_end_matches('0').trim_end_matches('.');
    let mut out = String::new();
    if hours > 0 {
        out.push_str(&format!("{hours}h"));
    }
    if hours > 0 || minutes > 0 {
        out.push_str(&format!("{minutes}m"));
    }
    out.push_str(seconds);
    out.push('s');
    out
}

/// Go `formatRuleTimingTable`.
fn format_rule_timing_table(records: &[RuleTimingRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }
    let rule_width = records
        .iter()
        .map(|r| r.rule_name.len())
        .max()
        .unwrap_or(0)
        .max("Rule".len());
    let calls_width = records
        .iter()
        .map(|r| r.calls.to_string().len())
        .max()
        .unwrap_or(0)
        .max("Calls".len());
    let total: u64 = records.iter().map(|r| r.duration).sum();
    let mut out = String::from("\nRule timings:\n");
    out.push_str(&format!(
        "{:<rule_width$}  {:>10}  {:>8}  {:>calls_width$}\n",
        "Rule", "Time (ms)", "Relative", "Calls"
    ));
    out.push_str(&format!(
        "{:<rule_width$}  {:<10}  {:<8}  {:<calls_width$}\n",
        "-".repeat(rule_width),
        "-".repeat(10),
        "-".repeat(8),
        "-".repeat(calls_width)
    ));
    for record in records {
        #[allow(clippy::cast_precision_loss)]
        let millis = record.duration as f64 / 1e6;
        #[allow(clippy::cast_precision_loss)]
        let relative = if total > 0 {
            record.duration as f64 / total as f64 * 100.0
        } else {
            0.0
        };
        out.push_str(&format!(
            "{:<rule_width$}  {millis:>10.3}  {relative:>7.1}%  {:>calls_width$}\n",
            record.rule_name, record.calls
        ));
    }
    out
}

fn is_line_break(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Go `printDiagnostic`: the ANSI code frame of one rule diagnostic.
#[allow(
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::too_many_lines
)]
fn print_diagnostic(d: &RuleDiagnostic, text: &str, compare: &ComparePathsOptions) -> Vec<u8> {
    let mut w: Vec<u8> = Vec::new();
    let bytes = text.as_bytes();
    let ecma_lines = ecma_line_starts(text);
    let (start_line, start_column) = line_and_utf16_column(&ecma_lines, text, d.range.pos().max(0));
    let (end_line, _) = line_and_utf16_column(&ecma_lines, text, d.range.end().max(0));
    // Byte offsets and line indexes as usize from here on.
    let line_map: Vec<usize> = ecma_lines.iter().map(|&start| start as usize).collect();
    let (start_line, end_line) = (start_line as usize, end_line as usize);
    let diagnostic_start = d.range.pos().max(0) as usize;
    let diagnostic_end = d.range.end().max(0) as usize;

    let box_start_line = start_line.saturating_sub(1);
    let box_end_line = (end_line + 1).min(line_map.len() - 1);
    let box_start = line_map[box_start_line];
    // Go `GetECMAEndLinePosition` + 1: where the line break starts.
    let box_end = {
        let mut pos = line_map[box_end_line];
        while let Some(ch) = text.get(pos..).and_then(|s| s.chars().next()) {
            if is_line_break(ch) {
                break;
            }
            pos += ch.len_utf8();
        }
        pos
    };

    w.extend_from_slice(b" \x1b[7m\x1b[1m\x1b[38;5;37m ");
    w.extend_from_slice(d.rule.as_bytes());
    w.extend_from_slice(" \x1b[0m \u{2014} ".as_bytes());
    let description = d.message.description.as_bytes();
    let mut line_start = 0;
    for (i, &b) in description.iter().enumerate() {
        if b == b'\n' {
            w.extend_from_slice(&description[line_start..=i]);
            line_start = i + 1;
            w.extend_from_slice("    \x1b[2m\u{2502}\x1b[0m".as_bytes());
            w.extend(std::iter::repeat_n(b' ', d.rule.len() + 1));
        }
    }
    w.extend_from_slice(&description[line_start..]);
    w.extend_from_slice("\n  \x1b[2m\u{256d}\u{2500}\u{2534}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}(\x1b[0m \x1b[3m\x1b[38;5;117m".as_bytes());
    w.extend_from_slice(convert_to_relative_path(&d.file_name, compare).as_bytes());
    w.extend_from_slice(format!(":{}:{}", start_line + 1, start_column + 1).as_bytes());
    w.extend_from_slice(
        "\x1b[0m \x1b[2m)\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\x1b[0m\n".as_bytes(),
    );

    const BOX_LINES: usize = 13;
    let frame_end = "  \x1b[2m\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\x1b[0m\n\n";
    if box_end_line - box_start_line >= BOX_LINES {
        w.extend_from_slice(
            "  \x1b[2m\u{2502}\x1b[0m  Error range is too big. Skipping code block printing.\n"
                .as_bytes(),
        );
        w.extend_from_slice(frame_end.as_bytes());
        return w;
    }

    // Byte offsets as Go ints: an all-blank box makes the indent MaxInt and
    // these sums wrap, as in Go.
    let mut indent_size = isize::MAX;
    let mut line = box_start_line;
    let mut indent_found = false;
    let mut last_non_space: isize = -1;
    let mut line_starts = [0isize; BOX_LINES];
    let mut line_ends = [0isize; BOX_LINES];
    for (i, ch) in text[box_start..box_end].char_indices() {
        let i = i as isize;
        if ch == '\n' {
            if line != box_end_line {
                indent_found = false;
                line_ends[line - box_start_line] =
                    last_non_space - line_map[line] as isize + box_start as isize;
                last_non_space = -1;
                line += 1;
            }
            continue;
        }
        if !indent_found && !ch.is_whitespace() {
            indent_found = true;
            line_starts[line - box_start_line] = i - line_map[line] as isize + box_start as isize;
            indent_size = indent_size.min(line_starts[line - box_start_line]);
        }
        if indent_found && !ch.is_whitespace() {
            last_non_space = i + 1;
        }
    }
    if line == box_end_line {
        line_ends[line - box_start_line] =
            last_non_space - line_map[line] as isize + box_start as isize;
    }

    let slice = |from: isize, to: isize| -> &[u8] { &bytes[from as usize..to as usize] };
    let mut highlight = false;
    let last_line_number = (box_end_line + 1).to_string();
    for line in box_start_line..=box_end_line {
        w.extend_from_slice("  \x1b[2m\u{2502} ".as_bytes());
        if line == box_end_line {
            w.extend_from_slice(last_line_number.as_bytes());
        } else {
            let number = (line + 1).to_string();
            // One space of padding, whatever the width difference.
            if number.len() < last_line_number.len() {
                w.push(b' ');
            }
            w.extend_from_slice(number.as_bytes());
        }
        w.extend_from_slice(" \u{2502}\x1b[0m  ".as_bytes());

        let line_start = line_map[line] as isize;
        let text_start = line_start.wrapping_add(indent_size);
        let mut underline_start = text_start.max(line_start + line_starts[line - box_start_line]);
        let mut underline_end = underline_start;
        let text_end = (line_start + line_ends[line - box_start_line]).max(text_start);
        let is_last = line == line_map.len() - 1;
        let start = diagnostic_start as isize;
        let end = diagnostic_end as isize;
        if highlight {
            underline_end = text_end;
        } else if line_start <= start && (is_last || start < line_map[line + 1] as isize) {
            underline_start = text_start.max(start).min(text_end);
            underline_end = text_end;
            highlight = true;
        }
        if line_start <= end && (is_last || end < line_map[line + 1] as isize) {
            underline_end = underline_start.max(end).min(text_end);
            highlight = false;
        }

        if underline_start != underline_end {
            w.extend_from_slice(slice(text_start, underline_start));
            w.extend_from_slice(b"\x1b[4m\x1b[4:3m\x1b[58:5:160m\x1b[38;5;160m\x1b[22;49m");
            w.extend_from_slice(slice(underline_start, underline_end));
            w.extend_from_slice(b"\x1b[0m");
            w.extend_from_slice(slice(underline_end, text_end));
        } else if text_start != text_end {
            w.extend_from_slice(slice(text_start, text_end));
        }
        w.push(b'\n');
    }
    w.extend_from_slice(frame_end.as_bytes());
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use tsgolint_core::{RuleMessage, TextRange};

    #[test]
    fn durations() {
        assert_eq!(go_duration_ms(Duration::from_micros(400)), "0s");
        assert_eq!(go_duration_ms(Duration::from_micros(1500)), "2ms");
        assert_eq!(go_duration_ms(Duration::from_millis(999)), "999ms");
        assert_eq!(go_duration_ms(Duration::from_millis(1000)), "1s");
        assert_eq!(go_duration_ms(Duration::from_millis(1230)), "1.23s");
        assert_eq!(go_duration_ms(Duration::from_millis(62_005)), "1m2.005s");
        assert_eq!(go_duration_ms(Duration::from_millis(3_600_000)), "1h0m0s");
    }

    #[test]
    fn timing_table() {
        let records = vec![
            RuleTimingRecord {
                rule_name: "no-floating-promises".into(),
                duration: 3_000_000,
                calls: 12,
            },
            RuleTimingRecord {
                rule_name: "a".into(),
                duration: 1_000_000,
                calls: 3,
            },
        ];
        assert_eq!(
            format_rule_timing_table(&records),
            "\nRule timings:\n\
             Rule                   Time (ms)  Relative  Calls\n\
             --------------------  ----------  --------  -----\n\
             no-floating-promises       3.000     75.0%     12\n\
             a                          1.000     25.0%      3\n"
        );
        assert_eq!(format_rule_timing_table(&[]), "");
    }

    #[test]
    fn code_frame() {
        let text = "const a = 1;\n  foo(bar);\nconst b = 2;\n";
        let d = RuleDiagnostic {
            rule: "r".into(),
            file_name: "/p/src/a.ts".into(),
            range: TextRange::new(15, 23),
            message: RuleMessage {
                id: "m".into(),
                description: "Two\nlines".into(),
                help: String::new(),
            },
            labeled_ranges: vec![],
            fixes: None,
            suggestions: None,
        };
        let compare = ComparePathsOptions {
            use_case_sensitive_file_names: true,
            current_directory: "/p".into(),
        };
        let out = String::from_utf8(print_diagnostic(&d, text, &compare)).unwrap();
        let expected = concat!(
            " \x1b[7m\x1b[1m\x1b[38;5;37m r \x1b[0m \u{2014} Two\n    \x1b[2m\u{2502}\x1b[0m  lines",
            "\n  \x1b[2m\u{256d}\u{2500}\u{2534}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}(\x1b[0m \x1b[3m\x1b[38;5;117msrc/a.ts:2:3\x1b[0m \x1b[2m)\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\x1b[0m\n",
            "  \x1b[2m\u{2502} 1 \u{2502}\x1b[0m  const a = 1;\n",
            "  \x1b[2m\u{2502} 2 \u{2502}\x1b[0m    \x1b[4m\x1b[4:3m\x1b[58:5:160m\x1b[38;5;160m\x1b[22;49mfoo(bar)\x1b[0m;\n",
            "  \x1b[2m\u{2502} 3 \u{2502}\x1b[0m  const b = 2;\n",
            "  \x1b[2m\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\x1b[0m\n\n",
        );
        assert_eq!(out, expected);
    }
}
