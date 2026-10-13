//! Go's panic behavior: a panic anywhere ends the process with exit code 2
//! and `panic: <message>` on stderr. Output that is still buffered is lost,
//! as in tsgolint.

use std::any::Any;
use std::io::Write;
use std::panic::{AssertUnwindSafe, PanicHookInfo};
use std::sync::Mutex;

/// The exit code of a Go panic.
pub const PANIC_EXIT_CODE: i32 = 2;

/// Where the last panic happened, for the report.
static LAST_PANIC: Mutex<Option<String>> = Mutex::new(None);

/// Replaces the default hook (which prints at every panic, also at those
/// that a library catches) with one that only remembers the location.
/// [`exit_on_panic`] prints the report; `run_main` and the loading thread
/// run inside it. When panics abort (WASI), nothing can catch them, so the
/// hook prints the report and exits with code 2 itself.
pub fn install_hook() {
    std::panic::set_hook(Box::new(|info: &PanicHookInfo<'_>| {
        let thread = std::thread::current();
        let mut text = format!("thread '{}' panicked", thread.name().unwrap_or("<unnamed>"));
        if let Some(location) = info.location() {
            text.push_str(&format!(" at {location}"));
        }
        let backtrace = std::backtrace::Backtrace::capture();
        if backtrace.status() == std::backtrace::BacktraceStatus::Captured {
            text.push_str(&format!("\n{backtrace}"));
        }
        if cfg!(panic = "abort") {
            exit_with_report(&panic_message(info.payload()), Some(text));
        }
        if let Ok(mut last) = LAST_PANIC.lock() {
            *last = Some(text);
        }
    }));
}

/// Runs `f`; a panic in it prints Go's panic report and exits with code 2.
pub fn exit_on_panic<T>(f: impl FnOnce() -> T) -> T {
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(payload) => {
            let location = LAST_PANIC.lock().ok().and_then(|mut last| last.take());
            exit_with_report(&panic_message(payload.as_ref()), location)
        }
    }
}

/// Prints `panic: <message>` and where it happened, and exits with code 2.
fn exit_with_report(message: &str, location: Option<String>) -> ! {
    let mut report = format!("panic: {message}\n");
    if let Some(location) = location {
        report.push('\n');
        report.push_str(&location);
        report.push('\n');
    }
    let _ = std::io::stderr().write_all(report.as_bytes());
    std::process::exit(PANIC_EXIT_CODE);
}

/// The text of a panic payload: a string, or ts-rust's Go panic value.
pub fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(p) = payload.downcast_ref::<goport_util::core::GoPanic>() {
        match p.go_type {
            Some(go_type) => format!("{go_type}({:?})", p.message),
            None => p.message.clone(),
        }
    } else {
        "<non-string panic value>".to_string()
    }
}
