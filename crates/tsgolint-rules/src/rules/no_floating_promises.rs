//! `no-floating-promises`: a promise in an expression statement must be
//! awaited, handled with `.catch` or `.then`, or marked with `void`.

use goport_core::ast::{
    get_operator_precedence, is_access_expression, is_arrow_function, is_assignment_expression,
    is_await_expression, is_binary_expression, is_call_expression, is_comma_expression,
    is_function_expression, is_logical_or_coalescing_binary_expression, is_spread_element,
    is_void_expression, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{OperatorPrecedence, OperatorPrecedenceFlags};
use goport_core::frontend::vfs::Fs;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, get_call_signatures, is_function_param, is_promise_like,
    type_matches_some_specifier, union_type_parts, value_matches_some_specifier,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-floating-promises",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_for_known_safe_calls: Vec<TypeOrValueSpecifier>,
    allow_for_known_safe_promises: Vec<TypeOrValueSpecifier>,
    check_thenables: bool,
    #[serde(rename = "ignoreIIFE")]
    ignore_iife: bool,
    ignore_void: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_for_known_safe_calls: Vec::new(),
            allow_for_known_safe_promises: Vec::new(),
            check_thenables: false,
            ignore_iife: false,
            ignore_void: true,
        }
    }
}

const MESSAGE_BASE: &str = "Promises must be awaited, add await operator.";
const MESSAGE_BASE_HELP: &str = "The promise must end with a call to .catch, or end with a call to .then with a rejection handler.";
const MESSAGE_BASE_VOID: &str = "Promises must be awaited, add void operator to ignore.";
const MESSAGE_BASE_VOID_HELP: &str = "The promise must end with a call to .catch, or end with a call to .then with a rejection handler, or be explicitly marked as ignored with the `void` operator.";
const MESSAGE_REJECTION_HANDLER: &str =
    "A rejection handler that is not a function will be ignored.";

fn floating_message() -> RuleMessage {
    RuleMessage::new("floating", MESSAGE_BASE).with_help(MESSAGE_BASE_HELP)
}

fn floating_fix_await_message() -> RuleMessage {
    RuleMessage::new("floatingFixAwait", "Add await operator.")
}

fn floating_fix_void_message() -> RuleMessage {
    RuleMessage::new("floatingFixVoid", "Add void operator to ignore.")
}

fn floating_promise_array_message() -> RuleMessage {
    RuleMessage::new(
        "floatingPromiseArray",
        "An array of Promises may be unintentional.",
    )
    .with_help(
        "Consider handling the promises' fulfillment or rejection with Promise.all or similar.",
    )
}

fn floating_promise_array_void_message() -> RuleMessage {
    RuleMessage::new(
        "floatingPromiseArrayVoid",
        "An array of Promises may be unintentional.",
    )
    .with_help(
        "Consider handling the promises' fulfillment or rejection with Promise.all or similar, \
         or explicitly marking the expression as ignored with the `void` operator.",
    )
}

fn floating_useless_rejection_handler_message() -> RuleMessage {
    RuleMessage::new("floatingUselessRejectionHandler", MESSAGE_BASE)
        .with_help(format!("{MESSAGE_BASE_HELP} {MESSAGE_REJECTION_HANDLER}"))
}

fn floating_useless_rejection_handler_void_message() -> RuleMessage {
    RuleMessage::new("floatingUselessRejectionHandlerVoid", MESSAGE_BASE_VOID).with_help(format!(
        "{MESSAGE_BASE_VOID_HELP} {MESSAGE_REJECTION_HANDLER}"
    ))
}

fn floating_void_message() -> RuleMessage {
    RuleMessage::new("floatingVoid", MESSAGE_BASE_VOID).with_help(MESSAGE_BASE_VOID_HELP)
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::ExpressionStatement, check_expression_statement)
        .into()
}

/// An expression whose promise nobody handles.
struct UnhandledPromise {
    node: Node,
    t: TypeId,
    promise_array: bool,
    /// The rejection handler argument of `.catch` or `.then` that is not
    /// callable.
    non_function_handler: Node,
}

impl UnhandledPromise {
    fn new(node: Node, t: TypeId) -> Self {
        Self {
            node,
            t,
            promise_array: false,
            non_function_handler: Node::NIL,
        }
    }
}

