//! Go's `log` package as tsgolint sets it up: lines on stderr, prefixed with
//! the local date and time in microseconds (`Ldate|Ltime|Lmicroseconds`).
//! `OXC_LOG=debug` turns on tsgolint's debug lines.

use std::io::Write;
use std::sync::OnceLock;

/// Go `utils.GetLogLevel()`: `OXC_LOG` is exactly `debug`.
pub fn debug_enabled() -> bool {
    static DEBUG: OnceLock<bool> = OnceLock::new();
    *DEBUG.get_or_init(|| std::env::var_os("OXC_LOG").is_some_and(|v| v == "debug"))
}

/// Go `log.Print`: one line on stderr.
pub fn print(message: &str) {
    let mut line = timestamp();
    line.push_str(message);
    if !line.ends_with('\n') {
        line.push('\n');
    }
    let _ = std::io::stderr().write_all(line.as_bytes());
}

/// A debug line, written only with `OXC_LOG=debug`.
pub fn debug(message: impl FnOnce() -> String) {
    if debug_enabled() {
        print(&message());
    }
}

/// `2026/10/13 08:06:01.123456 ` in Go's local time zone.
fn timestamp() -> String {
    let zone = goport_core::execute::tsc::diagnostics::local_location();
    let now = zone.to_datetime(jiff::Timestamp::now());
    format!(
        "{:04}/{:02}/{:02} {:02}:{:02}:{:02}.{:06} ",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.subsec_nanosecond() / 1000
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_shape() {
        let t = super::timestamp();
        assert_eq!(t.len(), "2026/10/13 08:06:01.123456 ".len());
        assert_eq!(&t[4..5], "/");
        assert_eq!(&t[19..20], ".");
    }
}
