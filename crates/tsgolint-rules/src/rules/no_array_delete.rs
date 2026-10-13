//! `no-array-delete`: disallows `delete` on an element of an array.

use goport_core::ast::{is_element_access_expression, skip_parentheses};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::get_constrained_type_at_location;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-array-delete",
    create,
};

fn no_array_delete_message() -> RuleMessage {
    RuleMessage::new(
        "noArrayDelete",
        "Using the `delete` operator with an array expression is unsafe.",
    )
}

fn use_splice_message() -> RuleMessage {
    RuleMessage::new("useSplice", "Use `array.splice()` instead.")
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::DeleteExpression, check_delete)
        .into()
}

fn check_delete(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let delete_expression = skip_parentheses(node.expression());
    if !is_element_access_expression(delete_expression) {
        return;
    }
    let array = delete_expression.expression();
    let array_type = get_constrained_type_at_location(ctx.checker, array);
    if !is_underlying_type_array(ctx.checker, array_type) {
        return;
    }

    let delete_token_range = token_range_at(ctx.source_file, node.pos());
    let array_range = ctx.trim_node_text_range(array);
    let argument = delete_expression.argument_expression();
    let report = Report::new(delete_token_range, no_array_delete_message())
        .with_label("This expression evaluates to an array.", array_range);
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        let argument_range = ctx.trim_node_text_range(argument);
        let left_bracket = token_range_at(ctx.source_file, array_range.end());
        let right_bracket = token_range_at(ctx.source_file, argument_range.end());
        vec![RuleSuggestion {
            message: use_splice_message(),
            fixes: vec![
                RuleFix::remove_range(delete_token_range),
                RuleFix::replace_range(left_bracket, ".splice("),
                RuleFix::replace_range(right_bracket, ", 1)"),
            ],
        }]
    });
}

/// An array or tuple, a union of only those, or an intersection with one.
fn is_underlying_type_array(checker: &mut Checker, t: TypeId) -> bool {
    let flags = checker.ty(t).flags;
    if flags.intersects(TypeFlags::UNION) {
        let parts = checker.ty(t).types_list();
        return parts
            .iter()
            .all(|&part| checker.is_array_or_tuple_type(part));
    }
    if flags.intersects(TypeFlags::INTERSECTION) {
        let parts = checker.ty(t).types_list();
        return parts
            .iter()
            .any(|&part| checker.is_array_or_tuple_type(part));
    }
    checker.is_array_or_tuple_type(t)
}
