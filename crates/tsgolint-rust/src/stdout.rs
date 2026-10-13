//! Standard output with Go's reaction to a reader that has gone.

use std::io::{self, Write};

/// The process's standard output. A write that fails with EPIPE ends the
/// process by SIGPIPE, as Go does for `os.Stdout` (`os/file_unix.go`
/// `epipecheck`): when oxlint exits early, tsgolint dies at its next write.
/// Rust ignores SIGPIPE, so the write returns the error and this raises the
/// signal with its default action. Without Unix signals (WASI, Windows), the
/// process exits with code 2.
pub struct Stdout;

impl Write for Stdout {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        exit_on_broken_pipe(io::stdout().write(buf))
    }

    fn flush(&mut self) -> io::Result<()> {
        exit_on_broken_pipe(io::stdout().flush())
    }
}

fn exit_on_broken_pipe<T>(result: io::Result<T>) -> io::Result<T> {
    if let Err(error) = &result
        && error.kind() == io::ErrorKind::BrokenPipe
    {
        #[cfg(unix)]
        let _ = signal_hook::low_level::emulate_default_handler(signal_hook::consts::SIGPIPE);
        // Go's `dieFromSignal` exits with code 2 when the signal did not end
        // the process (PID 1 in a container ignores it). WASI runtimes also
        // refuse exit codes from 126 up.
        std::process::exit(2);
    }
    result
}
