//! tsgolint's rule snapshots (Go `internal/rule_tester/snapshot.go`): the
//! `.snap` file format and the text of one case.

use std::fmt::Write;

use tsgolint_core::text::{ecma_line_starts, line_and_utf16_column};
use tsgolint_core::{RuleDiagnostic, TextRange};

/// Parses a `.snap` file into its entries: key (`[Test/invalid-0 - 1]`) to
/// content.
pub fn parse_snapshot_file(data: &str) -> rustc_hash::FxHashMap<String, String> {
    let mut entries = rustc_hash::FxHashMap::default();
    for block in data.split("---\n") {
        let block = block.trim_start_matches('\n');
        if block.is_empty() {
            continue;
        }
        let Some((key, content)) = block.split_once('\n') else {
            continue;
        };
        if !key.starts_with('[') || !key.ends_with(']') {
            continue;
        }
        entries.insert(key.to_owned(), content.trim_end_matches('\n').to_owned());
    }
    entries
}

/// Lines and columns of `code` as the snapshot prints them.
struct Positions<'a> {
    code: &'a str,
    line_starts: Vec<i32>,
}

impl Positions<'_> {
    /// 0-based ECMA line and UTF-16 column.
    fn at(&self, pos: i32) -> (i32, i32) {
        line_and_utf16_column(&self.line_starts, self.code, pos)
    }

    /// `range.pos()` moved past spaces, tabs and line breaks (not comments).
    fn trimmed_start(&self, range: TextRange) -> i32 {
        let bytes = self.code.as_bytes();
        let mut start = range.pos();
        while start < range.end() && (start as usize) < bytes.len() {
            match bytes[start as usize] {
                b' ' | b'\t' | b'\n' | b'\r' => start += 1,
                _ => break,
            }
        }
        start
    }

    /// `(line:column - endLine:endColumn)`, 1-based, with an inclusive end.
    fn span(&self, range: TextRange) -> String {
        let start = self.trimmed_start(range);
        let (line, column) = self.at(start);
        let mut inclusive_end = range.end();
        if inclusive_end > start {
            inclusive_end -= 1;
        }
        let (end_line, end_column) = self.at(inclusive_end);
        format!(
            "({}:{} - {}:{})",
            line + 1,
            column + 1,
            end_line + 1,
            end_column + 1
        )
    }

    /// The code frame of `range` with one line of context and an underline
    /// of `marker` (Go `renderSourceAnnotation`).
    fn annotation(&self, range: TextRange, marker: u8, label: &str) -> String {
        let lines: Vec<&str> = self.code.split('\n').collect();
        let start = self.trimmed_start(range);
        let (start_line, start_column) = self.at(start);
        let (end_line, end_column) = self.at(range.end());
        let first = (start_line - 1).max(0);
        let last = (end_line + 1).min(lines.len() as i32 - 1);
        let gutter = (last + 1).to_string().len().max(2);

        let mut out = String::new();
        let mut line_index = first;
        while line_index <= last {
            let line = lines.get(line_index as usize).copied().unwrap_or("");
            let _ = writeln!(
                out,
                "  {:>gutter$} | {}",
                line_index + 1,
                line.replace('\t', "    ")
            );
            if line_index >= start_line && line_index <= end_line {
                let a_start = if line_index == start_line {
                    start_column
                } else {
                    0
                };
                let a_end = if line_index == end_line {
                    end_column
                } else {
                    line.len() as i32
                };
                let adjusted_start = adjust_for_tabs(line, a_start);
                let adjusted_end = adjust_for_tabs(line, a_end);
                if adjusted_end > adjusted_start {
                    let underline: String = (0..adjusted_end)
                        .map(|i| {
                            if i >= adjusted_start {
                                marker as char
                            } else {
                                ' '
                            }
                        })
                        .collect();
                    let underline = underline.trim_end_matches(' ');
                    if !underline.is_empty() {
                        let _ = write!(out, "  {:>gutter$} | {underline}", "");
                        if !label.is_empty() {
                            out.push(' ');
                            out.push_str(label);
                        }
                        out.push('\n');
                    }
                }
            }
            line_index += 1;
        }
        out
    }
}

/// A column with tabs counted as 4. It walks bytes up to the UTF-16 column,
/// mixing the two units as tsgolint does.
fn adjust_for_tabs(line: &str, column: i32) -> i32 {
    line.bytes()
        .take(column.max(0) as usize)
        .map(|b| if b == b'\t' { 4 } else { 1 })
        .sum()
}

/// The snapshot text of the first-pass diagnostics of `code` (Go
/// `formatDiagnosticsSnapshot`).
pub fn format_diagnostics_snapshot(code: &str, diagnostics: &[RuleDiagnostic]) -> String {
    if diagnostics.is_empty() {
        return "No diagnostics".to_owned();
    }
    let positions = Positions {
        code,
        line_starts: ecma_line_starts(code),
    };
    let mut out = String::new();
    for (i, d) in diagnostics.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let (pos, end) = (d.range.pos(), d.range.end());
        let has_range = pos != end || (pos != 0 && pos != -1);
        if has_range {
            let _ = writeln!(
                out,
                "Diagnostic {}: {} {}",
                i + 1,
                d.message.id,
                positions.span(d.range)
            );
            let _ = writeln!(out, "Message: {}", d.message.description);
            if !d.message.help.is_empty() {
                let _ = writeln!(out, "Help: {}", d.message.help);
            }
            out.push_str(&positions.annotation(d.range, b'~', ""));
        } else {
            let _ = writeln!(out, "Diagnostic {}: {}", i + 1, d.message.id);
            let _ = writeln!(out, "Message: {}", d.message.description);
        }
        for labeled in &d.labeled_ranges {
            let _ = writeln!(
                out,
                "  Label: {} {}",
                labeled.label,
                positions.span(labeled.range)
            );
            out.push_str(&positions.annotation(labeled.range, b'^', &labeled.label));
        }
        for (j, suggestion) in d.suggestions().iter().enumerate() {
            let _ = writeln!(
                out,
                "  Suggestion {}: [{}] {}",
                j + 1,
                suggestion.message.id,
                suggestion.message.description
            );
        }
    }
    out.trim_end_matches('\n').to_owned()
}
