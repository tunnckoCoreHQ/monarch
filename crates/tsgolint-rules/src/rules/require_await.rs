//! `require-await`: an async function must await something (or return or
//! yield a thenable).

use goport_core::ast::{
    NodeList, TextRange, get_function_flags, is_await_expression, is_block,
    is_constructor_declaration, is_literal_expression, is_method_or_accessor, is_qualified_name,
    is_var_await_using, skip_parentheses, source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::FunctionFlags;
use goport_core::scanner_util::{
    SkipTriviaOptions, get_token_pos_of_node, scan_token_at_position, skip_trivia_ex,
};
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::{
    NON_ARROW_FUNCTION_KINDS, find_modifier, get_function_head_loc,
    get_well_known_symbol_property_of_type, is_thenable_type, type_recurser,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "require-await",
    create,
};

fn missing_await_message() -> RuleMessage {
    RuleMessage::new("missingAwait", "Function has no 'await' expression.")
}

fn remove_async_message() -> RuleMessage {
    RuleMessage::new("removeAsync", "Remove 'async'.")
}

struct Scope {
    has_await: bool,
    is_async_yield: bool,
    function_flags: FunctionFlags,
}

#[derive(Default)]
struct State {
    scopes: Vec<Scope>,
}

impl State {
    fn mark_as_has_await(&mut self) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.has_await = true;
        }
    }
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    let mut listeners = Listeners::new(State::default());
    for kind in NON_ARROW_FUNCTION_KINDS {
        listeners = listeners
            .on(kind, |state, _ctx, node| enter_function(state, node))
            .on(Listener::exit(kind), exit_function);
    }
    listeners
        .on(SyntaxKind::ArrowFunction, enter_arrow_function)
        .on(Listener::exit(SyntaxKind::ArrowFunction), exit_function)
        .on(SyntaxKind::AwaitExpression, |state, _ctx, _node| {
            state.mark_as_has_await();
        })
        .on(SyntaxKind::ForOfStatement, |state, _ctx, node| {
            if node.await_modifier().is_some() {
                state.mark_as_has_await();
            }
        })
        .on(SyntaxKind::VariableDeclarationList, |state, _ctx, node| {
            if is_var_await_using(node) {
                state.mark_as_has_await();
            }
        })
        .on(SyntaxKind::YieldExpression, check_yield)
        .on(SyntaxKind::ReturnStatement, check_return)
        .into()
}

fn enter_function(state: &mut State, node: Node) {
    let body = node.body();
    // Functions with an empty body are never reported.
    let function_flags = if body.is_some() && (!is_block(body) || !body.statements().is_empty()) {
        get_function_flags(node)
    } else {
        FunctionFlags::NORMAL
    };
    state.scopes.push(Scope {
        has_await: false,
        is_async_yield: false,
        function_flags,
    });
}

fn enter_arrow_function(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    enter_function(state, node);
    if !current_flags(state).intersects(FunctionFlags::ASYNC) {
        return;
    }
    // A concise body that returns a thenable counts as an await;
    // `async () => await foo` is marked by its await expression.
    let body = skip_parentheses(node.body());
    if is_block(body) || is_await_expression(body) {
        return;
    }
    let body_type = ctx.checker.get_type_at_location(body);
    if is_thenable_type(ctx.checker, body, body_type) {
        state.mark_as_has_await();
    }
}

fn current_flags(state: &State) -> FunctionFlags {
    state
        .scopes
        .last()
        .map_or(FunctionFlags::NORMAL, |scope| scope.function_flags)
}

fn exit_function(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(scope) = state.scopes.pop() else {
        return;
    };
    let is_async = scope.function_flags.intersects(FunctionFlags::ASYNC);
    let is_generator = scope.function_flags.intersects(FunctionFlags::GENERATOR);
    if !is_async || scope.has_await || (is_generator && scope.is_async_yield) {
        return;
    }
    // `is_async` means the node has an `async` modifier.
    let async_token = find_modifier(node, SyntaxKind::AsyncKeyword);
    let range = get_function_head_loc(ctx.source_file, node);
    ctx.report_range_with_suggestions(range, missing_await_message(), |ctx| {
        vec![RuleSuggestion {
            message: remove_async_message(),
            fixes: remove_async_fixes(ctx.source_file, node, async_token, is_generator),
        }]
    });
}

fn check_yield(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(scope) = state.scopes.last_mut() else {
        return;
    };
    if scope.is_async_yield {
        return;
    }
    let argument = node.expression();
    if !scope.function_flags.intersects(FunctionFlags::GENERATOR) || argument.is_nil() {
        return;
    }
    // `yield* 1` and the like never need checking.
    if is_literal_expression(argument) {
        return;
    }
    let argument_type = ctx.checker.get_type_at_location(argument);
    let is_async_yield = if node.asterisk_token().is_nil() {
        is_thenable_type(ctx.checker, argument, argument_type)
    } else {
        type_recurser(ctx.checker, argument_type, |c, t| {
            get_well_known_symbol_property_of_type(c, t, "asyncIterator").is_some()
        })
    };
    if is_async_yield {
        scope.is_async_yield = true;
    }
}

fn check_return(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(scope) = state.scopes.last() else {
        return;
    };
    if scope.has_await || !scope.function_flags.intersects(FunctionFlags::ASYNC) {
        return;
    }
    let expression = node.expression();
    if expression.is_nil() {
        return;
    }
    let expression_type = ctx.checker.get_type_at_location(expression);
    if is_thenable_type(ctx.checker, expression, expression_type) {
        state.mark_as_has_await();
    }
}

