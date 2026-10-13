//! `prefer-promise-reject-errors`: requires `Promise.reject(x)` and the
//! `reject(x)` of a `new Promise` executor to reject with an `Error`.

use goport_core::ast::{
    is_access_expression, is_arrow_function, is_function_expression, is_identifier,
    is_new_expression, is_parameter_declaration, skip_parentheses,
    walk_up_parenthesized_expressions,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, is_error_like, is_promise_constructor_like, is_promise_like,
    is_readonly_error_like, is_type_any_type, is_type_unknown_type, type_matches_some_specifier,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-promise-reject-errors",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
    allow_empty_reject: bool,
    allow_throwing_any: bool,
    allow_throwing_unknown: bool,
}

fn reject_an_error_message() -> RuleMessage {
    RuleMessage::new(
        "rejectAnError",
        "Expected the Promise rejection reason to be an Error.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::CallExpression, check_call)
        .into()
}

fn check_call(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let callee = skip_parentheses(node.expression());
    if is_access_expression(callee) {
        // `Promise.reject(...)`
        let (method_name, _) = ctx.checker.get_accessed_property_name(callee);
        if method_name.as_str() == "reject" && is_promise_like_at(ctx, callee.expression()) {
            check_reject_call(options, ctx, node);
        }
    } else if is_identifier(callee) && is_executor_reject(ctx, callee) {
        // `reject(...)` in `new Promise((resolve, reject) => ...)`
        check_reject_call(options, ctx, node);
    }
}

/// `callee` is the second parameter of a function or arrow function that is
/// passed to `new` on a `PromiseConstructor`.
fn is_executor_reject(ctx: &mut RuleContext<'_>, callee: Node) -> bool {
    let symbol = ctx.checker.get_symbol_at_location_exported(callee);
    if symbol.is_nil() {
        return false;
    }
    let param = ctx.checker.sym(symbol).value_declaration;
    if param.is_nil() || !is_parameter_declaration(param) {
        return false;
    }
    let function = param.parent();
    if !is_function_expression(function) && !is_arrow_function(function) {
        return false;
    }
    let params = function.parameters();
    if params.len() < 2 || params.get(1) != param {
        return false;
    }
    let parent = walk_up_parenthesized_expressions(function.parent());
    if !is_new_expression(parent) {
        return false;
    }
    let constructor_type = ctx.checker.get_type_at_location(parent.expression());
    is_promise_constructor_like(ctx.checker, constructor_type)
}

fn is_promise_like_at(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    let t = ctx.checker.get_type_at_location(node);
    is_promise_constructor_like(ctx.checker, t) || is_promise_like(ctx.checker, t)
}

fn check_reject_call(options: &Options, ctx: &mut RuleContext<'_>, call: Node) {
    if let Some(argument) = call.arguments().first() {
        let t = ctx.checker.get_type_at_location(argument);
        if type_matches_some_specifier(ctx.checker, &*ctx.fs(), t, &options.allow)
            || (options.allow_throwing_any && is_type_any_type(ctx.checker, t))
            || (options.allow_throwing_unknown && is_type_unknown_type(ctx.checker, t))
            || is_error_like(ctx.checker, t)
            || is_readonly_error_like(ctx.checker, t)
        {
            return;
        }
    } else if options.allow_empty_reject {
        return;
    }
    ctx.report_node(call, reject_an_error_message());
}
