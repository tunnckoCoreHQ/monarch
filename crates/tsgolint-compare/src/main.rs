//! Compares the Go tsgolint (the oracle) with tsgolint-rust on the same `headless` payload.
//!
//! ```text
//! tsgolint-compare payload <project-dir> [--rules a,b] [--type-check] > payload.json
//! tsgolint-compare run --go <bin> --rust <bin> --payload <file> [--cwd <dir>] [--flags "-fix -fix-suggestions"] [--out <dir>]
//! ```
//!
//! `payload` lists the `.ts`, `.tsx`, `.mts` and `.cts` files of a project (skipping `node_modules`, `.git` and build
//! output) and enables every rule with its default options. `run` executes both binaries, decodes the framed output,
//! sorts the diagnostics the way tsgolint's e2e suite does, and prints the differences and the wall time of each. It
//! also compares the raw outputs: the same frames byte for byte, in the same order within each file.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The names of `tsgolint_rules::ALL_RULES`, in its order (a test checks
/// it). A copy, so that this tool does not build ts-rust.
const RULES: &[&str] = &[
    "await-thenable",
    "consistent-return",
    "consistent-type-exports",
    "dot-notation",
    "no-array-delete",
    "no-base-to-string",
    "no-confusing-void-expression",
    "no-deprecated",
    "no-duplicate-type-constituents",
    "no-floating-promises",
    "no-for-in-array",
    "no-generated-empty-object-type",
    "no-implied-eval",
    "no-meaningless-void-operator",
    "no-misused-promises",
    "no-misused-spread",
    "no-mixed-enums",
    "no-redundant-type-constituents",
    "no-unnecessary-boolean-literal-compare",
    "no-unnecessary-condition",
    "no-unnecessary-qualifier",
    "no-unnecessary-template-expression",
    "no-unnecessary-type-conversion",
    "no-unnecessary-type-arguments",
    "no-unnecessary-type-parameters",
    "no-unnecessary-type-assertion",
    "no-useless-default-assignment",
    "no-unsafe-argument",
    "no-unsafe-assignment",
    "no-unsafe-call",
    "no-unsafe-enum-comparison",
    "no-unsafe-member-access",
    "no-unsafe-return",
    "no-unsafe-type-assertion",
    "no-unsafe-unary-minus",
    "non-nullable-type-assertion-style",
    "only-throw-error",
    "prefer-find",
    "prefer-includes",
    "prefer-optional-chain",
    "prefer-nullish-coalescing",
    "prefer-promise-reject-errors",
    "prefer-readonly-parameter-types",
    "prefer-regexp-exec",
    "prefer-readonly",
    "prefer-reduce-type-parameter",
    "prefer-return-this-type",
    "prefer-string-starts-ends-with",
    "promise-function-async",
    "related-getter-setter-pairs",
    "require-array-sort-compare",
    "require-await",
    "restrict-plus-operands",
    "restrict-template-expressions",
    "return-await",
    "strict-boolean-expressions",
    "strict-void-return",
    "switch-exhaustiveness-check",
    "unbound-method",
    "use-unknown-in-catch-callback-variable",
];

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".turbo",
    ".next",
    "coverage",
];
const EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts"];

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("payload") => payload(&args[1..]),
        Some("run") => run(&args[1..]),
        _ => Err("usage: tsgolint-compare payload <dir> [--rules a,b] [--type-check] | run --go <bin> --rust <bin> --payload <file> [--cwd <dir>] [--flags <flags>] [--out <dir>]".into()),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}

fn flag_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn payload(args: &[String]) -> Result<ExitCode, String> {
    let dir = args.first().ok_or("payload: missing project dir")?;
    let root = std::fs::canonicalize(dir).map_err(|e| format!("{dir}: {e}"))?;
    let mut files = Vec::new();
    collect_files(&root, &mut files);
    files.sort();
    let rules: Vec<&str> = match flag_value(args, "--rules") {
        Some(list) => list.split(',').collect(),
        None => RULES.to_vec(),
    };
    let type_check = args.iter().any(|a| a == "--type-check");
    let payload = json!({
        "version": 2,
        "configs": [{
            "file_paths": files.iter().map(|f| f.to_string_lossy()).collect::<Vec<_>>(),
            "rules": rules.iter().map(|r| json!({ "name": r })).collect::<Vec<_>>(),
        }],
        "report_syntactic": type_check,
        "report_semantic": type_check,
    });
    println!("{payload}");
    Ok(ExitCode::SUCCESS)
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_ref()) {
                collect_files(&path, out);
            }
        } else if kind.is_file()
            && !name.ends_with(".d.ts")
            && path
                .extension()
                .is_some_and(|e| EXTENSIONS.contains(&e.to_string_lossy().as_ref()))
        {
            out.push(path);
        }
    }
}

