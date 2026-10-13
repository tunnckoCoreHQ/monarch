//! `no-unnecessary-type-conversion`: flags conversions such as `String(s)`,
//! `s + ''`, `+n` or `!!b` whose operand already has the target type.

use goport_core::ast::{
    TextRange, is_arrow_function, is_expression_statement, is_identifier,
    is_object_literal_expression, is_prefix_unary_expression, is_property_access_expression,
    is_spread_element, is_string_literal,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, LiteralValue};
use goport_core::core::{Node, TypeId};
use goport_core::flags::{SymbolFlags, TypeFlags};
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::{
    get_constrained_type_at_location, is_builtin_symbol_like, is_parenthesized,
    is_strong_precedence_node, is_symbol_flag_set, is_type_flag_set, is_weak_precedence_parent,
    literal_type_value, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-type-conversion",
    create,
};

fn unnecessary_type_conversion_report(
    conversion: TextRange,
    expression: TextRange,
    expression_type: &str,
) -> Report {
    Report::new(
        conversion,
        RuleMessage::new(
            "unnecessaryTypeConversion",
            "This type conversion does not change the type or value of the expression.",
        ),
    )
    .with_label(
        format!("This expression already has type '{expression_type}'."),
        expression,
    )
}

fn suggest_remove_message() -> RuleMessage {
    RuleMessage::new("suggestRemove", "Remove the type conversion.")
}

fn suggest_satisfies_message() -> RuleMessage {
    RuleMessage::new(
        "suggestSatisfies",
        "Instead, assert that the value satisfies the primitive type.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::BinaryExpression, |_, ctx, node| {
            match node.operator_token().kind() {
                SyntaxKind::PlusToken => check_binary_plus(ctx, node),
                SyntaxKind::PlusEqualsToken => check_plus_equals(ctx, node),
                _ => {}
            }
        })
        .on(SyntaxKind::CallExpression, |_, ctx, node| {
            check_builtin_conversion_call(ctx, node);
            check_string_to_string_call(ctx, node);
        })
        .on(SyntaxKind::PrefixUnaryExpression, |_, ctx, node| {
            check_unary_plus(ctx, node);
            check_double_operator(ctx, node, SyntaxKind::ExclamationToken);
            check_double_operator(ctx, node, SyntaxKind::TildeToken);
        })
        .into()
}

/// Every union part of `t` has one of `flags`.
fn every_part_has_flag(c: &Checker, t: TypeId, flags: TypeFlags) -> bool {
    union_type_parts(c, t)
        .iter()
        .all(|&part| is_type_flag_set(c, part, flags))
}

fn is_empty_string_literal(node: Node) -> bool {
    is_string_literal(node) && node.text().is_empty()
}

/// Every union part of `t` is a number literal with an integer value.
fn is_all_number_literal_integers(c: &Checker, t: TypeId) -> bool {
    let parts = union_type_parts(c, t);
    !parts.is_empty()
        && parts.iter().all(|&part| {
            is_type_flag_set(c, part, TypeFlags::NUMBER_LITERAL)
                && matches!(
                    literal_type_value(c, part),
                    Some(LiteralValue::Number(n)) if n.0.trunc() == n.0
                )
        })
}

fn is_object_expression_in_one_line_return(node: Node, inner: Node) -> bool {
    is_arrow_function(node.parent())
        && node.parent().body() == node
        && is_object_literal_expression(inner)
}

/// Replaces `node` with `inner`, or with `inner satisfies <primitive>`.
fn wrapping_fix(
    ctx: &RuleContext<'_>,
    node: Node,
    inner: Node,
    satisfies: Option<&str>,
) -> RuleFix {
    let mut code = ctx.node_text(inner);
    if !is_strong_precedence_node(inner) || is_object_expression_in_one_line_return(node, inner) {
        code = format!("({code})");
    }
    let Some(primitive_type) = satisfies else {
        return ctx.fix_replace(node, code);
    };
    let mut code = format!("{code} satisfies {primitive_type}");
    if is_weak_precedence_parent(node) && !is_parenthesized(node) {
        code = format!("({code})");
    }
    ctx.fix_replace(node, code)
}

fn suggestions(
    ctx: &RuleContext<'_>,
    node: Node,
    primitive_type: &str,
    inner: Node,
) -> Vec<RuleSuggestion> {
    vec![
        RuleSuggestion {
            message: suggest_remove_message(),
            fixes: vec![wrapping_fix(ctx, node, inner, None)],
        },
        RuleSuggestion {
            message: suggest_satisfies_message(),
            fixes: vec![wrapping_fix(ctx, node, inner, Some(primitive_type))],
        },
    ]
}

/// Reports `conversion`, labels `inner` with its type, and suggests
/// replacing `node` with `inner`.
fn report(
    ctx: &mut RuleContext<'_>,
    conversion: TextRange,
    inner: Node,
    inner_type: TypeId,
    node: Node,
    primitive_type: &str,
) {
    let type_string = ctx.checker.type_to_string(inner_type);
    let report = unnecessary_type_conversion_report(
        conversion,
        ctx.trim_node_text_range(inner),
        &type_string,
    );
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        suggestions(ctx, node, primitive_type, inner)
    });
}

fn check_binary_plus(ctx: &mut RuleContext<'_>, node: Node) {
    let (left, right) = (node.left(), node.right());
    if is_empty_string_literal(right) {
        let left_type = get_constrained_type_at_location(ctx.checker, left);
        if every_part_has_flag(ctx.checker, left_type, TypeFlags::STRING_LIKE) {
            let conversion = TextRange::new(left.end(), node.end());
            report(ctx, conversion, left, left_type, node, "string");
        }
        return;
    }
    if is_empty_string_literal(left) {
        let right_type = get_constrained_type_at_location(ctx.checker, right);
        if every_part_has_flag(ctx.checker, right_type, TypeFlags::STRING_LIKE) {
            let conversion = TextRange::new(
                ctx.trim_node_text_range(node).pos(),
                ctx.trim_node_text_range(right).pos(),
            );
            report(ctx, conversion, right, right_type, node, "string");
        }
    }
}

