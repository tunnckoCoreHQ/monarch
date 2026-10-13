//! `only-throw-error`: disallows throwing values that are not `Error`s.

use goport_core::ast::{
    is_arrow_function, is_call_expression, is_catch_clause, is_identifier,
    is_parameter_declaration, is_property_access_expression, is_spread_element,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::TypeFlags;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, get_declaration, is_error_like, is_thenable_type, is_type_any_type,
    is_type_flag_set, is_type_unknown_type, type_matches_some_specifier,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "only-throw-error",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
    allow_rethrowing: bool,
    allow_throwing_any: bool,
    allow_throwing_unknown: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            allow: Vec::new(),
            allow_rethrowing: true,
            allow_throwing_any: true,
            allow_throwing_unknown: true,
        }
    }
}

fn object_message() -> RuleMessage {
    RuleMessage::new("object", "Expected an error object to be thrown.")
}

fn undef_message() -> RuleMessage {
    RuleMessage::new("undef", "Do not throw undefined.")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::ThrowStatement, check_throw)
        .into()
}

fn check_throw(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    let t = ctx.checker.get_type_at_location(expression);

    if type_matches_some_specifier(ctx.checker, &*ctx.fs(), t, &options.allow) {
        return;
    }
    if is_type_flag_set(ctx.checker, t, TypeFlags::UNDEFINED) {
        ctx.report_node(node, undef_message());
        return;
    }
    if (options.allow_throwing_any && is_type_any_type(ctx.checker, t))
        || (options.allow_throwing_unknown && is_type_unknown_type(ctx.checker, t))
        || (options.allow_rethrowing && is_rethrown_error(ctx, expression))
        || is_error_like(ctx.checker, t)
    {
        return;
    }
    ctx.report_node(expression, object_message());
}

/// `e` in `catch (e) { throw e }`, `promise.catch(e => { throw e })` or
/// `promise.then(onFulfilled, e => { throw e })`.
fn is_rethrown_error(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    if !is_identifier(node) {
        return false;
    }
    let declaration = get_declaration(ctx.checker, node);
    if declaration.is_nil() {
        return false;
    }
    if is_catch_clause(declaration.parent()) {
        return true;
    }

    // The first, non-rest parameter of an arrow function passed as the
    // rejection handler.
    if !is_parameter_declaration(declaration) || declaration.dot_dot_dot_token().is_some() {
        return false;
    }
    let function = declaration.parent();
    if !is_arrow_function(function) || function.parameters().first() != Some(declaration) {
        return false;
    }
    let call = function.parent();
    if call.is_nil()
        || !is_call_expression(call)
        || !is_property_access_expression(call.expression())
    {
        return false;
    }
    let access = call.expression();
    let args = call.arguments();
    let is_rejection_handler = match access.name().text() {
        "catch" => args.first() == Some(function),
        // A spread `onFulfilled` would shift the handler's position.
        "then" => args.len() >= 2 && args.get(1) == function && !is_spread_element(args.get(0)),
        _ => false,
    };
    if !is_rejection_handler {
        return false;
    }

    let object = access.expression();
    let object_type = ctx.checker.get_type_at_location(object);
    is_thenable_type(ctx.checker, object, object_type)
}
