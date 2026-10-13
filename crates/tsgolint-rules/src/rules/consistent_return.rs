//! `consistent-return`: every `return` of a function either returns a value
//! or none.

use goport_core::ast::{get_function_flags, get_name_of_declaration, is_identifier};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{FunctionFlags, NodeFlags, TypeFlags};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
    node_text,
};

use crate::utils::{
    NON_ARROW_FUNCTION_KINDS, get_call_signatures, is_intrinsic_void_type, is_thenable_type,
    is_undefined_literal, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "consistent-return",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    treat_undefined_as_unspecified: bool,
}

struct FunctionState {
    node: Node,
    has_return: bool,
    has_return_value: bool,
    has_mismatch: bool,
    /// Computed on first use: most functions never need it.
    allows_void_return: Option<bool>,
}

struct State {
    options: Options,
    functions: Vec<FunctionState>,
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut listeners = Listeners::new(State {
        options,
        functions: Vec::new(),
    });
    for kind in NON_ARROW_FUNCTION_KINDS
        .into_iter()
        .chain([SyntaxKind::ArrowFunction])
    {
        listeners = listeners
            .on(kind, enter_function)
            .on(Listener::exit(kind), exit_function);
    }
    listeners
        .on(SyntaxKind::ReturnStatement, check_return)
        .into()
}

fn missing_return_value_message(function_name_with_kind: &str) -> RuleMessage {
    RuleMessage::new(
        "missingReturnValue",
        format!("{function_name_with_kind} expected a return value."),
    )
}

fn unexpected_return_value_message(function_name_with_kind: &str) -> RuleMessage {
    RuleMessage::new(
        "unexpectedReturnValue",
        format!("{function_name_with_kind} expected no return value."),
    )
}

fn enter_function(state: &mut State, _ctx: &mut RuleContext<'_>, node: Node) {
    state.functions.push(FunctionState {
        node,
        has_return: false,
        has_return_value: false,
        has_mismatch: false,
        allows_void_return: None,
    });
}

fn exit_function(state: &mut State, ctx: &mut RuleContext<'_>, _node: Node) {
    let Some(mut function) = state.functions.pop() else {
        return;
    };
    if !function.has_mismatch
        && function.has_return
        && function.has_return_value
        && function
            .node
            .flags()
            .intersects(NodeFlags::HAS_IMPLICIT_RETURN)
        && !allows_void_return(ctx, &mut function)
    {
        let name = function_name_with_kind(ctx.source_file, function.node);
        ctx.report_node(function.node, missing_return_value_message(&name));
    }
}

fn check_return(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let treat_undefined_as_unspecified = state.options.treat_undefined_as_unspecified;
    let Some(function) = state.functions.last_mut() else {
        return;
    };
    let expression = node.expression();
    if expression.is_nil() && allows_void_return(ctx, function) {
        return;
    }

    let has_return_value = has_return_value(ctx, expression, treat_undefined_as_unspecified);
    if !function.has_return {
        function.has_return = true;
        function.has_return_value = has_return_value;
        return;
    }

    if function.has_return_value != has_return_value {
        function.has_mismatch = true;
        let name = function_name_with_kind(ctx.source_file, function.node);
        // The first return decides what the others should do.
        let message = if function.has_return_value {
            missing_return_value_message(&name)
        } else {
            unexpected_return_value_message(&name)
        };
        ctx.report_node(node, message);
    }
}

fn allows_void_return(ctx: &mut RuleContext<'_>, function: &mut FunctionState) -> bool {
    *function
        .allows_void_return
        .get_or_insert_with(|| is_return_void_or_thenable_void(ctx.checker, function.node))
}

fn has_return_value(
    ctx: &mut RuleContext<'_>,
    expression: Node,
    treat_undefined_as_unspecified: bool,
) -> bool {
    if expression.is_nil() {
        return false;
    }
    if !treat_undefined_as_unspecified {
        return true;
    }
    let t = ctx.checker.get_type_at_location(expression);
    if ctx.checker.ty(t).flags == TypeFlags::UNDEFINED {
        return false;
    }
    !is_undefined_literal(expression)
}

fn function_name_with_kind(source_file: Node, node: Node) -> String {
    let kind = if get_function_flags(node).intersects(FunctionFlags::ASYNC) {
        "Async function"
    } else {
        "Function"
    };
    let name_node = get_name_of_declaration(node);
    if name_node.is_nil() {
        return kind.to_owned();
    }
    let name = if is_identifier(name_node) {
        name_node.text().to_owned()
    } else {
        node_text(source_file, name_node).trim().to_owned()
    };
    if name.is_empty() {
        return kind.to_owned();
    }
    format!("{kind} '{name}'")
}

fn is_return_void_or_thenable_void(c: &mut Checker, function: Node) -> bool {
    let function_type = c.get_type_at_location(function);
    let signatures = get_call_signatures(c, function_type);
    let is_async = get_function_flags(function).intersects(FunctionFlags::ASYNC);
    signatures.into_iter().any(|signature| {
        let return_type = c.get_return_type_of_signature(signature);
        if is_async {
            is_thenable_type_with_void_value(c, function, return_type, &mut FxHashSet::default())
        } else {
            union_type_parts(c, return_type)
                .into_iter()
                .any(|part| is_intrinsic_void_type(c, part))
        }
    })
}

fn is_thenable_type_with_void_value(
    c: &mut Checker,
    node: Node,
    t: TypeId,
    visited: &mut FxHashSet<TypeId>,
) -> bool {
    if t.is_nil() || !visited.insert(t) {
        return false;
    }
    if is_intrinsic_void_type(c, t) {
        return true;
    }
    if c.ty(t).flags.intersects(TypeFlags::UNION_OR_INTERSECTION) {
        let parts = c.ty(t).types_list();
        return parts
            .into_iter()
            .any(|part| is_thenable_type_with_void_value(c, node, part, visited));
    }
    if !is_thenable_type(c, node, t) {
        return false;
    }
    let awaited = c.get_awaited_type(t);
    if awaited.is_nil() || awaited == t {
        return false;
    }
    is_thenable_type_with_void_value(c, node, awaited, visited)
}