fn check_expression_statement(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let statement_expression = node.expression();
    if options.ignore_iife && is_async_iife(statement_expression) {
        return;
    }
    let expression = skip_parentheses(statement_expression);
    let fs = ctx.fs();
    if is_known_safe_promise_return(ctx.checker, &*fs, options, expression) {
        return;
    }
    let Some(result) = unhandled_promise(ctx.checker, &*fs, options, expression) else {
        return;
    };

    if result.promise_array {
        let message = if options.ignore_void {
            floating_promise_array_void_message()
        } else {
            floating_promise_array_message()
        };
        let report = build_report(ctx, &result, message);
        ctx.report_diagnostic(report);
    } else if options.ignore_void {
        let message = if result.non_function_handler.is_some() {
            floating_useless_rejection_handler_void_message()
        } else {
            floating_void_message()
        };
        let report = build_report(ctx, &result, message);
        ctx.report_diagnostic_with_suggestions(report, |ctx| {
            let void_fixes = if is_higher_precedence_than_unary(statement_expression) {
                vec![ctx.fix_insert_before(node, "void ")]
            } else {
                vec![
                    ctx.fix_insert_before(node, "void ("),
                    RuleFix::insert_after(expression, ")"),
                ]
            };
            vec![
                RuleSuggestion {
                    message: floating_fix_void_message(),
                    fixes: void_fixes,
                },
                RuleSuggestion {
                    message: floating_fix_await_message(),
                    fixes: add_await_fixes(ctx.source_file, expression, node),
                },
            ]
        });
    } else {
        let message = if result.non_function_handler.is_some() {
            floating_useless_rejection_handler_message()
        } else {
            floating_message()
        };
        let report = build_report(ctx, &result, message);
        ctx.report_diagnostic_with_suggestions(report, |ctx| {
            vec![RuleSuggestion {
                message: floating_fix_await_message(),
                fixes: add_await_fixes(ctx.source_file, expression, node),
            }]
        });
    }
}

fn build_report(
    ctx: &mut RuleContext<'_>,
    result: &UnhandledPromise,
    message: RuleMessage,
) -> Report {
    let range = ctx.trim_node_text_range(result.node);
    let type_description = if result.promise_array {
        "This array contains Promises and"
    } else {
        "This unhandled promise-like value"
    };
    let type_string = ctx.checker.type_to_string(result.t);
    let mut report = Report::new(range, message).with_label(
        format!("{type_description} has type `{type_string}`."),
        range,
    );
    let handler = result.non_function_handler;
    if handler.is_some() {
        let handler_type = ctx.checker.get_type_at_location(handler);
        let handler_type_string = ctx.checker.type_to_string(handler_type);
        report = report.with_label(
            format!(
                "This rejection handler has type `{handler_type_string}`, which is not callable."
            ),
            ctx.trim_node_text_range(handler),
        );
    }
    report
}

fn is_higher_precedence_than_unary(node: Node) -> bool {
    let operator = if is_binary_expression(node) {
        node.operator_token().kind()
    } else {
        SyntaxKind::Unknown
    };
    get_operator_precedence(node.kind(), operator, OperatorPrecedenceFlags::NONE)
        > OperatorPrecedence::UNARY
}

fn add_await_fixes(source_file: Node, expression: Node, statement: Node) -> Vec<RuleFix> {
    if is_void_expression(expression) {
        let void_token = token_range_at(source_file, expression.pos());
        return vec![RuleFix::replace_range(void_token, "await")];
    }
    if is_higher_precedence_than_unary(statement.expression()) {
        return vec![RuleFix::insert_before(source_file, statement, "await ")];
    }
    vec![
        RuleFix::insert_before(source_file, statement, "await ("),
        RuleFix::insert_after(expression, ")"),
    ]
}

fn is_async_iife(expression: Node) -> bool {
    if !is_call_expression(expression) {
        return false;
    }
    let callee = skip_parentheses(expression.expression());
    is_arrow_function(callee) || is_function_expression(callee)
}

fn is_known_safe_promise_return(
    c: &mut Checker,
    fs: &dyn Fs,
    options: &Options,
    node: Node,
) -> bool {
    if options.allow_for_known_safe_calls.is_empty() || !is_call_expression(node) {
        return false;
    }
    let callee = node.expression();
    let t = c.get_type_at_location(callee);
    value_matches_some_specifier(c, fs, callee, &options.allow_for_known_safe_calls, t)
        || type_matches_some_specifier(c, fs, t, &options.allow_for_known_safe_calls)
}

