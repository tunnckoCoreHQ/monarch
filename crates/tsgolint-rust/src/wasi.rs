//! The current directory under WASI.
//!
//! A WASI program starts in `/` of its preopened directories: WASI has no
//! process working directory, and wasi-libc emulates one that starts at
//! `/`. tsgolint resolves relative paths and runs the inferred program in
//! the current directory, so under WASI the binary takes it from `PWD`,
//! which the host passes with `--env PWD=<dir>`. The directory must be
//! preopened under the same path (`--dir <dir>::<dir>`). Without `PWD`, or
//! when it is not an absolute directory the guest can enter, the current
//! directory stays `/`.

/// Enters `PWD` under WASI; elsewhere does nothing.
pub fn enter_pwd() {
    #[cfg(target_os = "wasi")]
    if let Some(pwd) =
        std::env::var_os("PWD").filter(|pwd| pwd.as_encoded_bytes().first() == Some(&b'/'))
    {
        let _ = std::env::set_current_dir(pwd);
    }
}

/// With `TSGOLINT_WASM_MEMORY` set, prints the size of the wasm linear
/// memory to stderr. Memory only grows, so at exit this is the peak. Not on
/// native builds.
pub fn report_memory() {
    #[cfg(target_family = "wasm")]
    if std::env::var_os("TSGOLINT_WASM_MEMORY").is_some() {
        // 64 KiB pages; a full 4 GiB memory overflows a 32-bit usize.
        let bytes = core::arch::wasm32::memory_size::<0>() as u64 * 65536;
        eprintln!("wasm memory: {bytes} bytes ({} MiB)", bytes >> 20);
    }
}
