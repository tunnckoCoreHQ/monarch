//! `return-await`: requires or disallows `await` on returned promises,
//! depending on whether it changes error handling.

use goport_core::ast::{
    get_enclosing_block_scope_container, has_syntactic_modifier, is_await_expression, is_block,
    is_function_like, is_try_statement, is_variable_declaration, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::{ModifierFlags, NodeFlags};
use goport_core::scanner_util::scan_token_at_position;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
};

use crate::utils::{
    NON_ARROW_FUNCTION_KINDS, TypeAwaitable, get_await_token_removal_range, insert_await_fixes,
    is_start_of_arrow_function_body_needing_parentheses, needs_to_be_awaited,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "return-await",
    create,
};

/// The option: a bare string (schema default `in-try-catch`).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Mode {
    Always,
    ErrorHandlingCorrectnessOnly,
    InTryCatch,
    Never,
}

fn decode(options: &Value) -> Mode {
    match options {
        Value::Null => Mode::InTryCatch,
        // Only a string decodes: serde would also take `{"always": null}`.
        Value::String(_) => Mode::deserialize(options)
            .unwrap_or_else(|error| panic!("{}: failed to unmarshal options: {error}", RULE.name)),
        other => panic!(
            "{}: failed to unmarshal options: expected a string, got {other}",
            RULE.name
        ),
    }
}

fn disallowed_promise_await_message() -> RuleMessage {
    RuleMessage::new(
        "disallowedPromiseAwait",
        "Returning an awaited promise is not allowed in this context.",
    )
}

fn disallowed_promise_await_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "disallowedPromiseAwaitSuggestion",
        "Remove `await` before the expression. Use caution as this may impact control flow.",
    )
}

fn non_promise_await_message() -> RuleMessage {
    RuleMessage::new(
        "nonPromiseAwait",
        "Returning an awaited value that is not a promise is not allowed.",
    )
}

fn required_promise_await_message() -> RuleMessage {
    RuleMessage::new(
        "requiredPromiseAwait",
        "Returning an awaited promise is required in this context.",
    )
}

fn required_promise_await_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "requiredPromiseAwaitSuggestion",
        "Add `await` before the expression. Use caution as this may impact control flow.",
    )
}

struct Scope {
    has_async: bool,
    owning_function: Node,
}