fn unhandled_promise(
    c: &mut Checker,
    fs: &dyn Fs,
    options: &Options,
    node: Node,
) -> Option<UnhandledPromise> {
    if is_assignment_expression(node, false) {
        return None;
    }

    // Any operand of a comma expression can hold a promise, whatever the
    // type of the whole.
    if is_comma_expression(node) {
        return unhandled_promise(c, fs, options, node.left())
            .or_else(|| unhandled_promise(c, fs, options, node.right()));
    }

    // `void` gives undefined, so look inside it.
    if !options.ignore_void && is_void_expression(node) {
        return unhandled_promise(c, fs, options, node.expression());
    }

    let t = c.get_type_at_location(node);
    if is_promise_array(c, fs, options, node, t) {
        return Some(UnhandledPromise {
            promise_array: true,
            ..UnhandledPromise::new(node, t)
        });
    }

    // `await` handles promises, but not promise arrays. TypeScript types
    // `await (p as Promise<number> & number)` as the intersection, so the
    // type check below is not enough.
    if is_await_expression(node) {
        return None;
    }

    if !is_promise_like_value(c, fs, options, node, t) {
        return None;
    }

    if is_call_expression(node) {
        // A `.catch()` or a `.then()` with a rejection handler handles it.
        let callee = node.expression();
        if is_access_expression(callee) {
            let (method_name, _) = c.get_accessed_property_name(callee);
            let arguments = node.arguments();
            let handler_index = match method_name.as_str() {
                "catch" if !arguments.is_empty() => Some(0),
                "then" if arguments.len() >= 2 => Some(1),
                _ => None,
            };
            if let Some(index) = handler_index {
                if !is_known_argument_at(node, index) {
                    return Some(UnhandledPromise::new(node, t));
                }
                let handler = arguments.get(index);
                let handler_type = c.get_type_at_location(handler);
                if !get_call_signatures(c, handler_type).is_empty() {
                    return None;
                }
                return Some(UnhandledPromise {
                    non_function_handler: handler,
                    ..UnhandledPromise::new(node, t)
                });
            }
            // `x.finally()` passes the outcome of `x` through.
            if method_name.as_str() == "finally" {
                let mut result = unhandled_promise(c, fs, options, callee.expression())?;
                result.node = node;
                result.t = t;
                return Some(result);
            }
        }
        return Some(UnhandledPromise::new(node, t));
    }

    if node.kind() == SyntaxKind::ConditionalExpression {
        // The promise comes from one of the branches.
        return unhandled_promise(c, fs, options, node.when_false())
            .or_else(|| unhandled_promise(c, fs, options, node.when_true()));
    }

    if is_logical_or_coalescing_binary_expression(node) {
        return unhandled_promise(c, fs, options, node.left())
            .or_else(|| unhandled_promise(c, fs, options, node.right()));
    }

    Some(UnhandledPromise::new(node, t))
}

/// Whether the argument at `index` exists and no spread comes before or at
/// it.
fn is_known_argument_at(call: Node, index: usize) -> bool {
    let arguments = call.arguments();
    arguments.len() > index && !arguments.iter().take(index + 1).any(is_spread_element)
}

fn is_promise_array(
    c: &mut Checker,
    fs: &dyn Fs,
    options: &Options,
    node: Node,
    t: TypeId,
) -> bool {
    for part in union_type_parts(c, t) {
        let apparent = c.get_apparent_type(part);
        if c.is_array_type(apparent) {
            let element_type = c.get_type_arguments(apparent)[0];
            if is_promise_like_value(c, fs, options, node, element_type) {
                return true;
            }
        }
        if c.is_tuple_type(apparent) {
            let element_types = c.get_type_arguments(apparent);
            if element_types
                .into_iter()
                .any(|element_type| is_promise_like_value(c, fs, options, node, element_type))
            {
                return true;
            }
        }
    }
    false
}

/// Whether `t` (the type of `node`) is a promise that is not allowlisted, or
/// with `checkThenables` a thenable whose `then` takes a rejection handler.
fn is_promise_like_value(
    c: &mut Checker,
    fs: &dyn Fs,
    options: &Options,
    node: Node,
    t: TypeId,
) -> bool {
    let t = if t.is_nil() {
        c.get_type_at_location(node)
    } else {
        t
    };
    if type_matches_some_specifier(c, fs, t, &options.allow_for_known_safe_promises) {
        return false;
    }

    let apparent = c.get_apparent_type(t);
    let parts = union_type_parts(c, apparent);
    if parts.iter().any(|&part| is_promise_like(c, part)) {
        return true;
    }
    if !options.check_thenables {
        return false;
    }

    // Like tsutils' `isThenable`, but only thenables that take a second
    // (rejection) callback.
    for part in parts {
        let then = c.get_property_of_type(part, "then");
        if then.is_nil() {
            continue;
        }
        let then_type = c.get_type_of_symbol_at_location(then, node);
        for then_part in union_type_parts(c, then_type) {
            for signature in get_call_signatures(c, then_part) {
                let parameters = c.sig(signature).parameters().to_vec();
                if parameters.len() >= 2
                    && is_function_param(c, parameters[0], node)
                    && is_function_param(c, parameters[1], node)
                {
                    return true;
                }
            }
        }
    }
    false
}
