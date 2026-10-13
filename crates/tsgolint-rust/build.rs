//! Link settings of the `tsgolint` binary for wasm targets. They live here,
//! not in a Cargo config, so every build of the binary gets them.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_FAMILY").as_deref() == Ok("wasm") {
        // The shadow stack in linear memory. WASI has no threads, so all
        // checking runs on the main stack, which defaults to 1 MiB on wasm.
        // The shadow stack holds only the locals whose address is taken;
        // the runtime's own wasm stack holds the call frames. Linting real
        // projects used at most 114 KiB of it. A type literal nested
        // 1000 deep needs 1.3 MiB, and more than 1 MiB of wasmtime's stack
        // (default 512 KiB), so the runtime's stack runs out first. The
        // stack is first in memory, so an overflow traps. All of it counts
        // toward linear memory from the start.
        println!("cargo:rustc-link-arg-bins=-zstack-size=4194304");
        // No name section (1.7 MB of the module): a trap's backtrace then
        // shows function indexes, not names.
        println!("cargo:rustc-link-arg-bins=--strip-all");
    }
}
