//! tsgolint-rust: the `tsgolint` command line, its `headless` protocol,
//! tsconfig discovery and the multi-program driver. It is a drop-in
//! replacement for tsgolint v7.0.2003: oxlint spawns `tsgolint headless`,
//! writes a JSON payload to stdin and reads framed diagnostics from stdout.
//! Program loading, the lint engine and the rules are tsgolint-core and
//! tsgolint-rules.

pub mod discovery;
pub mod driver;
pub mod flags;
pub mod headless;
pub mod json;
pub mod legacy;
pub mod log;
pub mod overrides;
pub mod panic;
pub mod payload;
pub mod profiling;
pub mod protocol;
pub mod rules;
pub mod stdout;
pub mod wasi;

/// Go `runMain`: `headless` as the first argument runs the headless
/// protocol; anything else is the legacy command line. `args` includes the
/// program name. Returns the exit code. A panic prints `panic: <message>`
/// and exits with code 2, as in Go.
pub fn run_main(args: &[String]) -> i32 {
    panic::install_hook();
    panic::exit_on_panic(|| {
        wasi::enter_pwd();
        let program = args.first().map_or("", String::as_str);
        let rest = args.get(1..).unwrap_or_default();
        if rest.first().is_some_and(|a| a == "headless") {
            return headless::run(
                program,
                &rest[1..],
                std::io::stdin(),
                stdout::Stdout,
                &mut std::io::stderr(),
            );
        }
        legacy::run(program, rest)
    })
}
