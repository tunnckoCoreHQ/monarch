//! Prints the messages of a `tsgolint headless` output stream (stdin), one
//! per line: the type byte, a space, the JSON payload. With `--sort`, the
//! lines are sorted, which makes runs comparable (tsgolint's program order
//! is random).

use std::io::{Read, Write};

fn main() {
    let mut data = Vec::new();
    std::io::stdin().read_to_end(&mut data).expect("read stdin");
    let mut lines = Vec::new();
    let mut rest = &data[..];
    while rest.len() >= 5 {
        let len = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        let message_type = rest[4];
        let Some(payload) = rest.get(5..5 + len) else {
            break;
        };
        lines.push(format!(
            "{message_type} {}",
            String::from_utf8_lossy(payload)
        ));
        rest = &rest[5 + len..];
    }
    if !rest.is_empty() {
        lines.push(format!("<{} trailing bytes>", rest.len()));
    }
    if std::env::args().any(|a| a == "--sort") {
        lines.sort();
    }
    let mut out = std::io::stdout().lock();
    for line in lines {
        let _ = writeln!(out, "{line}");
    }
}
