//! A strict JSON reader with the acceptance rules of JSON v2 (jsontext).
//! Its error texts are jsontext's: the same wording, the JSON pointer of the
//! value and the byte offset (`jsontext: <what> within "<pointer>" after
//! offset <n>`). `tests/cli.rs` compares them with the Go binary.

use rustc_hash::FxHashSet;

use goport_core::gostd::strconv::{quote, quote_rune};

/// jsontext's default `MaxDepth`.
const MAX_DEPTH: usize = 10_000;

/// A parsed JSON value. Numbers keep their literal text; objects keep their
/// members in input order (names are unique).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The JSON kind as JSON v2 names it in its errors.
    pub fn kind_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
}

/// Parses one JSON value that fills the whole input (surrounding whitespace
/// allowed). The error is the full jsontext error text.
pub fn parse(input: &[u8]) -> Result<Value, String> {
    let mut parser = Parser {
        input,
        pos: 0,
        path: Vec::new(),
    };
    parser.skip_whitespace();
    let value = parser.value()?;
    parser.skip_whitespace();
    if let Some(&b) = input.get(parser.pos) {
        return Err(parser.error_at(
            &format!(
                "invalid character {} after top-level value",
                parser.char_text(b)
            ),
            parser.pos,
        ));
    }
    Ok(value)
}

enum Frame {
    Array(Vec<Value>),
    Object {
        members: Vec<(String, Value)>,
        names: FxHashSet<String>,
    },
}

enum Token {
    Name(String),
    Index(usize),
}

struct Parser<'a> {
    input: &'a [u8],
    pos: usize,
    /// The JSON pointer of the value being read.
    path: Vec<Token>,
}

