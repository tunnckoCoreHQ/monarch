//! `prefer-reduce-type-parameter`: prefers a type argument on
//! `Array#reduce` over an assertion on its initial value.

use goport_core::ast::is_access_expression;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage};

use crate::utils::{get_constrained_type_at_location, type_recurser};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-reduce-type-parameter",
    create,
};

fn prefer_type_parameter_message() -> RuleMessage {
    RuleMessage::new(
        "preferTypeParameter",
        "Unnecessary assertion: Array#reduce accepts a type parameter for the default value.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_call)
        .into()
}

fn check_call(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let arguments = node.arguments();
    if arguments.len() < 2 {
        return;
    }
    let second_arg = arguments.get(1);
    let is_as_expression = second_arg.kind() == SyntaxKind::AsExpression;
    if !is_as_expression && second_arg.kind() != SyntaxKind::TypeAssertionExpression {
        return;
    }
    let callee = node.expression();
    if !is_access_expression(callee) {
        return;
    }
    let (property_name, found) = ctx.checker.get_accessed_property_name(callee);
    if !found || property_name.as_str() != "reduce" {
        return;
    }

    let assertion_expression = second_arg.expression();
    let assertion_type = second_arg.type_();
    let initializer_type = ctx.checker.get_type_at_location(assertion_expression);
    let asserted_type = ctx.checker.get_type_at_location(assertion_type);
    // The fix would not type-check.
    if !ctx
        .checker
        .is_type_assignable_to(initializer_type, asserted_type)
    {
        return;
    }

    let object_type = get_constrained_type_at_location(ctx.checker, callee.expression());
    if type_recurser(ctx.checker, object_type, |checker, t| {
        !checker.is_array_or_tuple_type(t)
    }) {
        return;
    }

    let has_type_arguments = node.type_argument_list().is_some();
    ctx.report_node_with_fixes(second_arg, prefer_type_parameter_message(), |ctx| {
        let mut fixes = Vec::with_capacity(2);
        if is_as_expression {
            fixes.push(RuleFix::remove_range(
                assertion_type.loc().with_pos(assertion_expression.end()),
            ));
        } else {
            fixes.push(RuleFix::remove_range(
                second_arg.loc().with_end(assertion_expression.pos()),
            ));
        }
        if !has_type_arguments {
            // tsgolint copies the type's full text, leading trivia included.
            let type_text = ctx.range_text(assertion_type.loc());
            fixes.push(RuleFix::insert_after(callee, format!("<{type_text}>")));
        }
        fixes
    });
}
