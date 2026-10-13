//! `no-unnecessary-template-expression`: reports template literals and
//! interpolations that can be written as plain strings or types.

use goport_core::ast::{
    TextRange, get_expression_precedence, is_binary_expression, is_boolean_literal, is_enum_member,
    is_expression, is_identifier, is_literal_expression, is_literal_type_node,
    is_string_literal_like, is_tagged_template_expression, is_template_expression,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use goport_core::jsnum;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
};

use crate::utils::{
    ConstraintInfo, get_constraint_info, has_comments_in_range, intersection_type_parts,
    is_string_white_space, is_type_flag_set, type_recurser, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-template-expression",
    create,
};

fn no_unnecessary_template_expression_message() -> RuleMessage {
    RuleMessage::new(
        "noUnnecessaryTemplateExpression",
        "Template literal expression is unnecessary and can be simplified.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::TemplateExpression, check_template_expression)
        .on(SyntaxKind::TemplateLiteralType, check_template_literal_type)
        .into()
}

/// The interpolated expression (or type) of a template span or template
/// literal type span.
fn span_expression(span: Node) -> Node {
    if span.kind() == SyntaxKind::TemplateSpan {
        span.expression()
    } else {
        span.type_()
    }
}

fn check_template_expression(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if is_tagged_template_expression(node.parent()) {
        return;
    }
    let first_span = node.template_spans().nodes().get(0);
    let expression = first_span.expression();
    if is_trivial_interpolation(ctx, node) {
        let t = ctx.checker.get_type_at_location(expression);
        if let Some(constraint) = get_constraint_info(ctx.checker, t).constraint()
            && constraint.is_some()
            && is_underlying_type_string(ctx.checker, constraint)
        {
            report_single_interpolation(ctx, node, expression, first_span.literal());
            return;
        }
    }
    check_template_spans(ctx, node);
}

fn check_template_literal_type(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let first_span = node.template_spans().nodes().get(0);
    let type_node = first_span.type_();
    if is_trivial_interpolation(ctx, node) {
        let t = ctx.checker.get_type_at_location(type_node);
        if let ConstraintInfo::Type(constraint) = get_constraint_info(ctx.checker, t)
            && constraint.is_some()
            && is_underlying_type_string(ctx.checker, constraint)
            && !is_enum_member_type(ctx.checker, constraint)
        {
            report_single_interpolation(ctx, node, type_node, first_span.literal());
            return;
        }
    }
    check_template_spans(ctx, node);
}

/// Every union member has a string-like intersection member.
fn is_underlying_type_string(checker: &Checker, t: TypeId) -> bool {
    union_type_parts(checker, t).into_iter().all(|part| {
        intersection_type_parts(checker, part)
            .into_iter()
            .any(|t| is_type_flag_set(checker, t, TypeFlags::STRING_LIKE))
    })
}

fn is_enum_member_type(checker: &mut Checker, t: TypeId) -> bool {
    type_recurser(checker, t, |checker, t| {
        let symbol = checker.ty(t).symbol;
        if symbol.is_nil() {
            return false;
        }
        let declaration = checker.sym(symbol).value_declaration;
        declaration.is_some() && is_enum_member(declaration)
    })
}

/// `${x}` alone, without text or comments around the interpolation.
fn is_trivial_interpolation(ctx: &RuleContext<'_>, template: Node) -> bool {
    let spans = template.template_spans().nodes();
    let head = template.head();
    let literal = spans.get(0).literal();
    spans.len() == 1
        && head.text().is_empty()
        && literal.text().is_empty()
        && !has_comments_in_range(ctx.source_file, TextRange::new(head.end(), literal.pos()))
        && !has_comments_in_range(
            ctx.source_file,
            TextRange::new(literal.pos(), ctx.trim_node_text_range(literal).pos()),
        )
}

/// Reports `${x}` and replaces the template with `x`.
fn report_single_interpolation(
    ctx: &mut RuleContext<'_>,
    template: Node,
    interpolation: Node,
    span_literal: Node,
) {
    let range = TextRange::new(interpolation.pos() - 2, span_literal.pos() + 1);
    let report = Report::new(range, no_unnecessary_template_expression_message());
    ctx.report_diagnostic_with_fixes(report, |ctx| {
        let mut text = ctx.node_text(interpolation);
        let parent = template.parent();
        let parent_is_nullish_coalescing = is_binary_expression(parent)
            && parent.operator_token().kind() == SyntaxKind::QuestionQuestionToken;
        let interpolation_is_logical = is_binary_expression(interpolation)
            && matches!(
                interpolation.operator_token().kind(),
                SyntaxKind::BarBarToken | SyntaxKind::AmpersandAmpersandToken
            );
        let needs_parentheses = (parent_is_nullish_coalescing && interpolation_is_logical)
            || (is_expression(parent)
                && get_expression_precedence(interpolation) <= get_expression_precedence(parent));
        if needs_parentheses {
            text = format!("({text})");
        }
        vec![ctx.fix_replace(template, text)]
    });
}

fn is_fixable_identifier(node: Node) -> bool {
    if is_identifier(node) {
        return matches!(node.text(), "undefined" | "Infinity" | "NaN");
    }
    node.kind() == SyntaxKind::UndefinedKeyword
}

fn is_any_literal(node: Node) -> bool {
    is_literal_expression(node)
        || is_boolean_literal(node)
        || node.kind() == SyntaxKind::NullKeyword
}

/// The literal of a literal type node, else `node`.
fn unwrap_literal_type(node: Node) -> Node {
    if is_literal_type_node(node) {
        node.literal()
    } else {
        node
    }
}

fn is_unnecessary_value_interpolation(
    ctx: &RuleContext<'_>,
    expression: Node,
    previous_quasi_end: i32,
    next_quasi: Node,
) -> bool {
    let sf = ctx.source_file;
    if has_comments_in_range(sf, TextRange::new(previous_quasi_end, next_quasi.pos()))
        || has_comments_in_range(
            sf,
            TextRange::new(next_quasi.pos(), ctx.trim_node_text_range(next_quasi).pos()),
        )
    {
        return false;
    }
    let expression = unwrap_literal_type(expression);
    if is_fixable_identifier(expression) {
        return true;
    }
    if is_string_literal_like(expression) {
        // Keep a whitespace-only string before a line break, as in
        // `${'    '}` at the end of a line.
        return !starts_with_newline(next_quasi.raw_text())
            || !is_string_white_space(expression.text());
    }
    is_any_literal(expression) || is_template_expression(expression)
}

fn starts_with_newline(text: &str) -> bool {
    text.starts_with('\n') || text.starts_with("\r\n")
}

fn ends_with_unescaped_dollar_sign(text: &str) -> bool {
    let Some(rest) = text.strip_suffix('$') else {
        return false;
    };
    rest.bytes().rev().take_while(|&b| b == b'\\').count() % 2 == 0
}

/// Escapes `` ` `` and `${` unless an odd number of backslashes already
/// escapes them.
fn escape_template_raw_text(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut escaped = Vec::with_capacity(bytes.len());
    for (i, &byte) in bytes.iter().enumerate() {
        let needs_escape = byte == b'`' || (byte == b'$' && bytes.get(i + 1) == Some(&b'{'));
        if needs_escape && bytes[..i].iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 0 {
            escaped.push(b'\\');
        }
        escaped.push(byte);
    }
    String::from_utf8(escaped).expect("only ASCII bytes were inserted")
}

/// The text of a literal inside a template.
fn literal_replacement_text(
    ctx: &RuleContext<'_>,
    literal: Node,
    next_character_is_opening_curly_brace: bool,
) -> String {
    let range = ctx.trim_node_text_range(literal);
    let mut text = match literal.kind() {
        // The text between the quotes, escapes kept.
        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
            ctx.range_text(TextRange::new(range.pos() + 1, range.end() - 1))
        }
        SyntaxKind::NumericLiteral => {
            jsnum::from_string(&literal.text().replace('_', "")).to_string()
        }
        SyntaxKind::BigIntLiteral => jsnum::parse_pseudo_big_int(&literal.text().replace('_', "")),
        SyntaxKind::RegularExpressionLiteral => literal.text().replace('\\', "\\\\"),
        _ => ctx.node_text(literal),
    };
    text = escape_template_raw_text(&text);
    if next_character_is_opening_curly_brace && ends_with_unescaped_dollar_sign(&text) {
        text.pop();
        text.push_str("\\$");
    }
    text
}