fn check_plus_equals(ctx: &mut RuleContext<'_>, node: Node) {
    let left = node.left();
    if !is_empty_string_literal(node.right()) || !is_identifier(left) {
        return;
    }
    let left_type = get_constrained_type_at_location(ctx.checker, left);
    if !every_part_has_flag(ctx.checker, left_type, TypeFlags::STRING_LIKE) {
        return;
    }
    let type_string = ctx.checker.type_to_string(left_type);
    let report = unnecessary_type_conversion_report(
        ctx.trim_node_text_range(node),
        ctx.trim_node_text_range(left),
        &type_string,
    );
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        let remove_fix = if is_expression_statement(node.parent()) {
            ctx.fix_remove(node.parent())
        } else {
            wrapping_fix(ctx, node, left, None)
        };
        vec![
            RuleSuggestion {
                message: suggest_remove_message(),
                fixes: vec![remove_fix],
            },
            RuleSuggestion {
                message: suggest_satisfies_message(),
                fixes: vec![wrapping_fix(ctx, node, left, Some("string"))],
            },
        ]
    });
}

fn check_builtin_conversion_call(ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    let arguments = node.arguments();
    if !is_identifier(callee) || arguments.len() != 1 {
        return;
    }
    let argument = arguments.get(0);
    if is_spread_element(argument) {
        return;
    }
    let (type_flags, builtins, primitive_type): (TypeFlags, &[&str], &str) = match callee.text() {
        "BigInt" => (
            TypeFlags::BIG_INT_LIKE,
            &["BigInt", "BigIntConstructor"],
            "bigint",
        ),
        "Boolean" => (
            TypeFlags::BOOLEAN_LIKE,
            &["Boolean", "BooleanConstructor"],
            "boolean",
        ),
        "Number" => (
            TypeFlags::NUMBER_LIKE,
            &["Number", "NumberConstructor"],
            "number",
        ),
        "String" => (
            TypeFlags::STRING_LIKE,
            &["String", "StringConstructor"],
            "string",
        ),
        _ => return,
    };

    let callee_type = ctx.checker.get_type_at_location(callee);
    if !is_builtin_symbol_like(ctx.checker, callee_type, builtins) {
        return;
    }
    let argument_type = get_constrained_type_at_location(ctx.checker, argument);
    if !every_part_has_flag(ctx.checker, argument_type, type_flags) {
        return;
    }
    let conversion = ctx.trim_node_text_range(callee);
    report(
        ctx,
        conversion,
        argument,
        argument_type,
        node,
        primitive_type,
    );
}

fn check_string_to_string_call(ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    if !is_property_access_expression(callee) || !node.arguments().is_empty() {
        return;
    }
    let name = callee.name();
    if name.text() != "toString" {
        return;
    }
    let object = callee.expression();
    let object_type = get_constrained_type_at_location(ctx.checker, object);
    let symbol = ctx.checker.ty(object_type).symbol;
    if is_type_flag_set(ctx.checker, object_type, TypeFlags::ENUM_LIKE)
        || is_symbol_flag_set(ctx.checker, symbol, SymbolFlags::ENUM_MEMBER)
    {
        return;
    }
    if !every_part_has_flag(ctx.checker, object_type, TypeFlags::STRING_LIKE) {
        return;
    }
    // tsgolint starts the range at the name's `pos()`, with its leading
    // trivia.
    let conversion = TextRange::new(name.pos(), node.end());
    report(ctx, conversion, object, object_type, node, "string");
}

fn check_unary_plus(ctx: &mut RuleContext<'_>, node: Node) {
    if node.operator() != SyntaxKind::PlusToken {
        return;
    }
    let operand = node.operand();
    let operand_type = get_constrained_type_at_location(ctx.checker, operand);
    if !every_part_has_flag(ctx.checker, operand_type, TypeFlags::NUMBER_LIKE) {
        return;
    }
    let conversion = TextRange::new(
        ctx.trim_node_text_range(node).pos(),
        ctx.trim_node_text_range(operand).pos(),
    );
    report(ctx, conversion, operand, operand_type, node, "number");
}

/// `!!b` on a boolean, or `~~n` on integer number literals. `node` is the
/// inner operator.
fn check_double_operator(ctx: &mut RuleContext<'_>, node: Node, operator: SyntaxKind) {
    let outer = node.parent();
    if node.operator() != operator
        || !is_prefix_unary_expression(outer)
        || outer.operator() != operator
        || outer.operand() != node
    {
        return;
    }
    let operand = node.operand();
    let operand_type = get_constrained_type_at_location(ctx.checker, operand);
    let (matches, primitive_type) = if operator == SyntaxKind::ExclamationToken {
        (
            every_part_has_flag(ctx.checker, operand_type, TypeFlags::BOOLEAN_LIKE),
            "boolean",
        )
    } else {
        (
            is_all_number_literal_integers(ctx.checker, operand_type),
            "number",
        )
    };
    if !matches {
        return;
    }
    let conversion = TextRange::new(
        ctx.trim_node_text_range(outer).pos(),
        ctx.trim_node_text_range(node).pos() + 1,
    );
    report(
        ctx,
        conversion,
        operand,
        operand_type,
        outer,
        primitive_type,
    );
}