impl Parser<'_> {
    fn skip_whitespace(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.input.get(self.pos) {
            self.pos += 1;
        }
    }

    fn pointer(&self) -> String {
        let mut out = String::new();
        for token in &self.path {
            out.push('/');
            match token {
                Token::Name(name) => out.push_str(&name.replace('~', "~0").replace('/', "~1")),
                Token::Index(i) => out.push_str(&i.to_string()),
            }
        }
        out
    }

    fn error_at(&self, what: &str, offset: usize) -> String {
        let mut text = format!("jsontext: {what}");
        let pointer = self.pointer();
        if !pointer.is_empty() {
            text.push_str(" within ");
            text.push_str(&quote(&pointer));
        }
        if offset > 0 {
            text.push_str(&format!(" after offset {offset}"));
        }
        text
    }

    fn eof(&self) -> String {
        self.error_at("unexpected EOF", self.input.len())
    }

    /// The character at a byte as jsontext quotes it.
    fn char_text(&self, b: u8) -> String {
        if b.is_ascii() {
            return quote_rune(b as char);
        }
        match std::str::from_utf8(&self.input[self.pos..])
            .ok()
            .or_else(|| {
                let end = (self.pos + 4).min(self.input.len());
                (self.pos + 1..=end)
                    .rev()
                    .find_map(|e| std::str::from_utf8(&self.input[self.pos..e]).ok())
            })
            .and_then(|s| s.chars().next())
        {
            Some(ch) => quote_rune(ch),
            None => quote_rune(char::REPLACEMENT_CHARACTER),
        }
    }

    /// Reads one value. Containers use an explicit stack, so deep input
    /// cannot overflow the thread stack.
    fn value(&mut self) -> Result<Value, String> {
        let mut stack: Vec<Frame> = Vec::new();
        'value: loop {
            self.skip_whitespace();
            let Some(&b) = self.input.get(self.pos) else {
                return Err(self.eof());
            };
            let mut done = match b {
                b'{' | b'[' => {
                    if stack.len() >= MAX_DEPTH {
                        return Err(self.error_at("exceeded max depth", self.pos));
                    }
                    self.pos += 1;
                    self.skip_whitespace();
                    let close = if b == b'{' { b'}' } else { b']' };
                    if self.input.get(self.pos) == Some(&close) {
                        self.pos += 1;
                        if b == b'{' {
                            Value::Object(Vec::new())
                        } else {
                            Value::Array(Vec::new())
                        }
                    } else if b == b'[' {
                        stack.push(Frame::Array(Vec::new()));
                        self.path.push(Token::Index(0));
                        continue 'value;
                    } else {
                        let mut names = FxHashSet::default();
                        self.member_name(&mut names)?;
                        stack.push(Frame::Object {
                            members: Vec::new(),
                            names,
                        });
                        continue 'value;
                    }
                }
                b'"' => Value::String(self.string()?),
                b'n' => self.literal("null", Value::Null)?,
                b't' => self.literal("true", Value::Bool(true))?,
                b'f' => self.literal("false", Value::Bool(false))?,
                b'-' | b'0'..=b'9' => self.number()?,
                _ => {
                    return Err(self.error_at(
                        &format!("invalid character {} at start of value", self.char_text(b)),
                        self.pos,
                    ));
                }
            };
            // A value is complete: add it to its container and close the
            // containers that end here.
            loop {
                let Some(frame) = stack.last_mut() else {
                    return Ok(done);
                };
                let token = self.path.pop();
                match (frame, token) {
                    (Frame::Array(elements), _) => elements.push(done),
                    (Frame::Object { members, .. }, Some(Token::Name(name))) => {
                        members.push((name, done))
                    }
                    (Frame::Object { .. }, _) => {
                        unreachable!("an object member always has a name token")
                    }
                }
                self.skip_whitespace();
                let is_array = matches!(stack.last(), Some(Frame::Array(_)));
                match self.input.get(self.pos) {
                    None => return Err(self.eof()),
                    Some(b',') => {
                        self.pos += 1;
                        match stack.last_mut() {
                            Some(Frame::Array(elements)) => {
                                let index = elements.len();
                                self.path.push(Token::Index(index));
                            }
                            Some(Frame::Object { names, .. }) => {
                                let mut names = std::mem::take(names);
                                let result = self.member_name(&mut names);
                                if let Some(Frame::Object { names: slot, .. }) = stack.last_mut() {
                                    *slot = names;
                                }
                                result?;
                            }
                            None => unreachable!(),
                        }
                        continue 'value;
                    }
                    Some(b']') if is_array => {
                        self.pos += 1;
                        let Some(Frame::Array(elements)) = stack.pop() else {
                            unreachable!()
                        };
                        done = Value::Array(elements);
                    }
                    Some(b'}') if !is_array => {
                        self.pos += 1;
                        let Some(Frame::Object { members, .. }) = stack.pop() else {
                            unreachable!()
                        };
                        done = Value::Object(members);
                    }
                    Some(&b) => {
                        let what = if is_array {
                            "after array element (expecting ',' or ']')"
                        } else {
                            "after object value (expecting ',' or '}')"
                        };
                        return Err(self.error_at(
                            &format!("invalid character {} {what}", self.char_text(b)),
                            self.pos,
                        ));
                    }
                }
            }
        }
    }

    /// Reads `"name":` of an object member and makes it the current pointer
    /// token.
    fn member_name(&mut self, names: &mut FxHashSet<String>) -> Result<(), String> {
        self.skip_whitespace();
        match self.input.get(self.pos) {
            None => return Err(self.eof()),
            Some(b'"') => {}
            Some(&b) => {
                return Err(self.error_at(
                    &format!(
                        "invalid character {} at start of string (expecting '\"')",
                        self.char_text(b)
                    ),
                    self.pos,
                ));
            }
        }
        let name = self.string()?;
        if !names.insert(name.clone()) {
            // jsontext names the member and its object, not the offset.
            let mut text = format!("jsontext: duplicate object member name {}", quote(&name));
            let pointer = self.pointer();
            if !pointer.is_empty() {
                text.push_str(" within ");
                text.push_str(&quote(&pointer));
            }
            return Err(text);
        }
        self.skip_whitespace();
        match self.input.get(self.pos) {
            None => return Err(self.eof()),
            Some(b':') => self.pos += 1,
            Some(&b) => {
                return Err(self.error_at(
                    &format!(
                        "invalid character {} after object name (expecting ':')",
                        self.char_text(b)
                    ),
                    self.pos,
                ));
            }
        }
        self.path.push(Token::Name(name));
        Ok(())
    }

    fn literal(&mut self, text: &'static str, value: Value) -> Result<Value, String> {
        for &expected in text.as_bytes() {
            match self.input.get(self.pos) {
                None => return Err(self.eof()),
                Some(&b) if b == expected => self.pos += 1,
                Some(&b) => {
                    return Err(self.error_at(
                        &format!(
                            "invalid character {} in literal {text} (expecting {})",
                            self.char_text(b),
                            quote_rune(expected as char)
                        ),
                        self.pos,
                    ));
                }
            }
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.input[self.pos] == b'-' {
            self.pos += 1;
        }
        match self.input.get(self.pos) {
            None => return Err(self.eof()),
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            Some(&b) => return Err(self.number_error(b)),
        }
        if self.input.get(self.pos) == Some(&b'.') {
            self.pos += 1;
            self.required_digits()?;
        }
        if let Some(b'e' | b'E') = self.input.get(self.pos) {
            self.pos += 1;
            if let Some(b'+' | b'-') = self.input.get(self.pos) {
                self.pos += 1;
            }
            self.required_digits()?;
        }
        // The input is ASCII here.
        let text = String::from_utf8_lossy(&self.input[start..self.pos]).into_owned();
        Ok(Value::Number(text))
    }

    fn digits(&mut self) {
        while let Some(b'0'..=b'9') = self.input.get(self.pos) {
            self.pos += 1;
        }
    }

    fn required_digits(&mut self) -> Result<(), String> {
        match self.input.get(self.pos) {
            None => Err(self.eof()),
            Some(b'0'..=b'9') => {
                self.digits();
                Ok(())
            }
            Some(&b) => Err(self.number_error(b)),
        }
    }

    fn number_error(&self, b: u8) -> String {
        self.error_at(
            &format!(
                "invalid character {} in number (expecting digit)",
                self.char_text(b)
            ),
            self.pos,
        )
    }

    fn string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.input[self.pos], b'"');
        self.pos += 1;
        let mut out = String::new();
        loop {
            let run_start = self.pos;
            while let Some(&b) = self.input.get(self.pos) {
                if b == b'"' || b == b'\\' || !(0x20..0x80).contains(&b) {
                    break;
                }
                self.pos += 1;
            }
            // ASCII only, so this cannot fail.
            out.push_str(std::str::from_utf8(&self.input[run_start..self.pos]).unwrap_or_default());
            let Some(&b) = self.input.get(self.pos) else {
                return Err(self.eof());
            };
            match b {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => self.escape(&mut out)?,
                0..0x20 => {
                    return Err(self.error_at(
                        &format!(
                            "invalid character {} in string (expecting non-control character)",
                            quote_rune(b as char)
                        ),
                        self.pos,
                    ));
                }
                _ => {
                    let width = utf8_width(b);
                    let end = self.pos + width;
                    match self
                        .input
                        .get(self.pos..end)
                        .and_then(|s| std::str::from_utf8(s).ok())
                    {
                        Some(s) if width > 0 => {
                            out.push_str(s);
                            self.pos = end;
                        }
                        _ if end > self.input.len() && width > 0 && self.is_utf8_prefix(width) => {
                            return Err(self.eof());
                        }
                        _ => return Err(self.error_at("invalid UTF-8", self.pos)),
                    }
                }
            }
        }
    }

    /// Whether the rest of the input is a valid start of a `width`-byte
    /// UTF-8 sequence (truncated input rather than invalid input).
    fn is_utf8_prefix(&self, width: usize) -> bool {
        let rest = &self.input[self.pos..];
        rest.len() < width && rest[1..].iter().all(|&b| (0x80..0xc0).contains(&b))
    }

    fn escape(&mut self, out: &mut String) -> Result<(), String> {
        let start = self.pos;
        let Some(&b) = self.input.get(self.pos + 1) else {
            return Err(self.eof());
        };
        self.pos += 2;
        let ch = match b {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\x08',
            b'f' => '\x0c',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let first = self.hex4(start)?;
                if (0xd800..0xdc00).contains(&first) {
                    // A high surrogate must be followed by an escaped low surrogate.
                    let low = if self.input.get(self.pos) == Some(&b'\\')
                        && self.input.get(self.pos + 1) == Some(&b'u')
                    {
                        self.pos += 2;
                        Some(self.hex4(start)?)
                    } else {
                        None
                    };
                    match low {
                        Some(low) if (0xdc00..0xe000).contains(&low) => {
                            char::from_u32(0x10000 + ((first - 0xd800) << 10) + (low - 0xdc00))
                                .unwrap_or(char::REPLACEMENT_CHARACTER)
                        }
                        _ => return Err(self.surrogate_error(start)),
                    }
                } else if (0xdc00..0xe000).contains(&first) {
                    return Err(self.surrogate_error(start));
                } else {
                    char::from_u32(first).unwrap_or(char::REPLACEMENT_CHARACTER)
                }
            }
            _ => {
                let end = (start + 2).min(self.input.len());
                let text = String::from_utf8_lossy(&self.input[start..end]).into_owned();
                return Err(self.error_at(
                    &format!("invalid escape sequence `{text}` in string"),
                    start,
                ));
            }
        };
        out.push(ch);
        Ok(())
    }

    fn hex4(&mut self, escape_start: usize) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let Some(&b) = self.input.get(self.pos) else {
                return Err(self.eof());
            };
            let digit = match b {
                b'0'..=b'9' => b - b'0',
                b'a'..=b'f' => b - b'a' + 10,
                b'A'..=b'F' => b - b'A' + 10,
                _ => {
                    let end = (self.pos + 1).min(self.input.len());
                    let text = String::from_utf8_lossy(&self.input[escape_start..end]).into_owned();
                    return Err(self.error_at(
                        &format!("invalid escape sequence `{text}` in string"),
                        escape_start,
                    ));
                }
            };
            value = value * 16 + u32::from(digit);
            self.pos += 1;
        }
        Ok(value)
    }

    fn surrogate_error(&self, start: usize) -> String {
        let end = self.pos.min(self.input.len());
        let text = String::from_utf8_lossy(&self.input[start..end]).into_owned();
        self.error_at(&format!("invalid surrogate pair `{text}` in string"), start)
    }
}

