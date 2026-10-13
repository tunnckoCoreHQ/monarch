//! String helpers (tsgolint `string_literal.go`, `utils.go`).

use std::fmt::Write as _;

/// A single-quoted JavaScript string literal for `value`.
///
/// Escapes `\t \v \f \b \r \n \\ '` with short escapes, and U+2028, U+2029,
/// U+0085 and the other C0 controls as `\uXXXX` (uppercase hex).
pub fn quote_single_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        match ch {
            '\t' => out.push_str("\\t"),
            '\u{0B}' => out.push_str("\\v"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{08}' => out.push_str("\\b"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\u{2028}' | '\u{2029}' | '\u{85}' | '\0'..='\u{1F}' => {
                let _ = write!(out, "\\u{:04X}", ch as u32);
            }
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

/// ECMAScript `StrWhiteSpaceChar`: a line terminator or white space
/// (tab, vertical tab, form feed, BOM, or Unicode category Zs).
///
/// This differs from the scanner's `is_white_space_like`.
pub fn is_str_white_space(ch: char) -> bool {
    matches!(
        ch,
        // LineTerminator
        '\n' | '\r' | '\u{2028}' | '\u{2029}'
        // WhiteSpace
        | '\t' | '\u{0B}' | '\u{0C}' | '\u{FEFF}'
        // Zs
        | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// Whether every character of `s` is [`is_str_white_space`] (true for "").
pub fn is_string_white_space(s: &str) -> bool {
    s.chars().all(is_str_white_space)
}

/// Go `strconv.ParseFloat(s, 64)` for decimal input: underscores between
/// digits are allowed, and an out-of-range value is an error.
pub fn go_parse_float(s: &str) -> Option<f64> {
    let cleaned;
    let s = if s.contains('_') {
        if !go_underscore_ok(s) {
            return None;
        }
        cleaned = s.replace('_', "");
        cleaned.as_str()
    } else {
        s
    };
    let value: f64 = s.parse().ok()?;
    if value.is_infinite() {
        let unsigned = s.trim_start_matches(['+', '-']);
        if !unsigned
            .get(..3)
            .is_some_and(|p| p.eq_ignore_ascii_case("inf"))
        {
            return None;
        }
    }
    Some(value)
}

/// Go `strconv.underscoreOK`: each underscore sits between digits (a base
/// prefix counts as a digit).
fn go_underscore_ok(s: &str) -> bool {
    let s = s.strip_prefix(['+', '-']).unwrap_or(s).as_bytes();
    // b'^' start, b'0' digit or prefix, b'_' underscore, b'!' other.
    let mut saw = b'^';
    let mut i = 0;
    let mut hex = false;
    if s.len() >= 2 && s[0] == b'0' && matches!(s[1].to_ascii_lowercase(), b'b' | b'o' | b'x') {
        i = 2;
        saw = b'0';
        hex = s[1].eq_ignore_ascii_case(&b'x');
    }
    for &ch in &s[i..] {
        if ch.is_ascii_digit() || (hex && matches!(ch.to_ascii_lowercase(), b'a'..=b'f')) {
            saw = b'0';
            continue;
        }
        if ch == b'_' {
            if saw != b'0' {
                return false;
            }
            saw = b'_';
            continue;
        }
        if saw == b'_' {
            return false;
        }
        saw = b'!';
    }
    saw != b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_string_literals() {
        assert_eq!(quote_single_string_literal(""), "''");
        assert_eq!(quote_single_string_literal("abc"), "'abc'");
        assert_eq!(quote_single_string_literal("it's"), "'it\\'s'");
        assert_eq!(quote_single_string_literal("say \"hi\""), "'say \"hi\"'");
        assert_eq!(
            quote_single_string_literal("\t\u{0B}\u{0C}\u{08}\r\n\\"),
            "'\\t\\v\\f\\b\\r\\n\\\\'"
        );
        assert_eq!(
            quote_single_string_literal("\0\u{1}\u{1F}"),
            "'\\u0000\\u0001\\u001F'"
        );
        assert_eq!(
            quote_single_string_literal("\u{2028}\u{2029}\u{85}"),
            "'\\u2028\\u2029\\u0085'"
        );
        assert_eq!(quote_single_string_literal("\u{7F}é😀"), "'\u{7F}é😀'");
    }

    #[test]
    fn str_white_space() {
        for ch in [
            ' ', '\t', '\n', '\r', '\u{0B}', '\u{0C}', '\u{A0}', '\u{1680}', '\u{2000}',
            '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
        ] {
            assert!(is_str_white_space(ch), "{ch:?}");
        }
        for ch in ['a', '\u{85}', '\u{180E}', '\u{200B}', '\u{1C}', '\0'] {
            assert!(!is_str_white_space(ch), "{ch:?}");
        }
        assert!(is_string_white_space(""));
        assert!(is_string_white_space(" \u{3000}\n"));
        assert!(!is_string_white_space(" x "));
    }
}
