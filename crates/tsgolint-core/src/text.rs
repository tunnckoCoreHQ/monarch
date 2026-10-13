//! Text positions and slices: ECMA line starts, UTF-16 columns, the trimmed
//! range of a node and its text.

use std::borrow::Cow;

use goport_core::ast::{TextRange, source_file_text};
use goport_core::core::Node;
use goport_core::scanner_util;

/// The start offsets of the lines of `text`. Lines break at LF, CR, CRLF,
/// U+2028 and U+2029, as in ECMAScript (Go `core.ComputeECMALineStarts`).
pub fn ecma_line_starts(text: &str) -> Vec<i32> {
    scanner_util::compute_ecma_line_starts(text)
}

/// The 0-based line and UTF-16 column of byte offset `pos`, for the line
/// starts of `text` (Go `GetECMALineAndUTF16CharacterOfPosition`).
pub fn line_and_utf16_column(line_starts: &[i32], text: &str, pos: i32) -> (i32, i32) {
    scanner_util::ecma_line_and_utf16_character_of_text_position(line_starts, text, pos)
}

/// The range of `node` without its leading trivia: from the start of its
/// first token to its end (Go `utils.TrimNodeTextRange`). Node positions
/// include leading whitespace and comments.
pub fn trim_node_text_range(source_file: Node, node: Node) -> TextRange {
    scanner_util::get_range_of_token_at_position(source_file, node.pos()).with_end(node.end())
}

/// The range of the token that starts at or after `pos`, skipping trivia
/// (Go `scanner.GetRangeOfTokenAtPosition`).
pub fn token_range_at(source_file: Node, pos: i32) -> TextRange {
    scanner_util::get_range_of_token_at_position(source_file, pos)
}

/// Go `text[range.Pos():range.End()]` on ts-rust's port form of a Go
/// string, without panics. Go slices bytes: a bound inside a char keeps the
/// cut bytes, which stay invalid bytes here (`go_cut_slice`). A range
/// outside the text is clamped to it, where Go panics.
pub fn text_slice(text: &str, range: TextRange) -> Cow<'_, str> {
    let end = (range.end().max(0) as usize).min(text.len());
    let pos = (range.pos().max(0) as usize).min(end);
    scanner_util::go_cut_slice(text, pos, end)
}

/// The text of `range` in `source_file` (see [`text_slice`]).
pub fn range_text(source_file: Node, range: TextRange) -> String {
    text_slice(&source_file_text(source_file), range).into_owned()
}

/// The text of `node` without its leading trivia.
pub fn node_text(source_file: Node, node: Node) -> String {
    range_text(source_file, trim_node_text_range(source_file, node))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_starts_break_on_ecma_line_terminators() {
        assert_eq!(
            ecma_line_starts("a\nb\r\nc\rd\u{2028}e\u{2029}f"),
            [0, 2, 5, 7, 11, 15]
        );
    }

    #[test]
    fn columns_count_utf16_units() {
        let text = "x\n😀a";
        let starts = ecma_line_starts(text);
        // 😀 is 4 bytes and 2 UTF-16 units.
        assert_eq!(line_and_utf16_column(&starts, text, 6), (1, 2));
    }

    #[test]
    fn slices_cut_chars_as_go_does() {
        let text = "aé";
        let go_bytes = |range| scanner_util::go_string_bytes(&text_slice(text, range)).into_owned();
        assert_eq!(text_slice(text, TextRange::new(0, 3)), "aé");
        // A bound inside `é` (C3 A9) keeps the cut byte, as Go does.
        assert_eq!(go_bytes(TextRange::new(0, 2)), b"a\xC3");
        assert_eq!(go_bytes(TextRange::new(2, 3)), b"\xA9");
        // Out of range: clamped, where Go panics.
        assert_eq!(text_slice(text, TextRange::new(1, 9)), "é");
        assert_eq!(text_slice(text, TextRange::new(5, 2)), "");
    }
}
