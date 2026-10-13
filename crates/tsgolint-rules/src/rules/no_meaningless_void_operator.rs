//! `no-meaningless-void-operator`: disallows `void` on an expression that is
//! already `void` (or `never`, with `checkNever`).

use goport_core::ast::{is_assignment_expression, skip_outer_expressions};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::{OuterExpressionKinds, TypeFlags};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    decode_options,
};

use crate::utils::union_type_parts;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-meaningless-void-operator",
    create,
};

// The schema.json defaults are the `Default` impl. Missing and `null`
// properties take them.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    check_never: bool,
}

fn meaningless_void_operator_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "meaninglessVoidOperator",
        format!(
            "void operator shouldn't be used on {type_name}; \
             it should convey that a return value is being ignored"
        ),
    )
}

fn remove_void_message() -> RuleMessage {
    RuleMessage::new("removeVoid", "Remove 'void'")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::VoidExpression, check_void)
        .into()
}

fn check_void(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let argument = node.expression();
    let inner = skip_outer_expressions(
        argument,
        OuterExpressionKinds::OEK_PARENTHESES
            | OuterExpressionKinds::OEK_ASSERTIONS
            | OuterExpressionKinds::OEK_COMMA,
    );
    // `void (x = value)` explicitly discards the assignment result.
    if is_assignment_expression(inner, false) {
        return;
    }
    let argument_type = ctx.checker.get_type_at_location(argument);
    let parts = union_type_parts(ctx.checker, argument_type);
    let all_have = |flags: TypeFlags| {
        parts
            .iter()
            .all(|&t| ctx.checker.ty(t).flags.intersects(flags))
    };
    let always_void_like = all_have(TypeFlags::VOID_LIKE);
    let always_void_like_or_never = all_have(TypeFlags::VOID_LIKE | TypeFlags::NEVER);

    let remove_void = |ctx: &mut RuleContext<'_>| {
        RuleFix::remove_range(ctx.trim_node_text_range(node).with_end(argument.pos()))
    };
    if always_void_like {
        // Compute the message first: it needs `ctx.checker` mutably.
        let message = meaningless_void_operator_message(&ctx.checker.type_to_string(argument_type));
        ctx.report_node_with_fixes(node, message, |ctx| vec![remove_void(ctx)]);
    } else if options.check_never && always_void_like_or_never {
        let message = meaningless_void_operator_message(&ctx.checker.type_to_string(argument_type));
        ctx.report_node_with_suggestions(node, message, |ctx| {
            vec![RuleSuggestion {
                message: remove_void_message(),
                fixes: vec![remove_void(ctx)],
            }]
        });
    }
}
