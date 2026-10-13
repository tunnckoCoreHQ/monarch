//! Byte-for-byte comparisons with output captured from the Go binary
//! (`tests/data/*.bin`, from `tsgolint headless` v7.0.2003). The tsconfig cases
//! ran on copies of the e2e fixtures in `/tmp/fixtures`.

use tsgolint_core::RuleTimingRecord;
use tsgolint_core::{
    FixFlags, InternalDiagnostic, LabeledRange, LintEvent, RuleDiagnostic, RuleFix, RuleMessage,
    RuleSuggestion, TextRange,
};
use tsgolint_rust::protocol::{DiagnosticWriter, MessageType, encode_timings, write_message};

fn golden(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn write(events: &[LintEvent], flags: FixFlags) -> Vec<u8> {
    let mut writer = DiagnosticWriter::new(Vec::new(), flags);
    for event in events {
        writer.write(event);
    }
    writer.into_inner()
}

fn message(id: &str, description: &str, help: &str) -> RuleMessage {
    RuleMessage {
        id: id.into(),
        description: description.into(),
        help: help.into(),
    }
}

/// `headless -fix -fix-suggestions` with `report_semantic` on a file whose
/// directory name holds every character class of the JSON escaping:
/// `<&>`, U+2028, control characters, DEL, short escapes, `"` and `é`.
#[test]
fn escaping_key_order_and_omission() {
    let file = "/tmp/esc/q<&>\u{2028}\u{1}\u{1f}\u{7f}\t\u{8}\u{c}\r\"\u{e9}/n/a.ts";
    let events = [
        LintEvent::Internal(InternalDiagnostic {
            range: Some(TextRange::new(6, 7)),
            id: "TS2322".into(),
            description: "Type 'string' is not assignable to type 'number'.".into(),
            help: String::new(),
            file_path: file.into(),
        }),
        LintEvent::Rule(RuleDiagnostic {
            rule: "no-floating-promises".into(),
            file_name: file.into(),
            range: TextRange::new(23, 44),
            message: message(
                "floatingVoid",
                "Promises must be awaited, add void operator to ignore.",
                "The promise must end with a call to .catch, or end with a call to .then with a rejection handler, or be explicitly marked as ignored with the `void` operator.",
            ),
            labeled_ranges: vec![LabeledRange {
                label: "This unhandled promise-like value has type `Promise<unknown>`.".into(),
                range: TextRange::new(23, 44),
            }],
            fixes: Some(vec![]),
            suggestions: Some(vec![
                RuleSuggestion {
                    message: message("floatingFixVoid", "Add void operator to ignore.", ""),
                    fixes: vec![RuleFix {
                        text: "void ".into(),
                        range: TextRange::new(23, 23),
                    }],
                },
                RuleSuggestion {
                    message: message("floatingFixAwait", "Add await operator.", ""),
                    fixes: vec![RuleFix {
                        text: "await ".into(),
                        range: TextRange::new(23, 23),
                    }],
                },
            ]),
        }),
    ];
    assert_eq!(
        write(
            &events,
            FixFlags {
                fix: true,
                fix_suggestions: true
            }
        ),
        golden("escape.bin")
    );
}

/// e2e fixture `with-invalid-tsconfig-json`: a tsconfig error with a range.
#[test]
fn tsconfig_error_with_range() {
    let events = [LintEvent::Internal(InternalDiagnostic {
        range: Some(TextRange::new(25, 25)),
        id: "tsconfig-error".into(),
        description: "Invalid tsconfig".into(),
        help: "Unterminated string literal.".into(),
        file_path: "/tmp/fixtures/with-invalid-tsconfig-json/tsconfig.json".into(),
    })];
    assert_eq!(
        write(&events, FixFlags::default()),
        golden("tsconfig-error-range.bin")
    );
}

/// e2e fixture `issue-oxc-2200` with `-debug timings`: a tsconfig error
/// without a range, then the timing message of a run that linted nothing.
#[test]
fn tsconfig_error_without_range_and_empty_timings() {
    let events = [LintEvent::Internal(InternalDiagnostic {
        range: None,
        id: "tsconfig-error".into(),
        description: "Invalid tsconfig".into(),
        help: "Cannot find type definition file for 'tsgolint-missing-type-package'.".into(),
        file_path: "/tmp/fixtures/issue-oxc-2200/tsconfig.json".into(),
    })];
    let mut out = write(&events, FixFlags::default());
    write_message(&mut out, MessageType::Timing, encode_timings(&[])).unwrap();
    assert_eq!(out, golden("no-range-and-timing.bin"));
}

#[test]
fn timing_payload() {
    let records = [
        RuleTimingRecord {
            rule_name: "no-floating-promises".into(),
            duration: 55175,
            calls: 2,
        },
        RuleTimingRecord {
            rule_name: "await-thenable".into(),
            duration: 7124,
            calls: 2,
        },
    ];
    assert_eq!(
        String::from_utf8(encode_timings(&records).unwrap()).unwrap(),
        r#"{"rules":[{"rule_name":"no-floating-promises","duration":55175,"calls":2},{"rule_name":"await-thenable","duration":7124,"calls":2}]}"#
    );
}
