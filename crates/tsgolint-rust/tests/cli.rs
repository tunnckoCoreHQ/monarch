//! Runs the `tsgolint` binary and the Go binary on the same arguments and
//! stdin, and compares exit codes, stdout bytes and stderr. The cases need
//! no linting (flag errors, payload errors, empty payloads). The Go binary is
//! `TSGOLINT_ORACLE`, else the platform binary of the repository's
//! `oxlint-tsgolint` devDependency. Without it, the cases check the
//! expectations written here only.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

struct Output {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

fn run(binary: &str, args: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> Output {
    let dir = std::env::temp_dir().join("tsgolint-cli-test");
    std::fs::create_dir_all(&dir).unwrap();
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_remove("OXC_LOG");
    for (k, v) in env {
        command.env(k, v);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = child.wait_with_output().unwrap();
    Output {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: name_program(&out.stderr),
    }
}

/// The default usage names the program (`Usage of <argv0>:`), and the npm
/// wrapper runs the Go binary under another path than its own.
fn name_program(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .split_inclusive('\n')
        .map(|line| match line.strip_prefix("Usage of ") {
            Some(rest) if rest.ends_with(":\n") => "Usage of <tsgolint>:\n",
            _ => line,
        })
        .collect()
}

fn oracle() -> Option<String> {
    // The platform binary, not the package's `node_modules/.bin/tsgolint`
    // wrapper: the wrapper is a Node script that turns the binary's death by
    // signal into exit code 1.
    let path = std::env::var("TSGOLINT_ORACLE").unwrap_or_else(|_| {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            os => os,
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            arch => arch,
        };
        format!(
            "{}/../../node_modules/.pnpm/node_modules/@oxlint-tsgolint/{os}-{arch}/tsgolint",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    Path::new(&path).exists().then_some(path)
}

/// Runs both binaries; returns ours.
fn compare(args: &[&str], stdin: &[u8]) -> Output {
    let ours = run(env!("CARGO_BIN_EXE_tsgolint"), args, stdin, &[]);
    if let Some(go) = oracle() {
        let go = run(&go, args, stdin, &[]);
        assert_eq!(ours.code, go.code, "exit code of {args:?}");
        assert_eq!(ours.stderr, go.stderr, "stderr of {args:?}");
        // JSON v2 names its failure "cannot" or "unable to" at random.
        let normalize = |b: &[u8]| String::from_utf8_lossy(b).replace("unable to", "cannot");
        assert_eq!(
            normalize(&ours.stdout),
            normalize(&go.stdout),
            "stdout of {args:?}"
        );
        if !String::from_utf8_lossy(&go.stdout).contains("unable to") {
            assert_eq!(ours.stdout, go.stdout, "stdout bytes of {args:?}");
        }
    }
    ours
}

fn error_frame(text: &str) -> Vec<u8> {
    let payload = format!(
        r#"{{"error":"{}"}}"#,
        text.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let mut out = (u32::try_from(payload.len()).unwrap())
        .to_le_bytes()
        .to_vec();
    out.push(0);
    out.extend_from_slice(payload.as_bytes());
    out
}

#[test]
fn headless_flag_errors() {
    for args in [
        &["headless", "-x"][..],
        &["headless", "--x=1"],
        &["headless", "-h"],
        &["headless", "--help"],
        &["headless", "-help=false"],
        &["headless", "-debug"],
        &["headless", "-fix=maybe"],
        &["headless", "---fix"],
        &["headless", "-=x"],
    ] {
        let out = compare(args, b"{\"version\":2}");
        assert!(out.code == 0 || out.code == 2, "{args:?}");
        assert!(
            out.stderr
                .contains("Usage of <tsgolint>:\n  -allocs string\n"),
            "{args:?}"
        );
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn headless_option_errors() {
    let out = compare(&["headless", "-debug", "foo"], b"{\"version\":2}");
    assert_eq!(
        (out.code, out.stderr.as_str()),
        (1, "error parsing options: unknown debug option \"foo\"")
    );
    let out = compare(
        &["headless", "-trace", "/nonexistent/dir/t"],
        b"{\"version\":2}",
    );
    assert_eq!(out.code, 1);
    assert_eq!(
        out.stderr,
        "error starting profiling: failed to start trace: error creating trace file: open /nonexistent/dir/t: no such file or directory"
    );
    let out = compare(
        &["headless", "-cpuprof", "/nonexistent/dir/t"],
        b"{\"version\":2}",
    );
    assert_eq!(out.code, 1);
    // Heap and allocs failures are ignored.
    let out = compare(
        &[
            "headless",
            "-heap",
            "/nonexistent/dir/h",
            "-allocs",
            "/nonexistent/dir/a",
        ],
        b"{\"version\":2}",
    );
    assert_eq!(out.code, 0);
}

#[test]
fn headless_payload_errors() {
    let cases: &[(&[u8], &str)] = &[
        (b"", "error parsing config: jsontext: unexpected EOF"),
        (
            b"{",
            "error parsing config: jsontext: unexpected EOF after offset 1",
        ),
        (
            br#"{"version":3}"#,
            "error parsing config: unsupported version `3`: expected `unset` or `2`",
        ),
        (
            br#"{"version":2,"version":2}"#,
            "error parsing config: jsontext: duplicate object member name \"version\"",
        ),
        (br#"{}"#, "error parsing config: V1 payload has no files"),
        (
            br#"{"Version":2}"#,
            "error parsing config: V1 payload has no files",
        ),
        (
            br#"{"version":2,"configs":[{"file_paths":[1]}]}"#,
            "error parsing config: failed to deserialize V2 payload: json: cannot unmarshal JSON number into Go string within \"/configs/0/file_paths/0\"",
        ),
        (
            br#"{"version":2} x"#,
            "error parsing config: jsontext: invalid character 'x' after top-level value after offset 14",
        ),
    ];
    for (stdin, text) in cases {
        let out = compare(&["headless"], stdin);
        assert_eq!(out.code, 1);
        assert_eq!(out.stdout, error_frame(text));
    }
}

#[test]
fn headless_empty_runs() {
    for stdin in [
        &br#"{"version":2}"#[..],
        br#"{"version":2,"configs":null,"source_overrides":null,"report_syntactic":null}"#,
        br#"{"version":2,"configs":[]}"#,
    ] {
        let out = compare(&["headless"], stdin);
        assert_eq!(
            (out.code, out.stdout.as_slice(), out.stderr.as_str()),
            (0, &b""[..], "")
        );
    }
    // Positional arguments are ignored; flags after them are not parsed.
    let out = compare(&["headless", "-fix", "true", "-x"], br#"{"version":2}"#);
    assert_eq!(out.code, 0);
    let out = compare(&["headless", "-debug=,timings,"], br#"{"version":2}"#);
    assert_eq!(out.stdout, b"\x0c\x00\x00\x00\x02{\"rules\":[]}");
}

#[test]
fn legacy_flag_errors() {
    for args in [
        &["-x"][..],
        &["--version"],
        &["-h"],
        &["--help"],
        &["-debug"],
        &["-singleThreaded=x"],
    ] {
        let out = compare(args, b"");
        assert!(
            out.stderr
                .contains("\u{2728} tsgolint - speedy TypeScript linter"),
            "{args:?}"
        );
    }
    let out = compare(&["-debug", "foo"], b"");
    assert_eq!(
        (out.code, out.stderr.as_str()),
        (
            1,
            "error parsing debug options: unknown debug option \"foo\"\n"
        )
    );
    let out = compare(&["-tsconfig", "/nonexistent.json"], b"");
    assert_eq!(out.code, 1);
    assert!(
        out.stderr
            .ends_with("error: tsconfig \"/nonexistent.json\" doesn't exist")
    );
}

/// When stdout's reader has gone, the first write ends the process by
/// SIGPIPE, as in Go.
#[cfg(unix)]
#[test]
fn closed_stdout_ends_by_sigpipe() {
    use std::os::unix::process::ExitStatusExt;

    let binaries = std::iter::once(env!("CARGO_BIN_EXE_tsgolint").to_string()).chain(oracle());
    for binary in binaries {
        let mut child = Command::new(&binary)
            .arg("headless")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // The binary reads stdin to EOF before it writes, so the reader is
        // gone by then.
        drop(child.stdout.take());
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"version":3}"#)
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(
            (out.status.code(), out.status.signal()),
            (None, Some(13)),
            "{binary}"
        );
        assert_eq!(String::from_utf8_lossy(&out.stderr), "", "{binary}");
    }
}
