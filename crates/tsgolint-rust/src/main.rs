use goport_util::frontend::vfs::go_string_from_os;

/// jemalloc is the global allocator of the native binary, as in ts-rust's
/// binaries (goport_core's `jemalloc` feature is on with it). wasm and
/// Windows use the default allocator.
#[cfg(all(not(target_family = "wasm"), not(windows)))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// ts-rust's jemalloc settings (`JEMALLOC_CONF` in ts-rust's
/// `bin/goport.rs`, which explains each one): 4 arenas, huge pages for the
/// data, no huge pages for the metadata, no random start offset for large
/// allocations.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const JEMALLOC_CONF: &str = "narenas:4,thp:always,metadata_thp:disabled,cache_oblivious:false";

fn main() {
    // First, before the first heap allocation, as in ts-rust's binaries.
    #[cfg(not(target_family = "wasm"))]
    goport_core::thp_guard::thp_guard();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    set_malloc_conf();
    #[cfg(target_os = "linux")]
    goport_core::jemalloc_layout::jemalloc_layout();
    // Go `os.Args`: the program name, then the arguments.
    let args: Vec<String> = std::env::args_os().map(go_string_from_os).collect();
    let code = tsgolint_rust::run_main(&args);
    tsgolint_rust::wasi::report_memory();
    std::process::exit(code);
}

/// jemalloc reads its settings only at start, so this runs the binary again
/// once with `_RJEM_MALLOC_CONF` set, as ts-rust's `set_malloc_tunables`
/// does. The exec costs about 2 ms; the settings cut peak RSS by 1% to 5%
/// (t3web-chat: 1603 MB to 1523 MB). A build with `JEMALLOC_CONF` built in
/// (the `JEMALLOC_SYS_WITH_MALLOC_CONF` environment variable at build time)
/// skips the exec; the repository sets no Cargo config for it. A
/// `_RJEM_MALLOC_CONF` of the caller wins. The run goes on without the
/// settings when the exec fails.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn set_malloc_conf() {
    use std::os::unix::process::CommandExt;
    const VAR: &str = "_RJEM_MALLOC_CONF";
    if option_env!("JEMALLOC_SYS_WITH_MALLOC_CONF") == Some(JEMALLOC_CONF)
        || std::env::var_os(VAR).is_some()
    {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut args = std::env::args_os();
    let mut command = std::process::Command::new(exe);
    if let Some(arg0) = args.next() {
        command.arg0(arg0);
    }
    // `exec` returns only when it fails.
    let _ = command.args(args).env(VAR, JEMALLOC_CONF).exec();
}
