//! `no-unsafe-member-access`: disallows member access on a value typed
//! `any`.

use goport_core::ast::{
    is_access_expression, is_heritage_clause, is_literal_expression, is_prefix_unary_expression,
    is_property_access_expression, is_source_file,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, TypeId};
use rustc_hash::FxHashMap;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    any_typed_this_expression, is_intrinsic_error_type, is_property_or_element_access,
    is_type_any_type,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-member-access",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_optional_chaining: bool,
}

fn unsafe_computed_member_access_message(property: &str, data_type: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeComputedMemberAccess",
        format!("Computed name {property} resolves to an {data_type} value."),
    )
}

fn unsafe_member_expression_message(property: &str, data_type: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeMemberExpression",
        format!("Unsafe member access {property} on an {data_type} value."),
    )
}

fn unsafe_this_member_expression_message(property: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeThisMemberExpression",
        format!("Unsafe member access {property} on an `any` value. `this` is typed as `any`."),
    )
    .with_help(
        "You can try to fix this by turning on the `noImplicitThis` compiler option, or adding a `this` parameter to the function.",
    )
}

struct State {
    allow_optional_chaining: bool,
    no_implicit_this: bool,
    /// Whether each checked access is unsafe: reported, or on an unsafe access.
    unsafe_accesses: FxHashMap<Node, bool>,
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let compiler_options = ctx.compiler_options();
    let no_implicit_this =
        compiler_options.get_strict_option_value(compiler_options.no_implicit_this);
    Listeners::new(State {
        allow_optional_chaining: options.allow_optional_chaining,
        no_implicit_this,
        unsafe_accesses: FxHashMap::default(),
    })
    .on(SyntaxKind::PropertyAccessExpression, |state, ctx, node| {
        check_member_expression(state, ctx, node);
    })
    .on(SyntaxKind::ElementAccessExpression, check_element_access)
    .into()
}

fn is_optional_chain(node: Node) -> bool {
    is_property_or_element_access(node) && node.question_dot_token().is_some()
}

fn data_type(ctx: &RuleContext<'_>, t: TypeId) -> &'static str {
    if is_intrinsic_error_type(ctx.checker, t) {
        "`error` typed"
    } else {
        "`any`"
    }
}

/// Reports a member access on an `any` value. Returns whether the access
/// is unsafe.
fn check_member_expression(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) -> bool {
    if state.allow_optional_chaining && is_optional_chain(node) {
        return false;
    }
    if let Some(&is_unsafe) = state.unsafe_accesses.get(&node) {
        return is_unsafe;
    }

    // Accesses inside `implements` and `extends` clauses are safe (not cached).
    let mut parent = node.parent();
    while !is_source_file(parent) {
        if is_heritage_clause(parent) {
            return false;
        }
        parent = parent.parent();
    }

    let expression = node.expression();
    if is_access_expression(expression) && check_member_expression(state, ctx, expression) {
        // The inner access is already reported.
        state.unsafe_accesses.insert(node, true);
        return true;
    }

    let t = ctx.checker.get_type_at_location(expression);
    if !is_type_any_type(ctx.checker, t) {
        state.unsafe_accesses.insert(node, false);
        return false;
    }
    state.unsafe_accesses.insert(node, true);

    let (property, property_name) = if is_property_access_expression(node) {
        let property = node.name();
        (property, format!(".{}", ctx.node_text(property)))
    } else {
        let property = node.argument_expression();
        (property, format!("[{}]", ctx.node_text(property)))
    };

    // `this.foo` or `this.foo[bar]`.
    if !state.no_implicit_this && any_typed_this_expression(ctx.checker, node).is_some() {
        ctx.report_node(
            property,
            unsafe_this_member_expression_message(&property_name),
        );
        return true;
    }

    let message = unsafe_member_expression_message(&property_name, data_type(ctx, t));
    ctx.report_node(property, message);
    true
}

fn check_element_access(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    check_member_expression(state, ctx, node);

    if state.allow_optional_chaining && is_optional_chain(node) {
        return;
    }

    let argument = node.argument_expression();
    // Literals are never `any`.
    if is_literal_expression(argument) {
        return;
    }
    // `x[i++]`, `x[--i]`: update expressions are always numbers.
    let is_unary = is_prefix_unary_expression(argument)
        || argument.kind() == SyntaxKind::PostfixUnaryExpression;
    if is_unary
        && matches!(
            argument.operator(),
            SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
        )
    {
        return;
    }

    let t = ctx.checker.get_type_at_location(argument);
    if is_type_any_type(ctx.checker, t) {
        let property_name = format!("[{}]", ctx.node_text(argument));
        let message = unsafe_computed_member_access_message(&property_name, data_type(ctx, t));
        ctx.report_node(argument, message);
    }
}
