//! The output of `tsgolint headless` (Go `cmd/tsgolint/headless.go`).
//!
//! Each message is a little-endian u32 payload length, a type byte and a
//! compact JSON payload. The payload structs below have the field order and
//! the omission rules of tsgolint's Go structs. serde_json escapes strings
//! as JSON v2 does by default: `"` and `\`, short escapes for
//! `\b \f \n \r \t`, `\u00xx` with lowercase hex for the other control
//! characters. `<`, `>`, `&`, U+2028, U+2029, DEL and other non-ASCII text
//! stay as they are.

use std::io::{self, BufWriter, Write};

use goport_util::scanner_util::go_string_bytes;
use serde::{Serialize, Serializer};
use tsgolint_core::{FixFlags, LintEvent, RuleFix, RuleMessage, RuleTimingRecord, TextRange};

/// The message type byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageType {
    Error = 0,
    Diagnostic = 1,
    Timing = 2,
}

/// A string was not valid UTF-8 (JSON v2 refuses to marshal it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidUtf8;

/// A ts-rust "port form" string: it holds Go bytes that are not UTF-8 as
/// escapes (see `goport_util::scanner_util::GO_STRING_MARKER`). Those make
/// it fail to serialize, as they make Go's `json.Marshal` fail.
struct GoString<'a>(&'a str);

impl GoString<'_> {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Serialize for GoString<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let bytes = go_string_bytes(self.0);
        let text =
            std::str::from_utf8(&bytes).map_err(|_| serde::ser::Error::custom("invalid UTF-8"))?;
        serializer.serialize_str(text)
    }
}

#[derive(Serialize)]
struct Range {
    pos: i32,
    end: i32,
}

impl Range {
    /// Go `headlessRangeFromRange`: nothing for an invalid range.
    fn of(range: TextRange) -> Option<Range> {
        range.is_valid().then(|| Range {
            pos: range.pos(),
            end: range.end(),
        })
    }

    /// A range that tsgolint dereferences without a check.
    fn required(range: TextRange) -> Range {
        Range::of(range).expect("runtime error: invalid memory address or nil pointer dereference")
    }
}

#[derive(Serialize)]
struct Message<'a> {
    id: GoString<'a>,
    description: GoString<'a>,
    #[serde(skip_serializing_if = "GoString::is_empty")]
    help: GoString<'a>,
}

impl<'a> Message<'a> {
    fn new(message: &'a RuleMessage) -> Self {
        Message {
            id: GoString(&message.id),
            description: GoString(&message.description),
            help: GoString(&message.help),
        }
    }
}

#[derive(Serialize)]
struct LabeledRange<'a> {
    label: GoString<'a>,
    range: Range,
}

#[derive(Serialize)]
struct Fix<'a> {
    text: GoString<'a>,
    range: Range,
}

fn fixes(fixes: &[RuleFix]) -> Vec<Fix<'_>> {
    fixes
        .iter()
        .map(|fix| Fix {
            text: GoString(&fix.text),
            range: Range::required(fix.range),
        })
        .collect()
}

/// A suggestion always has `fixes`, `[]` when empty.
#[derive(Serialize)]
struct Suggestion<'a> {
    message: Message<'a>,
    fixes: Vec<Fix<'a>>,
}

/// Go `headlessDiagnostic`. Kind 0 is a rule diagnostic, kind 1 a tsconfig
/// error or a TypeScript diagnostic.
#[derive(Serialize)]
struct Diagnostic<'a> {
    kind: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<Range>,
    message: Message<'a>,
    file_path: GoString<'a>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    labeled_ranges: Vec<LabeledRange<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rule: Option<GoString<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fixes: Vec<Fix<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    suggestions: Vec<Suggestion<'a>>,
}

