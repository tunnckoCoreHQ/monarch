//! `strict-void-return`: disallows passing a value-returning function where
//! a void-returning function is expected.

use goport_core::ast::{
    get_function_flags, is_arrow_function, is_assignment_expression, is_block, is_call_expression,
    is_computed_property_name, is_function_expression, is_function_like, is_method_declaration,
    is_object_literal_expression, is_omitted_expression, is_return_statement,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ContextFlags, FunctionFlags, TypeFlags};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_call_signatures, get_construct_signatures, get_heritage_clauses, is_type_flag_set,
    is_type_parameter, is_type_void_type, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "strict-void-return",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_return_any: bool,
}

struct State {
    /// Return types that a void function may have.
    allowed_return_flags: TypeFlags,
}

fn async_func_message() -> RuleMessage {
    RuleMessage::new(
        "asyncFunc",
        "Async function used in a context where a void function is expected.",
    )
}

fn non_void_func_message() -> RuleMessage {
    RuleMessage::new(
        "nonVoidFunc",
        "Value-returning function used in a context where a void function is expected.",
    )
}

fn non_void_return_message() -> RuleMessage {
    RuleMessage::new(
        "nonVoidReturn",
        "Value returned in a context where a void return is expected.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut allowed_return_flags = TypeFlags::VOID | TypeFlags::NEVER | TypeFlags::UNDEFINED;
    if options.allow_return_any {
        allowed_return_flags |= TypeFlags::ANY;
    }
    Listeners::new(State {
        allowed_return_flags,
    })
    .on(SyntaxKind::ArrayLiteralExpression, |state, ctx, node| {
        for element in node.elements() {
            if element.is_some() && element.kind() != SyntaxKind::SpreadElement {
                check_expression_node(state, ctx, element);
            }
        }
    })
    .on(SyntaxKind::ArrowFunction, |state, ctx, node| {
        let body = node.body();
        if body.is_some() && !is_block(body) {
            check_expression_node(state, ctx, body);
        }
    })
    .on(SyntaxKind::BinaryExpression, |state, ctx, node| {
        if is_assignment_expression(node, false) {
            check_expression_node(state, ctx, node.right());
        }
    })
    .on(SyntaxKind::CallExpression, check_function_call_node)
    .on(SyntaxKind::NewExpression, check_function_call_node)
    .on(SyntaxKind::JsxAttribute, |state, ctx, node| {
        let initializer = node.initializer();
        if initializer.is_nil() || initializer.kind() != SyntaxKind::JsxExpression {
            return;
        }
        let expression = initializer.expression();
        if expression.is_some() && !is_omitted_expression(expression) {
            check_expression_node(state, ctx, expression);
        }
    })
    .on(SyntaxKind::MethodDeclaration, |state, ctx, node| {
        if is_object_literal_expression(node.parent()) {
            check_object_method_node(state, ctx, node);
        } else {
            check_class_method_node(state, ctx, node);
        }
    })
    .on(SyntaxKind::PropertyDeclaration, check_class_property_node)
    .on(SyntaxKind::PropertyAssignment, |state, ctx, node| {
        check_expression_node(state, ctx, node.initializer());
    })
    .on(
        SyntaxKind::ShorthandPropertyAssignment,
        |state, ctx, node| {
            check_expression_node(state, ctx, node.name());
        },
    )
    .on(SyntaxKind::ReturnStatement, |state, ctx, node| {
        let expression = node.expression();
        if expression.is_some() {
            check_expression_node(state, ctx, expression);
        }
    })
    .on(SyntaxKind::VariableDeclaration, |state, ctx, node| {
        let initializer = node.initializer();
        if initializer.is_some() {
            check_expression_node(state, ctx, initializer);
        }
    })
    .into()
}

/// Every union member of `t` is void, never, undefined (or any when
/// allowed).
fn is_allowed_type(state: &State, checker: &Checker, t: TypeId) -> bool {
    union_type_parts(checker, t)
        .iter()
        .all(|&part| is_type_flag_set(checker, part, state.allowed_return_flags))
}

/// `t` has call signatures and all of them return only `void`.
fn is_void_returning_function_type(checker: &mut Checker, t: TypeId) -> bool {
    let mut return_types = Vec::new();
    for part in union_type_parts(checker, t) {
        for signature in get_call_signatures(checker, part) {
            return_types.push(checker.get_return_type_of_signature(signature));
        }
    }
    !return_types.is_empty()
        && return_types.iter().all(|&return_type| {
            union_type_parts(checker, return_type)
                .iter()
                .all(|&part| is_type_flag_set(checker, part, TypeFlags::VOID))
        })
}

fn is_nullish_or_any(checker: &Checker, t: TypeId) -> bool {
    is_type_flag_set(
        checker,
        t,
        TypeFlags::VOID_LIKE
            | TypeFlags::UNDEFINED
            | TypeFlags::NULL
            | TypeFlags::ANY
            | TypeFlags::NEVER,
    )
}

fn report_if_non_void_function(state: &State, ctx: &mut RuleContext<'_>, function: Node) {
    let function_type = ctx.checker.get_type_at_location(function);
    let actual_type = ctx.checker.get_apparent_type(function_type);
    let signatures = get_call_signatures(ctx.checker, actual_type);
    if signatures.iter().all(|&signature| {
        let return_type = ctx.checker.get_return_type_of_signature(signature);
        is_allowed_type(state, ctx.checker, return_type)
    }) {
        return;
    }

    if !is_arrow_function(function)
        && !is_function_expression(function)
        && !is_method_declaration(function)
    {
        ctx.report_node(function, non_void_func_message());
        return;
    }

    let function_flags = get_function_flags(function);
    if function_flags.intersects(FunctionFlags::GENERATOR) {
        ctx.report_node(function, non_void_func_message());
        return;
    }
    if function_flags.intersects(FunctionFlags::ASYNC) {
        ctx.report_node(function, async_func_message());
        return;
    }

    let body = function.body();
    if body.is_some() && !is_block(body) {
        ctx.report_node(body, non_void_return_message());
        return;
    }

    let return_type_node = function.type_();
    if return_type_node.is_some() && return_type_node.kind() != SyntaxKind::VoidKeyword {
        ctx.report_node(return_type_node, non_void_func_message());
        return;
    }

    report_non_void_returns(state, ctx, function, function);
}

/// Reports the `return` statements with a value that is not allowed, in
/// `node` and below, without entering nested functions.
fn report_non_void_returns(state: &State, ctx: &mut RuleContext<'_>, function: Node, node: Node) {
    if node.is_nil() || (node != function && is_function_like(node)) {
        return;
    }
    if is_return_statement(node) {
        let expression = node.expression();
        if expression.is_some() {
            let return_type = ctx.checker.get_type_at_location(expression);
            if !is_allowed_type(state, ctx.checker, return_type) {
                ctx.report_node(node, non_void_return_message());
            }
        }
    }
    node.for_each_child(|child| {
        report_non_void_returns(state, ctx, function, child);
        false
    });
}

/// Checks `node` against its contextual type. True when that type is a
/// void-returning function.
fn check_expression_node(state: &State, ctx: &mut RuleContext<'_>, node: Node) -> bool {
    let expected_type = ctx.checker.get_contextual_type(node, ContextFlags::NONE);
    if expected_type.is_some() && is_void_returning_function_type(ctx.checker, expected_type) {
        report_if_non_void_function(state, ctx, node);
        return true;
    }
    false
}

fn check_function_call_node(state: &mut State, ctx: &mut RuleContext<'_>, call: Node) {
    let arguments = call.arguments();
    if arguments.is_empty() {
        return;
    }
    let callee = call.expression();
    let function_type = ctx.checker.get_type_at_location(callee);
    let mut signatures = Vec::new();
    for part in union_type_parts(ctx.checker, function_type) {
        if is_call_expression(call) {
            signatures.extend(get_call_signatures(ctx.checker, part));
        } else {
            signatures.extend(get_construct_signatures(ctx.checker, part));
        }
    }

    for (index, argument) in arguments.iter().enumerate() {
        if argument.kind() == SyntaxKind::SpreadElement {
            continue;
        }
        let mut expected_return_types = Vec::new();
        for &signature in &signatures {
            let Some(&parameter) = ctx.checker.sig(signature).parameters().get(index) else {
                continue;
            };
            let parameter_type = ctx
                .checker
                .get_type_of_symbol_at_location(parameter, callee);
            for part in union_type_parts(ctx.checker, parameter_type) {
                for parameter_signature in get_call_signatures(ctx.checker, part) {
                    expected_return_types.push(
                        ctx.checker
                            .get_return_type_of_signature(parameter_signature),
                    );
                }
            }
        }

        let checker = &*ctx.checker;
        let has_single_signature = signatures.len() == 1;
        let all_signatures_return_void = expected_return_types.iter().all(|&t| {
            is_type_void_type(checker, t)
                || is_nullish_or_any(checker, t)
                || is_type_parameter(checker, t)
        });
        if (has_single_signature || all_signatures_return_void)
            && check_expression_node(state, ctx, argument)
        {
            continue;
        }

        let checker = &*ctx.checker;
        if expected_return_types
            .iter()
            .any(|&t| is_type_void_type(checker, t))
            && expected_return_types
                .iter()
                .all(|&t| is_nullish_or_any(checker, t))
        {
            report_if_non_void_function(state, ctx, argument);
        }
    }
}

/// The name of a member for a property lookup: its symbol's name, else the
/// text of a literal or simple computed name.
fn get_member_name(checker: &mut Checker, name: Node) -> &'static str {
    if name.is_nil() {
        return "";
    }
    let symbol = checker.get_symbol_at_location_exported(name);
    if symbol.is_some() {
        let symbol_name = checker.sym(symbol).name.as_str();
        if !symbol_name.is_empty() {
            return symbol_name;
        }
    }
    match name.kind() {
        SyntaxKind::Identifier
        | SyntaxKind::PrivateIdentifier
        | SyntaxKind::StringLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral => name.text(),
        SyntaxKind::ComputedPropertyName => {
            let expression = name.expression();
            if expression.is_some()
                && matches!(
                    expression.kind(),
                    SyntaxKind::Identifier
                        | SyntaxKind::StringLiteral
                        | SyntaxKind::NumericLiteral
                        | SyntaxKind::BigIntLiteral
                )
            {
                expression.text()
            } else {
                ""
            }
        }
        _ => "",
    }
}

