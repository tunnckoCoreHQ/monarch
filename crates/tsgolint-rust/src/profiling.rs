//! `-trace`, `-cpuprof`, `-heap` and `-allocs` (Go `setupProfiling` in
//! `cmd/tsgolint/main.go`).
//!
//! tsgolint writes Go runtime traces and pprof profiles. A Rust binary has
//! no Go runtime to profile, so these flags create their files and leave
//! them empty. The files appear at the same moments as in tsgolint (trace
//! and CPU profile at start, heap and allocs profiles at exit), and an
//! unwritable trace or CPU profile path fails with tsgolint's message and
//! exit code. Profile the port with an external profiler (perf, samply).

use std::fs::File;

use goport_util::fswatch::syscall::io_error_text;

/// The open profile outputs of a run.
#[derive(Default)]
pub struct Profiling {
    heap: Option<String>,
    allocs: Option<String>,
}

impl Profiling {
    /// Go `setupProfiling` (headless): the error text is what follows
    /// `error starting profiling: `.
    pub fn start(
        trace: &str,
        cpuprof: &str,
        heap: &str,
        allocs: &str,
    ) -> Result<Profiling, String> {
        start_trace(trace).map_err(|e| format!("failed to start trace: {e}"))?;
        start_cpu_profile(cpuprof).map_err(|e| format!("failed to start cpu profile: {e}"))?;
        Ok(Profiling {
            heap: (!heap.is_empty()).then(|| heap.to_string()),
            allocs: (!allocs.is_empty()).then(|| allocs.to_string()),
        })
    }

    /// Go's deferred cleanup: writes the heap and allocs profiles. Errors
    /// are ignored, as in tsgolint.
    pub fn finish(self) {
        for path in [self.heap, self.allocs].into_iter().flatten() {
            let _ = create(&path);
        }
    }
}

/// Go `recordTrace`: the error text is what follows
/// `failed to start trace: ` (the legacy CLI prints it as it is).
pub fn start_trace(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    create(path)
        .map(drop)
        .map_err(|e| format!("error creating trace file: {e}"))
}

/// Go `recordCpuprof`.
pub fn start_cpu_profile(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    create(path)
        .map(drop)
        .map_err(|e| format!("error creating cpuprof file: {e}"))
}

/// Go `os.Create`: the error text is Go's `*PathError` text.
fn create(path: &str) -> Result<File, String> {
    File::create(path).map_err(|err| format!("open {path}: {}", io_error_text(&err)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The texts of the Go binary for `-trace` and `-cpuprof` in a missing
    // directory.
    #[test]
    fn go_error_texts() {
        assert_eq!(
            Profiling::start("/nonexistent/dir/t", "", "", "")
                .err()
                .unwrap(),
            "failed to start trace: error creating trace file: open /nonexistent/dir/t: no such file or directory"
        );
        assert_eq!(
            Profiling::start("", "/nonexistent/dir/t", "", "")
                .err()
                .unwrap(),
            "failed to start cpu profile: error creating cpuprof file: open /nonexistent/dir/t: no such file or directory"
        );
        // Heap and allocs paths only matter at exit, and their errors are
        // ignored.
        Profiling::start("", "", "/nonexistent/dir/h", "/nonexistent/dir/a")
            .unwrap()
            .finish();
    }

    #[test]
    fn creates_the_files() {
        let dir = std::env::temp_dir().join(format!("tsgolint-prof-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |name: &str| dir.join(name).to_str().unwrap().to_string();
        let profiling = Profiling::start(&p("trace"), &p("cpu"), &p("heap"), &p("allocs")).unwrap();
        assert!(dir.join("trace").exists() && dir.join("cpu").exists());
        assert!(!dir.join("heap").exists());
        profiling.finish();
        assert!(dir.join("heap").exists() && dir.join("allocs").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
