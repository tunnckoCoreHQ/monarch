//! Fix application (Go `linter.ApplyRuleFixes`). The rule tester applies the
//! fixes of all diagnostics, and each suggestion on its own.

use goport_util::gostd::slices::sort_func;

use crate::diagnostic::{RuleDiagnostic, RuleFix, RuleSuggestion};

/// A Go comparator result for two keys: negative, zero or positive.
fn compare_keys<K: Ord>(a: K, b: K) -> i32 {
    a.cmp(&b) as i32
}

/// A message that carries fixes.
pub trait HasFixes {
    fn fix_list(&self) -> &[RuleFix];
    fn fix_list_mut(&mut self) -> &mut [RuleFix];
}

impl HasFixes for RuleDiagnostic {
    fn fix_list(&self) -> &[RuleFix] {
        self.fixes.as_deref().unwrap_or_default()
    }
    fn fix_list_mut(&mut self) -> &mut [RuleFix] {
        self.fixes.as_deref_mut().unwrap_or_default()
    }
}

impl HasFixes for RuleSuggestion {
    fn fix_list(&self) -> &[RuleFix] {
        &self.fixes
    }
    fn fix_list_mut(&mut self) -> &mut [RuleFix] {
        &mut self.fixes
    }
}

/// The result of `apply_rule_fixes`.
pub struct FixResult<M> {
    pub output: String,
    /// The messages with no fixes and the ones skipped for an overlap.
    pub unapplied: Vec<M>,
    /// True when at least one fix was applied.
    pub fixed: bool,
}

/// Applies the fixes of `messages` to `code`. Each message's fixes are sorted
/// by range; messages are sorted by their first fix start and last fix end. A
/// message whose first fix starts before the end of the last applied fix is
/// skipped; touching ranges apply.
pub fn apply_rule_fixes<M: HasFixes>(code: &str, messages: Vec<M>) -> FixResult<M> {
    let mut unapplied = Vec::new();
    let mut with_fixes = Vec::new();
    for mut message in messages {
        let fixes = message.fix_list_mut();
        if fixes.is_empty() {
            unapplied.push(message);
        } else {
            sort_func(fixes, |a, b| {
                compare_keys(
                    (a.range.pos(), a.range.end()),
                    (b.range.pos(), b.range.end()),
                )
            });
            with_fixes.push(message);
        }
    }
    // tsgolint sorts with Go's unstable `slices.SortFunc`; `sort_func` puts ties in the same order.
    sort_func(&mut with_fixes, |a, b| {
        let (a, b) = (a.fix_list(), b.fix_list());
        compare_keys(
            (a[0].range.pos(), a[a.len() - 1].range.end()),
            (b[0].range.pos(), b[b.len() - 1].range.end()),
        )
    });

    // Byte slices, as Go slices the string: a range inside a char is legal.
    let code = code.as_bytes();
    let mut output = Vec::with_capacity(code.len());
    let mut last_fix_end = 0usize;
    let mut fixed = false;
    for mut message in with_fixes {
        let fixes = message.fix_list_mut();
        if last_fix_end > fixes[0].range.pos() as usize {
            unapplied.push(message);
            continue;
        }
        for fix in fixes.iter() {
            fixed = true;
            output.extend_from_slice(&code[last_fix_end..fix.range.pos() as usize]);
            output.extend_from_slice(fix.text.as_bytes());
            last_fix_end = fix.range.end() as usize;
        }
    }
    output.extend_from_slice(&code[last_fix_end..]);
    let output = String::from_utf8(output)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    FixResult {
        output,
        unapplied,
        fixed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::{RuleMessage, TextRange};

    fn fix(pos: i32, end: i32, text: &str) -> RuleFix {
        RuleFix {
            text: text.into(),
            range: TextRange::new(pos, end),
        }
    }

    fn suggestion(fixes: Vec<RuleFix>) -> RuleSuggestion {
        RuleSuggestion {
            message: RuleMessage::new("x", "x"),
            fixes,
        }
    }

    #[test]
    fn applies_sorted_and_skips_overlaps() {
        let result = apply_rule_fixes(
            "abcdef",
            vec![
                suggestion(vec![fix(4, 5, "E")]),
                suggestion(vec![fix(2, 3, "C"), fix(0, 1, "A")]),
                suggestion(vec![fix(0, 2, "zz")]),
                suggestion(vec![]),
            ],
        );
        assert_eq!(result.output, "zzcdEf");
        assert!(result.fixed);
        assert_eq!(result.unapplied.len(), 2);
    }

    #[test]
    fn touching_fixes_apply() {
        let result = apply_rule_fixes(
            "abc",
            vec![
                suggestion(vec![fix(0, 1, "x")]),
                suggestion(vec![fix(1, 2, "y")]),
            ],
        );
        assert_eq!(result.output, "xyc");
    }
}