/// The length of the UTF-8 sequence that starts with `b` (0 if `b` cannot
/// start one).
fn utf8_width(b: u8) -> usize {
    match b {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(input: &str) -> String {
        parse(input.as_bytes()).unwrap_err()
    }

    #[test]
    fn values() {
        let v = parse(br#" {"a":[1,-2.5e+3,true,false,null,"x\u00e9\uD83D\uDE00\n"],"b":{}} "#)
            .unwrap();
        assert_eq!(
            v,
            Value::Object(vec![
                (
                    "a".into(),
                    Value::Array(vec![
                        Value::Number("1".into()),
                        Value::Number("-2.5e+3".into()),
                        Value::Bool(true),
                        Value::Bool(false),
                        Value::Null,
                        Value::String("x\u{e9}\u{1F600}\n".into()),
                    ])
                ),
                ("b".into(), Value::Object(vec![])),
            ])
        );
    }

    // Texts captured from the Go binary (`error parsing config: ` stripped).
    #[test]
    fn go_error_texts() {
        assert_eq!(err(""), "jsontext: unexpected EOF");
        assert_eq!(err("{"), "jsontext: unexpected EOF after offset 1");
        assert_eq!(
            err(r#"{"version":2,"version":2}"#),
            r#"jsontext: duplicate object member name "version""#
        );
        assert_eq!(
            err(
                r#"{"version":2,"configs":[{"file_paths":[],"rules":[{"name":"a","options":{"x":1,"x":2}}]}]}"#
            ),
            r#"jsontext: duplicate object member name "x" within "/configs/0/rules/0/options""#
        );
        assert_eq!(
            err(r#"{"version":2,"extra":{"a":1,"a":2}}"#),
            r#"jsontext: duplicate object member name "a" within "/extra""#
        );
        assert_eq!(
            err(r#"{"version":2} x"#),
            "jsontext: invalid character 'x' after top-level value after offset 14"
        );
        assert_eq!(
            err(r#"{"version":2}{}"#),
            "jsontext: invalid character '{' after top-level value after offset 13"
        );
        assert_eq!(
            err("{\"version\":2,\"x\":\"\t\"}"),
            r#"jsontext: invalid character '\t' in string (expecting non-control character) within "/x" after offset 18"#
        );
        assert_eq!(
            err(r#"{"version":2,"x":01}"#),
            "jsontext: invalid character '1' after object value (expecting ',' or '}') after offset 18"
        );
    }

    #[test]
    fn rejects() {
        assert!(err(r#"{"x":"\ud800"}"#).starts_with("jsontext: invalid surrogate pair"));
        assert!(err(r#"{"x":"\udc00"}"#).starts_with("jsontext: invalid surrogate pair"));
        assert!(err(r#"{"x":"\ud800\u0041"}"#).starts_with("jsontext: invalid surrogate pair"));
        assert!(err(r#"{"x":"\q"}"#).starts_with("jsontext: invalid escape sequence"));
        assert!(err("[1,]").starts_with("jsontext: invalid character ']' at start of value"));
        assert!(err("[01]").starts_with("jsontext: invalid character '1' after array element"));
        assert!(err("[1.]").contains("in number"));
        assert!(err("[-]").contains("in number"));
        assert!(err("nul").starts_with("jsontext: unexpected EOF"));
        assert!(err("nulx").contains("in literal null"));
        assert!(err("{1:2}").contains("at start of string"));
        assert!(err(r#"{"a" 1}"#).contains("after object name"));
        assert!(
            parse(b"{\"x\":\"\xff\"}")
                .unwrap_err()
                .starts_with("jsontext: invalid UTF-8 within \"/x\"")
        );
        assert!(
            parse(b"{\"x\":\"\xc3\x28\"}")
                .unwrap_err()
                .starts_with("jsontext: invalid UTF-8")
        );
        // Overlong encodings and encoded surrogates are invalid UTF-8.
        assert!(
            parse(b"\"\xc0\xaf\"")
                .unwrap_err()
                .contains("invalid UTF-8")
        );
        assert!(
            parse(b"\"\xed\xa0\x80\"")
                .unwrap_err()
                .contains("invalid UTF-8")
        );
        assert_eq!(
            parse(b"\"\xe2\x82").unwrap_err(),
            "jsontext: unexpected EOF after offset 3"
        );
    }

    #[test]
    fn depth_limit() {
        let deep = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
        assert!(parse(deep.as_bytes()).is_ok());
        let too_deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
        assert!(
            parse(too_deep.as_bytes())
                .unwrap_err()
                .contains("exceeded max depth")
        );
    }
}