impl<'a> Diagnostic<'a> {
    /// Fixes and suggestions only with their flags; labeled ranges always.
    fn new(event: &'a LintEvent, flags: FixFlags) -> Self {
        match event {
            LintEvent::Rule(d) => Diagnostic {
                kind: 0,
                range: Range::of(d.range),
                message: Message::new(&d.message),
                file_path: GoString(&d.file_name),
                labeled_ranges: d
                    .labeled_ranges
                    .iter()
                    .map(|labeled| LabeledRange {
                        label: GoString(&labeled.label),
                        range: Range::required(labeled.range),
                    })
                    .collect(),
                rule: Some(GoString(&d.rule)),
                fixes: if flags.fix {
                    fixes(d.fixes())
                } else {
                    Vec::new()
                },
                suggestions: if flags.fix_suggestions {
                    d.suggestions()
                        .iter()
                        .map(|suggestion| Suggestion {
                            message: Message::new(&suggestion.message),
                            fixes: fixes(&suggestion.fixes),
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            },
            LintEvent::Internal(d) => Diagnostic {
                kind: 1,
                range: d.range.and_then(Range::of),
                message: Message {
                    id: GoString(&d.id),
                    description: GoString(&d.description),
                    help: GoString(&d.help),
                },
                file_path: GoString(&d.file_path),
                labeled_ranges: Vec::new(),
                rule: None,
                fixes: Vec::new(),
                suggestions: Vec::new(),
            },
        }
    }
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    error: GoString<'a>,
}

#[derive(Serialize)]
struct TimingPayload<'a> {
    rules: Vec<RuleTiming<'a>>,
}

#[derive(Serialize)]
struct RuleTiming<'a> {
    rule_name: GoString<'a>,
    duration: u64,
    calls: u64,
}

fn to_json(value: &impl Serialize) -> Result<Vec<u8>, InvalidUtf8> {
    serde_json::to_vec(value).map_err(|_| InvalidUtf8)
}

/// `{"error":"<text>"}`.
pub fn encode_error(text: &str) -> Result<Vec<u8>, InvalidUtf8> {
    to_json(&ErrorPayload {
        error: GoString(text),
    })
}

/// `{"rules":[{"rule_name":..,"duration":..,"calls":..},...]}`.
pub fn encode_timings(records: &[RuleTimingRecord]) -> Result<Vec<u8>, InvalidUtf8> {
    let rules = records
        .iter()
        .map(|record| RuleTiming {
            rule_name: GoString(&record.rule_name),
            duration: record.duration,
            calls: record.calls,
        })
        .collect();
    to_json(&TimingPayload { rules })
}

/// The JSON of one diagnostic. `Err` when a string is not valid UTF-8:
/// tsgolint then drops the diagnostic.
///
/// # Panics
///
/// When a labeled range or a fix range is invalid: tsgolint dereferences a
/// nil range there.
pub fn encode_diagnostic(event: &LintEvent, flags: FixFlags) -> Result<Vec<u8>, InvalidUtf8> {
    to_json(&Diagnostic::new(event, flags))
}

/// Writes one framed message.
pub fn write_frame(
    out: &mut impl Write,
    message_type: MessageType,
    payload: &[u8],
) -> io::Result<()> {
    let len = u32::try_from(payload.len()).expect("a message payload fits in 4 GiB");
    let mut header = [0; 5];
    header[..4].copy_from_slice(&len.to_le_bytes());
    header[4] = message_type as u8;
    out.write_all(&header)?;
    out.write_all(payload)
}

/// tsgolint's output buffer: 400 KB, flushed when less than 4 KB is free.
const BUFFER_SIZE: usize = 4096 * 100;
const FLUSH_BELOW: usize = 4096;

/// Writes diagnostics through tsgolint's output buffer. Write errors are
/// ignored, as in tsgolint.
pub struct DiagnosticWriter<W: Write> {
    out: BufWriter<W>,
    flags: FixFlags,
}

impl<W: Write> DiagnosticWriter<W> {
    pub fn new(out: W, flags: FixFlags) -> Self {
        Self {
            out: BufWriter::with_capacity(BUFFER_SIZE, out),
            flags,
        }
    }

    /// Writes one diagnostic, or drops it when it cannot be encoded.
    pub fn write(&mut self, event: &LintEvent) {
        let Ok(payload) = encode_diagnostic(event, self.flags) else {
            return;
        };
        let _ = write_frame(&mut self.out, MessageType::Diagnostic, &payload);
        if self.out.capacity() - self.out.buffer().len() < FLUSH_BELOW {
            let _ = self.out.flush();
        }
    }