struct State {
    mode: Mode,
    scopes: Vec<Scope>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WhetherToAwait {
    DontCare,
    Await,
    NoAwait,
}

fn whether_to_await(affects_error_handling: bool, mode: Mode) -> WhetherToAwait {
    match mode {
        Mode::Always => WhetherToAwait::Await,
        Mode::ErrorHandlingCorrectnessOnly if affects_error_handling => WhetherToAwait::Await,
        Mode::ErrorHandlingCorrectnessOnly => WhetherToAwait::DontCare,
        Mode::InTryCatch if affects_error_handling => WhetherToAwait::Await,
        Mode::InTryCatch | Mode::Never => WhetherToAwait::NoAwait,
    }
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let mode = decode(options);
    let mut listeners = Listeners::new(State {
        mode,
        scopes: Vec::new(),
    })
    .on(SyntaxKind::ArrowFunction, enter_function);
    for kind in NON_ARROW_FUNCTION_KINDS {
        listeners = listeners.on(kind, enter_function);
    }
    listeners = listeners.on(
        Listener::exit(SyntaxKind::ArrowFunction),
        exit_arrow_function,
    );
    for kind in NON_ARROW_FUNCTION_KINDS {
        listeners = listeners.on(Listener::exit(kind), |state, _ctx, _node| {
            state.scopes.pop();
        });
    }
    listeners
        .on(SyntaxKind::ReturnStatement, check_return)
        .into()
}

fn enter_function(state: &mut State, _ctx: &mut RuleContext<'_>, node: Node) {
    state.scopes.push(Scope {
        has_async: has_syntactic_modifier(node, ModifierFlags::ASYNC),
        owning_function: node,
    });
}

fn exit_arrow_function(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let body = node.body();
    if !is_block(body)
        && let Some(owning_function) = async_owning_function(state)
    {
        test_each_possibly_returned_node(state, ctx, body, owning_function);
    }
    state.scopes.pop();
}

fn check_return(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    if expression.is_nil() {
        return;
    }
    if let Some(owning_function) = async_owning_function(state) {
        test_each_possibly_returned_node(state, ctx, expression, owning_function);
    }
}

/// The function of the innermost scope, when it is async.
fn async_owning_function(state: &State) -> Option<Node> {
    let scope = state.scopes.last()?;
    scope.has_async.then_some(scope.owning_function)
}

fn test_each_possibly_returned_node(
    state: &State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    owning_function: Node,
) {
    let node = skip_parentheses(node);
    if node.kind() == SyntaxKind::ConditionalExpression {
        test_each_possibly_returned_node(state, ctx, node.when_false(), owning_function);
        test_each_possibly_returned_node(state, ctx, node.when_true(), owning_function);
    } else {
        test(state, ctx, node, owning_function);
    }
}

fn test(state: &State, ctx: &mut RuleContext<'_>, node: Node, owning_function: Node) {
    let is_await = is_await_expression(node);
    let child = if is_await { node.expression() } else { node };
    let child_type = ctx.checker.get_type_at_location(child);
    let certainty = needs_to_be_awaited(ctx.checker, node, child_type);

    if certainty != TypeAwaitable::Always {
        if is_await && certainty == TypeAwaitable::Never {
            ctx.report_node_with_fixes(node, non_promise_await_message(), |ctx| {
                remove_await_fixes(ctx.source_file, node)
            });
        }
        return;
    }

    // The value is a thenable here.
    let affects_error_handling = affects_explicit_error_handling(node)
        || affects_explicit_resource_management(ctx, owning_function, node);
    let use_auto_fix = !affects_error_handling;

    match whether_to_await(affects_error_handling, state.mode) {
        WhetherToAwait::Await if !is_await => {
            let fixes = insert_await_fixes(ctx.source_file, node);
            ctx.report_node_with_fixes_or_suggestions(
                node,
                use_auto_fix,
                required_promise_await_message(),
                required_promise_await_suggestion_message(),
                fixes,
            );
        }
        WhetherToAwait::NoAwait if is_await => {
            let fixes = remove_await_fixes(ctx.source_file, node);
            ctx.report_node_with_fixes_or_suggestions(
                node,
                use_auto_fix,
                disallowed_promise_await_message(),
                disallowed_promise_await_suggestion_message(),
                fixes,
            );
        }
        _ => {}
    }
}

/// Whether a `using` or `await using` declaration before `node`, in a block
/// scope between `node` and its function, disposes after the return.
fn affects_explicit_resource_management(
    ctx: &mut RuleContext<'_>,
    owning_function: Node,
    node: Node,
) -> bool {
    if !is_block(owning_function.body()) {
        return false;
    }
    let mut declaration_scope = get_enclosing_block_scope_container(node);
    while declaration_scope.is_some() {
        let locals = declaration_scope.locals();
        if locals.is_some() {
            let symbols = &ctx.checker.symbols;
            let found = symbols.values(locals).into_iter().any(|local| {
                let declaration = symbols.sym(local).value_declaration;
                declaration.is_some()
                    && is_variable_declaration(declaration)
                    && declaration.parent().flags().intersects(NodeFlags::USING)
                    && declaration.pos() < node.pos()
            });
            if found {
                return true;
            }
        }
        if declaration_scope == owning_function {
            break;
        }
        declaration_scope = get_enclosing_block_scope_container(declaration_scope);
    }
    false
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TryBlock {
    Catch,
    Finally,
    Try,
}

/// The nearest try statement around `node` in its function, and the part of
/// it that holds `node`.
fn find_containing_try_statement(node: Node) -> Option<(TryBlock, Node)> {
    let mut child = node;
    let mut ancestor = node.parent();
    while ancestor.is_some() && !is_function_like(ancestor) {
        if !is_try_statement(ancestor) {
            child = ancestor;
            ancestor = ancestor.parent();
            continue;
        }
        // A child that is neither block is the catch clause.
        let block = if child == ancestor.try_block() {
            TryBlock::Try
        } else if child == ancestor.finally_block() {
            TryBlock::Finally
        } else {
            TryBlock::Catch
        };
        return Some((block, ancestor));
    }
    None
}

/// Whether throwing at `node` changes control flow because of an enclosing
/// try, catch or finally block.
fn affects_explicit_error_handling(mut node: Node) -> bool {
    loop {
        let Some((block, try_statement)) = find_containing_try_statement(node) else {
            return false;
        };
        match block {
            // A catch followed by a finally affects control flow.
            TryBlock::Catch if try_statement.finally_block().is_some() => return true,
            TryBlock::Catch | TryBlock::Finally => node = try_statement,
            // A try block is always followed by a catch or a finally.
            TryBlock::Try => return true,
        }
    }
}

fn remove_await_fixes(source_file: Node, node: Node) -> Vec<RuleFix> {
    let mut fixes = vec![RuleFix::remove_range(get_await_token_removal_range(
        source_file,
        node.pos(),
    ))];
    let operand = node.expression();
    let first_token = scan_token_at_position(source_file, operand.pos());
    if is_start_of_arrow_function_body_needing_parentheses(source_file, node, first_token) {
        fixes.extend(RuleFix::wrap_in_parens(source_file, operand));
    }
    fixes
}