/// The types of the member with the same name in the heritage clauses of
/// the member's class or interface.
fn get_base_member_types(checker: &mut Checker, member: Node) -> Vec<TypeId> {
    let class_like = member.parent();
    if class_like.is_nil() {
        return Vec::new();
    }
    let heritage_clauses = get_heritage_clauses(class_like);
    if heritage_clauses.is_nil() {
        return Vec::new();
    }
    let member_name = member.name();
    if member_name.is_nil() {
        return Vec::new();
    }
    let member_symbol = checker.get_symbol_at_location_exported(member_name);
    if member_symbol.is_nil() {
        return Vec::new();
    }
    let name = checker.sym(member_symbol).name.as_str();

    let mut base_member_types = Vec::new();
    for clause in heritage_clauses.nodes() {
        for heritage_type_node in clause.types().nodes() {
            let heritage_type = checker.get_type_at_location(heritage_type_node);
            let heritage_member = checker.get_property_of_type(heritage_type, name);
            if heritage_member.is_some() {
                base_member_types
                    .push(checker.get_type_of_symbol_at_location(heritage_member, member));
            }
        }
    }
    base_member_types
}

fn check_object_method_node(state: &State, ctx: &mut RuleContext<'_>, method: Node) {
    let name = method.name();
    if name.is_some() && is_computed_property_name(name) {
        return;
    }
    let object_type = ctx
        .checker
        .get_contextual_type(method.parent(), ContextFlags::NONE);
    if object_type.is_nil() {
        return;
    }
    let member_name = get_member_name(ctx.checker, name);
    if member_name.is_empty() {
        return;
    }
    let property = ctx.checker.get_property_of_type(object_type, member_name);
    if property.is_nil() {
        return;
    }
    let expected_type = ctx.checker.get_type_of_symbol_at_location(property, method);
    if is_void_returning_function_type(ctx.checker, expected_type) {
        report_if_non_void_function(state, ctx, method);
    }
}

fn check_class_method_node(state: &State, ctx: &mut RuleContext<'_>, method: Node) {
    if method.body().is_nil() {
        return;
    }
    let base_member_types = get_base_member_types(ctx.checker, method);
    if base_member_types
        .into_iter()
        .any(|t| is_void_returning_function_type(ctx.checker, t))
    {
        report_if_non_void_function(state, ctx, method);
    }
}

fn check_class_property_node(state: &mut State, ctx: &mut RuleContext<'_>, property: Node) {
    let initializer = property.initializer();
    for t in get_base_member_types(ctx.checker, property) {
        if is_void_returning_function_type(ctx.checker, t) && initializer.is_some() {
            report_if_non_void_function(state, ctx, initializer);
            return;
        }
    }
    if initializer.is_some() {
        check_expression_node(state, ctx, initializer);
    }
}
