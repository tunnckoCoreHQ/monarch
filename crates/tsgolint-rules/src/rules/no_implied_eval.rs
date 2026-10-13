//! `no-implied-eval`: disallows `new Function(...)` and string handlers of
//! `setTimeout`-like functions.

use goport_core::ast::{
    get_source_file_of_node, is_access_expression, is_call_expression,
    is_element_access_expression, is_function_like, is_identifier, is_literal_expression,
    is_property_access_expression, is_string_literal,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::SymbolFlags;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{get_call_signatures, is_builtin_symbol_like, is_symbol_flag_set};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-implied-eval",
    create,
};

fn no_function_constructor_message() -> RuleMessage {
    RuleMessage::new(
        "noFunctionConstructor",
        "Implied eval. Do not use the Function constructor to create functions.",
    )
}

fn no_implied_eval_error_message() -> RuleMessage {
    RuleMessage::new("noImpliedEvalError", "Implied eval.")
        .with_help("Consider passing a function.")
}

const GLOBAL_CANDIDATES: [&str; 3] = ["global", "globalThis", "window"];
const EVAL_LIKE_FUNCTIONS: [&str; 4] = ["execScript", "setImmediate", "setInterval", "setTimeout"];

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_implied_eval)
        .on(SyntaxKind::NewExpression, check_implied_eval)
        .into()
}

/// `f`, `window.f` or `globalThis["f"]` gives `f`; anything else gives "".
fn callee_name(node: Node) -> &'static str {
    if is_identifier(node) {
        return node.text();
    }
    if is_access_expression(node)
        && is_identifier(node.expression())
        && GLOBAL_CANDIDATES.contains(&node.expression().text())
    {
        if is_property_access_expression(node) {
            if is_identifier(node.name()) {
                return node.name().text();
            }
        } else if is_element_access_expression(node) {
            let argument = node.argument_expression();
            if is_string_literal(argument) {
                return argument.text();
            }
        }
    }
    ""
}

fn is_function_type(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    let t = ctx.checker.get_type_at_location(node);
    let symbol = ctx.checker.ty(t).symbol;
    if is_symbol_flag_set(
        ctx.checker,
        symbol,
        SymbolFlags::FUNCTION | SymbolFlags::METHOD,
    ) {
        return true;
    }
    if is_builtin_symbol_like(ctx.checker, t, &["Function"]) {
        return true;
    }
    !get_call_signatures(ctx.checker, t).is_empty()
}

fn is_bind(mut node: Node) -> bool {
    if is_property_access_expression(node) {
        node = node.name();
    }
    is_identifier(node) && node.text() == "bind"
}

fn is_function(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    if is_function_like(node) {
        return true;
    }
    if is_literal_expression(node) {
        return false;
    }
    if is_call_expression(node) {
        return is_bind(node.expression()) || is_function_type(ctx, node);
    }
    is_function_type(ctx, node)
}

fn check_implied_eval(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    let name = callee_name(callee);
    if name.is_empty() {
        return;
    }

    if name == "Function" {
        let t = ctx.checker.get_type_at_location(callee);
        if ctx.checker.ty(t).symbol.is_nil() {
            // tsgolint reports a symbol-less `Function` and keeps checking
            // the call, so its handler can be reported too.
            ctx.report_node(node, no_function_constructor_message());
        } else if is_builtin_symbol_like(ctx.checker, t, &["FunctionConstructor"]) {
            ctx.report_node(node, no_function_constructor_message());
            return;
        }
    }

    let Some(handler) = node.arguments().first() else {
        return;
    };

    if EVAL_LIKE_FUNCTIONS.contains(&name) && !is_function(ctx, handler) {
        let symbol = ctx.checker.get_symbol_at_location_exported(callee);
        // A handler-taking function declared in this file is not the global one.
        let declared_here = symbol.is_some()
            && ctx
                .checker
                .sym(symbol)
                .declarations
                .iter()
                .any(|&d| get_source_file_of_node(d) == ctx.source_file);
        if !declared_here {
            ctx.report_node(handler, no_implied_eval_error_message());
        }
    }
}
