//! `no-unsafe-unary-minus`: requires the operand of a unary `-` to be a
//! `number` or a `bigint`.

use goport_core::ast::{is_big_int_literal, is_numeric_literal, skip_parentheses};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::TypeFlags;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{get_constrained_type_at_location, is_type_flag_set, union_type_parts};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-unary-minus",
    create,
};

fn unary_minus_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unaryMinus",
        format!(
            "Argument of unary negation should be assignable to number | bigint but is {type_name} instead."
        ),
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::PrefixUnaryExpression, check_prefix_unary)
        .into()
}

fn check_prefix_unary(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if node.operator() != SyntaxKind::MinusToken {
        return;
    }
    let operand = node.operand();
    let inner = skip_parentheses(operand);
    if is_numeric_literal(inner) || is_big_int_literal(inner) {
        return;
    }

    let operand_type = get_constrained_type_at_location(ctx.checker, operand);
    let allowed =
        TypeFlags::ANY | TypeFlags::NEVER | TypeFlags::BIG_INT_LIKE | TypeFlags::NUMBER_LIKE;
    let unsafe_part = union_type_parts(ctx.checker, operand_type)
        .iter()
        .copied()
        .find(|&part| !is_type_flag_set(ctx.checker, part, allowed));
    if let Some(part) = unsafe_part {
        let message = unary_minus_message(&ctx.checker.type_to_string(part));
        ctx.report_node(node, message);
    }
}