struct Outcome {
    status: Option<i32>,
    stderr: String,
    elapsed: Duration,
    messages: Vec<(u8, Value)>,
    raw: Vec<u8>,
}

fn execute(
    bin: &str,
    flags: &[&str],
    payload: &[u8],
    cwd: Option<&str>,
) -> Result<Outcome, String> {
    let mut command = Command::new(bin);
    command
        .arg("headless")
        .args(flags)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let start = Instant::now();
    let mut child = command.spawn().map_err(|e| format!("{bin}: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = payload.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("{bin}: {e}"))?;
    let elapsed = start.elapsed();
    let _ = writer.join();
    Ok(Outcome {
        status: output.status.code(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        elapsed,
        messages: decode_frames(&output.stdout)?,
        raw: output.stdout,
    })
}

fn decode_frames(mut bytes: &[u8]) -> Result<Vec<(u8, Value)>, String> {
    let mut messages = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 5 {
            return Err(format!(
                "truncated frame header ({} bytes left)",
                bytes.len()
            ));
        }
        let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let kind = bytes[4];
        let body = bytes.get(5..5 + len).ok_or("truncated frame body")?;
        let value: Value =
            serde_json::from_slice(body).map_err(|e| format!("bad frame JSON: {e}"))?;
        messages.push((kind, value));
        bytes = &bytes[5 + len..];
    }
    Ok(messages)
}

/// The e2e sort key: file path, rule ("" for internal diagnostics), range start, range end.
fn sort_key(d: &Value) -> (String, String, i64, i64) {
    let range = &d["range"];
    (
        d["file_path"].as_str().unwrap_or_default().to_string(),
        d["rule"].as_str().unwrap_or_default().to_string(),
        range["pos"].as_i64().unwrap_or(0),
        range["end"].as_i64().unwrap_or(0),
    )
}

fn diagnostics(outcome: &Outcome) -> Vec<Value> {
    let mut list: Vec<Value> = outcome
        .messages
        .iter()
        .filter(|(k, _)| *k == 1)
        .map(|(_, v)| v.clone())
        .collect();
    list.sort_by_key(sort_key);
    list
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let go = flag_value(args, "--go").ok_or("run: missing --go")?;
    let rust = flag_value(args, "--rust").ok_or("run: missing --rust")?;
    let payload_path = flag_value(args, "--payload").ok_or("run: missing --payload")?;
    let cwd = flag_value(args, "--cwd");
    let flags: Vec<&str> = flag_value(args, "--flags")
        .map(|f| f.split_whitespace().collect())
        .unwrap_or_default();
    let payload = std::fs::read(payload_path).map_err(|e| format!("{payload_path}: {e}"))?;

    let go_out = execute(go, &flags, &payload, cwd)?;
    let rust_out = execute(rust, &flags, &payload, cwd)?;

    if let Some(dir) = flag_value(args, "--out") {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        for (name, outcome) in [("go", &go_out), ("rust", &rust_out)] {
            let lines: Vec<String> = diagnostics(outcome).iter().map(Value::to_string).collect();
            std::fs::write(format!("{dir}/{name}.jsonl"), lines.join("\n") + "\n")
                .map_err(|e| e.to_string())?;
            std::fs::write(format!("{dir}/{name}.bin"), &outcome.raw).map_err(|e| e.to_string())?;
            std::fs::write(format!("{dir}/{name}.stderr"), &outcome.stderr)
                .map_err(|e| e.to_string())?;
        }
    }

    let go_diags = diagnostics(&go_out);
    let rust_diags = diagnostics(&rust_out);
    let mut by_rule: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for d in &go_diags {
        by_rule.entry(rule_label(d)).or_default().0 += 1;
    }
    for d in &rust_diags {
        by_rule.entry(rule_label(d)).or_default().1 += 1;
    }

    // Multiset difference keyed on the whole normalized diagnostic.
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for d in &go_diags {
        *counts.entry(d.to_string()).or_default() += 1;
    }
    for d in &rust_diags {
        *counts.entry(d.to_string()).or_default() -= 1;
    }
    let only_go: Vec<&String> = counts
        .iter()
        .filter(|(_, n)| **n > 0)
        .map(|(k, _)| k)
        .collect();
    let only_rust: Vec<&String> = counts
        .iter()
        .filter(|(_, n)| **n < 0)
        .map(|(k, _)| k)
        .collect();

    println!(
        "go:   exit {:?}, {} messages, {} diagnostics, {:.3}s",
        go_out.status,
        go_out.messages.len(),
        go_diags.len(),
        go_out.elapsed.as_secs_f64()
    );
    println!(
        "rust: exit {:?}, {} messages, {} diagnostics, {:.3}s",
        rust_out.status,
        rust_out.messages.len(),
        rust_diags.len(),
        rust_out.elapsed.as_secs_f64()
    );
    for (name, outcome) in [("go", &go_out), ("rust", &rust_out)] {
        for (kind, value) in &outcome.messages {
            if *kind == 0 {
                println!("{name} error: {value}");
            }
        }
        if !outcome.stderr.is_empty() {
            let head: String = outcome
                .stderr
                .lines()
                .take(5)
                .collect::<Vec<_>>()
                .join("\n");
            println!("{name} stderr:\n{head}");
        }
    }
    println!("\n{:<45} {:>7} {:>7}", "rule", "go", "rust");
    for (rule, (g, r)) in &by_rule {
        let mark = if g == r { "" } else { "  <-" };
        println!("{rule:<45} {g:>7} {r:>7}{mark}");
    }
    println!("\nonly in go: {}", only_go.len());
    for d in only_go.iter().take(40) {
        println!("  - {d}");
    }
    println!("only in rust: {}", only_rust.len());
    for d in only_rust.iter().take(40) {
        println!("  + {d}");
    }
    let raw_same = compare_raw(&go_out.raw, &rust_out.raw);
    let same =
        only_go.is_empty() && only_rust.is_empty() && go_out.status == rust_out.status && raw_same;
    Ok(if same {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

fn rule_label(d: &Value) -> String {
    match d["rule"].as_str() {
        Some(rule) => rule.to_string(),
        None => format!("[{}]", d["message"]["id"].as_str().unwrap_or("internal")),
    }
}

/// The raw frames of an output (header and body bytes), grouped by the file
/// each frame is about, in output order. Native runs lint files on several
/// checker threads, so files interleave in a varying order, but the frames
/// of one file always come in the same order.
fn frames_by_file(mut bytes: &[u8]) -> BTreeMap<String, Vec<&[u8]>> {
    let mut files: BTreeMap<String, Vec<&[u8]>> = BTreeMap::new();
    while bytes.len() >= 5 {
        let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let Some(frame) = bytes.get(..5 + len) else {
            break;
        };
        let file = serde_json::from_slice::<Value>(&frame[5..])
            .ok()
            .and_then(|v| v["file_path"].as_str().map(str::to_string));
        files
            .entry(file.unwrap_or_default())
            .or_default()
            .push(frame);
        bytes = &bytes[5 + len..];
    }
    files
}

/// Compares the raw outputs byte for byte: the whole stream, else the frames
/// of each file. Returns whether they match.
fn compare_raw(go: &[u8], rust: &[u8]) -> bool {
    if go == rust {
        println!("raw output: identical ({} bytes)", go.len());
        return true;
    }
    let (go_files, rust_files) = (frames_by_file(go), frames_by_file(rust));
    let files: std::collections::BTreeSet<&String> =
        go_files.keys().chain(rust_files.keys()).collect();
    let differing: Vec<&String> = files
        .into_iter()
        .filter(|f| go_files.get(*f) != rust_files.get(*f))
        .collect();
    if differing.is_empty() {
        println!(
            "raw output: same frames byte for byte, same order within each of {} files; files interleave differently",
            go_files.len()
        );
        return true;
    }
    println!("raw output: {} files differ", differing.len());
    for file in differing.iter().take(10) {
        println!("  {file}");
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn rules_match_the_registry() {
        let registry: Vec<&str> = tsgolint_rules::ALL_RULES
            .iter()
            .map(|rule| rule.name)
            .collect();
        assert_eq!(super::RULES, registry.as_slice());
    }
}
