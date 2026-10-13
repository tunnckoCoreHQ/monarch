//! Report ranges and removal fixes of assertions.

use goport_core::ast::{
    TextRange, is_in_js_file, is_parenthesized_expression, is_type_assertion, source_file_text,
};
use goport_core::core::Node;
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use tsgolint_core::RuleFix;

use crate::utils::{
    get_comments_in_range, is_str_white_space, operand_needs_parentheses, trim_node_text_range,
};

/// The `/** @type {T} */` comment of a JSDoc cast, which typescript-go
/// represents as an assertion whose type comes before its expression.
fn js_doc_assertion_range(source_file: Node, node: Node) -> Option<TextRange> {
    let type_node = node.type_();
    if !is_in_js_file(node) || type_node.is_nil() || type_node.pos() >= node.expression().pos() {
        return None;
    }
    let search_start = if is_parenthesized_expression(node.parent()) {
        node.parent().pos()
    } else {
        node.pos()
    };
    let text = source_file_text(source_file);
    let before_expression = &text[search_start as usize..node.expression().pos() as usize];
    let start = before_expression.rfind("/**")?;
    let end = before_expression.rfind("*/")?;
    if end < start {
        return None;
    }
    Some(TextRange::new(
        search_start + start as i32,
        search_start + (end + "*/".len()) as i32,
    ))
}

/// The range to report: the JSDoc cast comment, or the assertion without
/// leading trivia.
pub(super) fn assertion_range(source_file: Node, node: Node) -> TextRange {
    js_doc_assertion_range(source_file, node)
        .unwrap_or_else(|| trim_node_text_range(source_file, node))
}

/// Removes the assertion and keeps the expression valid.
pub(super) fn assertion_fixes(source_file: Node, node: Node) -> Vec<RuleFix> {
    let text = source_file_text(source_file);
    if let Some(assertion) = js_doc_assertion_range(source_file, node) {
        let expression_pos = node.expression().pos();
        let bytes = text.as_bytes();
        let mut end = assertion.end();
        // tsgolint reads one byte at a time as a rune.
        while end < expression_pos && is_str_white_space(char::from(bytes[end as usize])) {
            end += 1;
        }
        return vec![RuleFix::remove_range(assertion.with_end(end))];
    }

    let type_node = node.type_();
    if is_type_assertion(node) {
        let mut s = get_scanner_for_source_file(source_file, &text, node.pos());
        let opening_angle_bracket = s.token_range();
        s.reset_pos(type_node.end());
        s.scan();
        let closing_angle_bracket = s.token_range();
        s.scan();
        let needs_parens = operand_needs_parentheses(source_file, node, &mut s);

        let mut fixes = Vec::new();
        if needs_parens {
            fixes.push(RuleFix::insert_before(source_file, node, "("));
        }
        fixes.push(RuleFix::remove_range(
            opening_angle_bracket.with_end(closing_angle_bracket.end()),
        ));
        if needs_parens {
            fixes.push(RuleFix::insert_after(node, ")"));
        }
        return fixes;
    }

    // Keep the token or comment before `as`.
    let expression = node.expression();
    let as_token = get_scanner_for_source_file(source_file, &text, expression.end()).token_range();
    let token_before_as_end = get_comments_in_range(
        source_file,
        TextRange::new(expression.end(), as_token.pos()),
    )
    .iter()
    .map(|comment| comment.end())
    .fold(expression.end(), i32::max);
    vec![RuleFix::remove_range(TextRange::new(
        token_before_as_end,
        node.end(),
    ))]
}
