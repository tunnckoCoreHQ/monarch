//! Go's `flag` package, as tsgolint uses it (`flag.CommandLine` with
//! `ExitOnError`).
//!
//! - `-name` and `--name` are the same flag.
//! - A string flag takes `-name=value` or `-name value`.
//! - A bool flag takes `-name` or `-name=value` (`strconv.ParseBool`); in
//!   `-name value`, the value is a positional argument.
//! - Parsing stops at the first non-flag argument (a lone `-` is one) or
//!   after `--`.
//! - An error prints its message and the usage to stderr and exits 2;
//!   `-h` and `-help`, when not defined, print the usage and exit 0.

use std::io::Write;

use goport_core::gostd::strconv;
use rustc_hash::FxHashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagKind {
    Bool,
    String,
}

/// A defined flag. Every tsgolint flag defaults to the zero value.
#[derive(Clone, Copy, Debug)]
pub struct Flag {
    pub name: &'static str,
    pub kind: FlagKind,
    pub usage: &'static str,
}

/// How the usage is printed.
#[derive(Clone, Copy, Debug)]
pub enum Usage {
    /// Go's default: `Usage of <argv0>:` and the flag list.
    Default,
    /// A fixed text (tsgolint's legacy `flag.Usage`).
    Text(&'static str),
}

/// The flag values after parsing.
#[derive(Debug, Default)]
pub struct Values {
    bools: FxHashMap<&'static str, bool>,
    strings: FxHashMap<&'static str, String>,
    /// The arguments after the flags.
    pub args: Vec<String>,
}

impl Values {
    pub fn bool(&self, name: &str) -> bool {
        self.bools.get(name).copied().unwrap_or(false)
    }

    pub fn string(&self, name: &str) -> &str {
        self.strings.get(name).map_or("", String::as_str)
    }
}

pub struct FlagSet {
    /// `os.Args[0]`, for the default usage.
    pub program: String,
    pub flags: Vec<Flag>,
    pub usage: Usage,
}

impl FlagSet {
    /// Go `FlagSet.Parse` with `ExitOnError`. `Err` is the exit code; the
    /// message and usage are already on `stderr`.
    pub fn parse(&self, arguments: &[String], stderr: &mut dyn Write) -> Result<Values, i32> {
        let mut values = Values::default();
        let mut rest = arguments;
        while let Some(arg) = rest.first() {
            let bytes = arg.as_bytes();
            if bytes.len() < 2 || bytes[0] != b'-' {
                break;
            }
            let mut minuses = 1;
            if bytes[1] == b'-' {
                minuses = 2;
                if bytes.len() == 2 {
                    // "--" ends the flags.
                    rest = &rest[1..];
                    break;
                }
            }
            let name = &arg[minuses..];
            if name.is_empty() || name.starts_with('-') || name.starts_with('=') {
                return Err(self.fail(stderr, &format!("bad flag syntax: {arg}")));
            }
            rest = &rest[1..];
            // The `=` cannot be the first character of the name.
            let (name, value) = match name.as_bytes()[1..].iter().position(|&b| b == b'=') {
                Some(i) => (&name[..=i], Some(&name[i + 2..])),
                None => (name, None),
            };
            let Some(flag) = self.flags.iter().find(|f| f.name == name) else {
                if name == "help" || name == "h" {
                    self.print_usage(stderr);
                    return Err(0);
                }
                return Err(self.fail(stderr, &format!("flag provided but not defined: -{name}")));
            };
            match flag.kind {
                FlagKind::Bool => {
                    let value = match value {
                        None => true,
                        Some(v) => match parse_bool(v) {
                            Some(b) => b,
                            None => {
                                return Err(self.fail(
                                    stderr,
                                    &format!(
                                        "invalid boolean value {} for -{name}: parse error",
                                        strconv::quote(v)
                                    ),
                                ));
                            }
                        },
                    };
                    values.bools.insert(flag.name, value);
                }
                FlagKind::String => {
                    let value = match value {
                        Some(v) => v.to_string(),
                        None => match rest.first() {
                            Some(next) => {
                                rest = &rest[1..];
                                next.clone()
                            }
                            None => {
                                return Err(
                                    self.fail(stderr, &format!("flag needs an argument: -{name}"))
                                );
                            }
                        },
                    };
                    values.strings.insert(flag.name, value);
                }
            }
        }
        values.args = rest.to_vec();
        Ok(values)
    }

    /// Go `failf`: the message, the usage, exit code 2.
    fn fail(&self, stderr: &mut dyn Write, message: &str) -> i32 {
        let _ = writeln!(stderr, "{message}");
        self.print_usage(stderr);
        2
    }

    pub fn print_usage(&self, stderr: &mut dyn Write) {
        match self.usage {
            Usage::Text(text) => {
                let _ = stderr.write_all(text.as_bytes());
            }
            Usage::Default => {
                let _ = writeln!(stderr, "Usage of {}:", self.program);
                self.print_defaults(stderr);
            }
        }
    }