    /// Flushes the buffer and gives back the output.
    pub fn into_inner(mut self) -> W {
        let _ = self.out.flush();
        self.out
            .into_inner()
            .unwrap_or_else(|error| error.into_inner().into_parts().0)
    }
}

/// Writes one message straight to `out` (tsgolint's `writeMessage` on
/// `os.Stdout`). A payload that cannot be encoded writes nothing.
pub fn write_message(
    out: &mut impl Write,
    message_type: MessageType,
    payload: Result<Vec<u8>, InvalidUtf8>,
) -> Result<(), InvalidUtf8> {
    let payload = payload?;
    let _ = write_frame(out, message_type, &payload);
    let _ = out.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tsgolint_core::{LabeledRange, RuleDiagnostic, RuleSuggestion};

    fn rule_diagnostic() -> RuleDiagnostic {
        RuleDiagnostic {
            rule: "no-floating-promises".into(),
            file_name: "/p/a.ts".into(),
            range: TextRange::new(23, 44),
            message: RuleMessage {
                id: "floatingVoid".into(),
                description: "D".into(),
                help: "H".into(),
            },
            labeled_ranges: vec![LabeledRange {
                label: "L".into(),
                range: TextRange::new(23, 44),
            }],
            fixes: Some(vec![RuleFix {
                text: "x".into(),
                range: TextRange::new(0, 0),
            }]),
            suggestions: Some(vec![
                RuleSuggestion {
                    message: RuleMessage {
                        id: "s1".into(),
                        description: "S1".into(),
                        help: String::new(),
                    },
                    fixes: vec![RuleFix {
                        text: "void ".into(),
                        range: TextRange::new(23, 23),
                    }],
                },
                RuleSuggestion {
                    message: RuleMessage {
                        id: "s2".into(),
                        description: "S2".into(),
                        help: String::new(),
                    },
                    fixes: vec![],
                },
            ]),
        }
    }

    fn json(event: &LintEvent, fix: bool, fix_suggestions: bool) -> String {
        String::from_utf8(
            encode_diagnostic(
                event,
                FixFlags {
                    fix,
                    fix_suggestions,
                },
            )
            .unwrap(),
        )
        .unwrap()
    }

    /// The JSON string of `text`, as `encode_error` writes it.
    fn quote(text: &str) -> Result<String, InvalidUtf8> {
        let json = String::from_utf8(encode_error(text)?).unwrap();
        Ok(json[r#"{"error":"#.len()..json.len() - 1].to_string())
    }

    #[test]
    fn rule_key_order_and_omission() {
        let event = LintEvent::Rule(rule_diagnostic());
        assert_eq!(
            json(&event, true, true),
            r#"{"kind":0,"range":{"pos":23,"end":44},"message":{"id":"floatingVoid","description":"D","help":"H"},"file_path":"/p/a.ts","labeled_ranges":[{"label":"L","range":{"pos":23,"end":44}}],"rule":"no-floating-promises","fixes":[{"text":"x","range":{"pos":0,"end":0}}],"suggestions":[{"message":{"id":"s1","description":"S1"},"fixes":[{"text":"void ","range":{"pos":23,"end":23}}]},{"message":{"id":"s2","description":"S2"},"fixes":[]}]}"#
        );
        // Without the flags there are no fixes or suggestions; labeled
        // ranges stay.
        assert_eq!(
            json(&event, false, false),
            r#"{"kind":0,"range":{"pos":23,"end":44},"message":{"id":"floatingVoid","description":"D","help":"H"},"file_path":"/p/a.ts","labeled_ranges":[{"label":"L","range":{"pos":23,"end":44}}],"rule":"no-floating-promises"}"#
        );
        // Empty lists are omitted even with the flags; a 0,0 range stays.
        let mut d = rule_diagnostic();
        d.range = TextRange::new(0, 0);
        d.message.help.clear();
        d.labeled_ranges.clear();
        d.fixes = Some(vec![]);
        d.suggestions = None;
        assert_eq!(
            json(&LintEvent::Rule(d.clone()), true, true),
            r#"{"kind":0,"range":{"pos":0,"end":0},"message":{"id":"floatingVoid","description":"D"},"file_path":"/p/a.ts","rule":"no-floating-promises"}"#
        );
        // An invalid range (both ends negative) is omitted; one valid end
        // keeps it.
        d.range = TextRange::new(-1, -1);
        assert!(!json(&LintEvent::Rule(d.clone()), false, false).contains("range"));
        d.range = TextRange::new(-1, 3);
        assert!(json(&LintEvent::Rule(d), false, false).contains(r#""range":{"pos":-1,"end":3}"#));
    }

    #[test]
    #[should_panic(expected = "nil pointer dereference")]
    fn invalid_labeled_range_panics() {
        let mut d = rule_diagnostic();
        d.labeled_ranges[0].range = TextRange::undefined();
        let _ = encode_diagnostic(&LintEvent::Rule(d), FixFlags::default());
    }

    #[test]
    fn escaping() {
        assert_eq!(quote("plain").unwrap(), r#""plain""#);
        assert_eq!(quote("a\"b\\c").unwrap(), r#""a\"b\\c""#);
        assert_eq!(quote("\x08\x0c\n\r\t").unwrap(), r#""\b\f\n\r\t""#);
        assert_eq!(
            quote("\x00\x01\x1f\x0b").unwrap(),
            r#""\u0000\u0001\u001f\u000b""#
        );
        assert_eq!(
            quote("<&>\u{2028}\u{2029}\x7f/é😀").unwrap(),
            "\"<&>\u{2028}\u{2029}\x7f/é😀\""
        );
    }

    #[test]
    fn port_form() {
        use goport_util::scanner_util::{go_string_from_bytes, go_string_from_utf8};
        // A real U+FDD0 survives the port form.
        assert_eq!(
            quote(&go_string_from_utf8("\u{fdd0}".into())).unwrap(),
            "\"\u{fdd0}\""
        );
        // A Go byte that is not UTF-8 makes the string invalid.
        assert_eq!(
            quote(&go_string_from_bytes(b"a\xffb".to_vec())),
            Err(InvalidUtf8)
        );
    }

    #[test]
    fn invalid_utf8_drops_the_diagnostic() {
        let mut d = rule_diagnostic();
        d.message.description =
            goport_util::scanner_util::go_string_from_bytes(b"bad \xff".to_vec());
        let mut w = DiagnosticWriter::new(Vec::new(), FixFlags::default());
        w.write(&LintEvent::Rule(d));
        w.write(&LintEvent::Rule(rule_diagnostic()));
        let out = w.into_inner();
        assert_eq!(out[4], 1);
        assert_eq!(
            u32::from_le_bytes(out[..4].try_into().unwrap()) as usize,
            out.len() - 5
        );
    }

    #[test]
    fn framing() {
        let mut out = Vec::new();
        write_frame(&mut out, MessageType::Timing, b"{}").unwrap();
        assert_eq!(out, b"\x02\x00\x00\x00\x02{}");
        assert_eq!(encode_error("e\"x").unwrap(), br#"{"error":"e\"x"}"#);
        assert_eq!(encode_timings(&[]).unwrap(), br#"{"rules":[]}"#);
    }

    #[test]
    fn large_messages_stream_in_order() {
        let mut d = rule_diagnostic();
        d.message.description = "x".repeat(BUFFER_SIZE + 10);
        let event = LintEvent::Rule(d);
        let mut w = DiagnosticWriter::new(Vec::new(), FixFlags::default());
        for _ in 0..3 {
            w.write(&LintEvent::Rule(rule_diagnostic()));
            w.write(&event);
        }
        let out = w.into_inner();
        let mut expected = Vec::new();
        for _ in 0..3 {
            for event in [&LintEvent::Rule(rule_diagnostic()), &event] {
                write_frame(
                    &mut expected,
                    MessageType::Diagnostic,
                    &encode_diagnostic(event, FixFlags::default()).unwrap(),
                )
                .unwrap();
            }
        }
        assert_eq!(out, expected);
    }
}