fn is_method_like(node: Node) -> bool {
    is_method_or_accessor(node) || is_constructor_declaration(node)
}

/// Whether the element right before `node` in `list` is a method,
/// constructor or accessor.
fn previous_sibling_is_method_like(list: NodeList, node: Node) -> bool {
    if list.is_nil() {
        return false;
    }
    let nodes = list.nodes();
    nodes
        .iter()
        .position(|member| member == node)
        .is_some_and(|i| i > 0 && is_method_like(nodes.get(i - 1)))
}

/// Whether inserting a `(`, `[` or template at the start of `node` needs a
/// `;` before it. Like tsgolint (a port of eslint's helper), this looks only
/// at the last non-whitespace byte before `node`, even inside a comment.
fn needs_preceding_semicolon(source_file: Node, node: Node) -> bool {
    let pos = get_token_pos_of_node(node, source_file, false) as usize;
    let text = source_file_text(source_file);
    let bytes = text.as_bytes();
    let Some(last) = bytes[..pos]
        .iter()
        .rposition(|&c| !matches!(c, b' ' | b'\t' | b'\n' | b'\r'))
    else {
        return false;
    };
    let ch = bytes[last];
    if matches!(ch, b';' | b':' | b'{' | b',' | b'(' | b'[') {
        return false;
    }
    if last >= 1 && matches!(&bytes[last - 1..=last], b"=>" | b"++" | b"--") {
        return false;
    }
    // A `}` that ends a method of a class or object literal delimits it.
    if ch == b'}' {
        let parent = node.parent();
        if parent.is_some() {
            let members = match parent.kind() {
                SyntaxKind::ClassDeclaration
                | SyntaxKind::ClassExpression
                | SyntaxKind::InterfaceDeclaration => parent.member_list(),
                SyntaxKind::ObjectLiteralExpression => parent.property_list(),
                _ => NodeList::NIL,
            };
            if previous_sibling_is_method_like(members, node) {
                return false;
            }
        }
    }
    true
}

/// Whether `type_reference` names `name` or `globalThis.<name>`.
fn is_type_reference_named(type_reference: Node, name: &str) -> bool {
    let type_name = type_reference.type_name();
    if type_name.is_nil() {
        return false;
    }
    if type_name.kind() == SyntaxKind::Identifier {
        return type_name.text() == name;
    }
    if !is_qualified_name(type_name) {
        return false;
    }
    let left = type_name.left();
    type_name.right().text() == name
        && left.kind() == SyntaxKind::Identifier
        && left.text() == "globalThis"
}

/// Whether `node` starts an expression statement. Compares untrimmed
/// positions, as eslint's helper of the same name does.
fn is_at_start_of_expression_statement(node: Node) -> bool {
    let start = node.pos();
    let mut ancestor = node.parent();
    while ancestor.is_some() && ancestor.pos() == start {
        if ancestor.kind() == SyntaxKind::ExpressionStatement {
            return true;
        }
        ancestor = ancestor.parent();
    }
    false
}

/// Removes `async` and unwraps a `Promise<T>` return type (or turns
/// `AsyncGenerator` into `Generator`).
fn remove_async_fixes(
    source_file: Node,
    node: Node,
    async_token: Node,
    is_generator: bool,
) -> Vec<RuleFix> {
    let text = source_file_text(source_file);
    let async_start = get_token_pos_of_node(async_token, source_file, false);
    // Keep the comments after `async`, drop the whitespace.
    let remove_end = skip_trivia_ex(
        &text,
        async_token.end(),
        Some(&SkipTriviaOptions {
            stop_at_comments: true,
            ..Default::default()
        }),
    );

    let next_token = scan_token_at_position(source_file, async_token.end());
    let add_semicolon = matches!(
        next_token,
        SyntaxKind::OpenParenToken
            | SyntaxKind::OpenBracketToken
            | SyntaxKind::NoSubstitutionTemplateLiteral
            | SyntaxKind::TemplateHead
    ) && (is_at_start_of_expression_statement(node) || is_method_like(node))
        && needs_preceding_semicolon(source_file, node);

    let remove_range = TextRange::new(async_start, remove_end);
    let mut fixes = vec![if add_semicolon {
        RuleFix::replace_range(remove_range, ";")
    } else {
        RuleFix::remove_range(remove_range)
    }];

    let return_type = node.type_();
    if return_type.is_nil() || return_type.kind() != SyntaxKind::TypeReference {
        return fixes;
    }
    let type_name = return_type.type_name();
    let type_name_start = get_token_pos_of_node(type_name, source_file, false);
    if is_generator && is_type_reference_named(return_type, "AsyncGenerator") {
        fixes.push(RuleFix::replace_range(
            TextRange::new(type_name_start, type_name.end()),
            "Generator",
        ));
    } else if !is_generator && is_type_reference_named(return_type, "Promise") {
        let type_arguments = return_type.type_argument_list();
        if !type_arguments.is_nil() && !type_arguments.nodes().is_empty() {
            // The list spans the text between `<` and `>`.
            let open_angle = type_arguments.pos() - 1;
            let close_angle = type_arguments.end();
            fixes.push(RuleFix::remove_range(TextRange::new(
                close_angle,
                close_angle + 1,
            )));
            fixes.push(RuleFix::remove_range(TextRange::new(
                type_name_start,
                open_angle + 1,
            )));
        }
    }
    fixes
}