/// Checks the spans from last to first, tracking whether the text after
/// the current span starts with `{` (so that `$` before it needs escaping).
fn check_template_spans(ctx: &mut RuleContext<'_>, template: Node) {
    let spans = template.template_spans().nodes();
    let head = template.head();
    let mut next_character_is_opening_curly_brace = false;

    for i in (0..spans.len()).rev() {
        let span = spans.get(i);
        let previous_quasi_end = if i == 0 {
            head.end()
        } else {
            spans.get(i - 1).end()
        };
        let expression = span_expression(span);
        let literal = span.literal();
        if !is_unnecessary_value_interpolation(ctx, expression, previous_quasi_end, literal) {
            continue;
        }

        let raw = literal.raw_text();
        if !raw.is_empty() {
            next_character_is_opening_curly_brace = raw.starts_with('{');
        }

        let expression_range = ctx.trim_node_text_range(expression);
        let literal_start = ctx.trim_node_text_range(literal).pos();
        let mut fixes = vec![
            RuleFix::remove_range(TextRange::new(
                previous_quasi_end - 2,
                expression_range.pos(),
            )),
            RuleFix::remove_range(TextRange::new(expression_range.end(), literal_start + 1)),
        ];

        let inner = unwrap_literal_type(expression);
        if is_literal_expression(inner) {
            let replacement =
                literal_replacement_text(ctx, inner, next_character_is_opening_curly_brace);
            if !replacement.is_empty() {
                next_character_is_opening_curly_brace = replacement.starts_with('{');
            }
            fixes.push(ctx.fix_replace(inner, replacement));
        } else if is_template_expression(inner) {
            let inner_range = ctx.trim_node_text_range(inner);
            let inner_spans = inner.template_spans().nodes();
            let last_span = inner_spans.get(inner_spans.len() - 1);
            if next_character_is_opening_curly_brace
                && ends_with_unescaped_dollar_sign(last_span.literal().raw_text())
            {
                let at = inner_range.end() - 2;
                fixes.push(RuleFix::replace_range(TextRange::new(at, at), "\\"));
            }
            let inner_head = inner.head().raw_text();
            if !inner_head.is_empty() {
                next_character_is_opening_curly_brace = inner_head.starts_with('{');
            }
            fixes.push(RuleFix::remove_range(TextRange::new(
                inner_range.pos(),
                inner_range.pos() + 1,
            )));
            fixes.push(RuleFix::remove_range(TextRange::new(
                inner_range.end() - 1,
                inner_range.end(),
            )));
        } else {
            next_character_is_opening_curly_brace = false;
        }

        let previous_raw = if i == 0 {
            head.raw_text()
        } else {
            spans.get(i - 1).literal().raw_text()
        };
        if next_character_is_opening_curly_brace && ends_with_unescaped_dollar_sign(previous_raw) {
            fixes.push(RuleFix::replace_range(
                TextRange::new(previous_quasi_end - 3, previous_quasi_end - 2),
                "\\$",
            ));
        }

        let range = TextRange::new(previous_quasi_end - 2, literal_start + 1);
        let report = Report::new(range, no_unnecessary_template_expression_message());
        ctx.report_diagnostic_with_fixes(report, |_| fixes);
    }
}