    /// Go `PrintDefaults` for flags whose defaults are zero values.
    fn print_defaults(&self, stderr: &mut dyn Write) {
        let mut flags = self.flags.clone();
        flags.sort_by_key(|f| f.name);
        for flag in flags {
            let mut line = format!("  -{}", flag.name);
            if flag.kind == FlagKind::String {
                line.push_str(" string");
            }
            // One-letter bool flags keep their usage on the same line.
            if line.len() <= 4 {
                line.push('\t');
            } else {
                line.push_str("\n    \t");
            }
            line.push_str(&flag.usage.replace('\n', "\n    \t"));
            let _ = writeln!(stderr, "{line}");
        }
    }
}

/// Go `strconv.ParseBool`.
fn parse_bool(text: &str) -> Option<bool> {
    match text {
        "1" | "t" | "T" | "TRUE" | "true" | "True" => Some(true),
        "0" | "f" | "F" | "FALSE" | "false" | "False" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROGRAM: &str = "tsgolint";

    fn headless() -> FlagSet {
        FlagSet {
            program: PROGRAM.into(),
            flags: crate::headless::HEADLESS_FLAGS.to_vec(),
            usage: Usage::Default,
        }
    }

    fn parse(set: &FlagSet, args: &[&str]) -> (Result<Values, i32>, String) {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let mut stderr = Vec::new();
        let result = set.parse(&args, &mut stderr);
        (result, String::from_utf8(stderr).unwrap())
    }

    /// The usage that the Go binary prints for `headless -h`.
    const GO_USAGE: &str = "Usage of tsgolint:
  -allocs string
    \tfile to put allocs profiling to
  -cpuprof string
    \tfile to put cpu profiling to
  -debug string
    \tenable debug output options
  -fix
    \tgenerate fixes for code problems
  -fix-suggestions
    \tgenerate suggestions for code problems
  -heap string
    \tfile to put heap profiling to
  -trace string
    \tfile to put trace to
";

    #[test]
    fn values() {
        let set = headless();
        let (values, stderr) = parse(
            &set,
            &[
                "-fix",
                "--debug",
                "timings",
                "-trace=/t",
                "-fix-suggestions=0",
                "rest",
                "-x",
            ],
        );
        let values = values.unwrap();
        assert!(stderr.is_empty());
        assert!(values.bool("fix"));
        assert!(!values.bool("fix-suggestions"));
        assert_eq!(values.string("debug"), "timings");
        assert_eq!(values.string("trace"), "/t");
        assert_eq!(values.args, ["rest", "-x"]);

        // A bool flag does not take the next argument.
        let values = parse(&set, &["-fix", "true", "-x"]).0.unwrap();
        assert_eq!(values.args, ["true", "-x"]);
        // `--` and `-` end the flags.
        assert_eq!(parse(&set, &["--", "-x"]).0.unwrap().args, ["-x"]);
        assert_eq!(parse(&set, &["-", "-x"]).0.unwrap().args, ["-", "-x"]);
        // The last value wins; values may contain `=`.
        let values = parse(&set, &["-debug=a", "-debug=b=c", "-fix=T", "-fix=false"])
            .0
            .unwrap();
        assert_eq!(values.string("debug"), "b=c");
        assert!(!values.bool("fix"));
        // An empty value after `=` is a value.
        assert_eq!(parse(&set, &["-debug="]).0.unwrap().string("debug"), "");
    }

    // Each case below was run against the Go binary.
    #[test]
    fn go_errors() {
        let set = headless();
        let cases: &[(&[&str], i32, &str)] = &[
            (&["-x"], 2, "flag provided but not defined: -x\n"),
            (&["--x=1"], 2, "flag provided but not defined: -x\n"),
            (&["-debug"], 2, "flag needs an argument: -debug\n"),
            (
                &["-fix=maybe"],
                2,
                "invalid boolean value \"maybe\" for -fix: parse error\n",
            ),
            (&["---fix"], 2, "bad flag syntax: ---fix\n"),
            (&["-=x"], 2, "bad flag syntax: -=x\n"),
            (&["-h"], 0, ""),
            (&["--help"], 0, ""),
            (&["-help=false"], 0, ""),
        ];
        for (args, code, message) in cases {
            let (result, stderr) = parse(&set, args);
            assert_eq!(result.unwrap_err(), *code, "{args:?}");
            assert_eq!(stderr, format!("{message}{GO_USAGE}"), "{args:?}");
        }
    }

    #[test]
    fn legacy_usage_text_and_defined_help() {
        let set = FlagSet {
            program: "tsgolint".into(),
            flags: crate::legacy::LEGACY_FLAGS.to_vec(),
            usage: Usage::Text(crate::legacy::USAGE),
        };
        let (result, stderr) = parse(&set, &["-x"]);
        assert_eq!(result.unwrap_err(), 2);
        assert_eq!(
            stderr,
            format!(
                "flag provided but not defined: -x\n{}",
                crate::legacy::USAGE
            )
        );
        // `-h` is a defined bool flag in the legacy CLI.
        let values = parse(&set, &["-h"]).0.unwrap();
        assert!(values.bool("h"));
        assert!(!parse(&set, &["-help=false"]).0.unwrap().bool("help"));
    }

    #[test]
    fn one_letter_bool_usage_on_one_line() {
        let set = FlagSet {
            program: "p".into(),
            flags: vec![Flag {
                name: "v",
                kind: FlagKind::Bool,
                usage: "verbose",
            }],
            usage: Usage::Default,
        };
        let mut stderr = Vec::new();
        set.print_usage(&mut stderr);
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "Usage of p:\n  -v\tverbose\n"
        );
    }
}
