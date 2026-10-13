//! `await-thenable`: disallows awaiting a value that is not a thenable, and
//! the `for await` and `await using` forms and promise aggregators on
//! values that are not async.

use goport_core::ast::{
    is_access_expression, is_array_literal_expression, is_expression_statement,
    is_omitted_expression, is_var_await_using, skip_parentheses, source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::{
    TypeAwaitable, get_await_token_removal_range, get_constrained_type_at_location,
    get_for_statement_head_loc, get_number_index_type, get_well_known_symbol_property_of_type,
    is_promise_constructor_like, is_type_any_type, needs_to_be_awaited, operand_needs_parentheses,
    trim_node_text_range, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "await-thenable",
    create,
};

fn await_message() -> RuleMessage {
    RuleMessage::new(
        "await",
        "Unexpected `await` of a non-Promise (non-\"Thenable\") value.",
    )
    .with_help("Remove `await` if the value is synchronous, or change the expression to return a Promise or Thenable before awaiting it.")
}

fn remove_await_message() -> RuleMessage {
    RuleMessage::new("removeAwait", "Remove unnecessary `await`.")
}

fn for_await_of_non_async_iterable_message() -> RuleMessage {
    RuleMessage::new(
        "forAwaitOfNonAsyncIterable",
        "Unexpected `for await...of` of a value that is not async iterable.",
    )
    .with_help("Use `for...of` for synchronous iterables, or change the iterable to implement `Symbol.asyncIterator`.")
}

fn convert_to_ordinary_for_message() -> RuleMessage {
    RuleMessage::new(
        "convertToOrdinaryFor",
        "Convert to an ordinary `for...of` loop.",
    )
}

fn await_using_of_non_async_disposable_message() -> RuleMessage {
    RuleMessage::new(
        "awaitUsingOfNonAsyncDisposable",
        "Unexpected `await using` of a value that is not async disposable.",
    )
    .with_help("Use plain `using` for synchronous disposables, or change the value to implement `Symbol.asyncDispose`.")
}

fn invalid_promise_aggregator_input_message() -> RuleMessage {
    RuleMessage::new(
        "invalidPromiseAggregatorInput",
        "Unexpected iterable of non-Promise (non-\"Thenable\") values passed to promise aggregator.",
    )
    .with_help("Pass an iterable of Promise-like values, or wrap each synchronous value in `Promise.resolve(...)` before calling the aggregator.")
}

/// The label of a value that is not a promise.
const NOT_PROMISE_LIKE: &str = "This expression is not Promise-like";

const PROMISE_AGGREGATOR_METHODS: [&str; 4] = ["all", "allSettled", "any", "race"];

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::AwaitExpression, |_, ctx, node| {
            check_await(ctx, node)
        })
        .on(SyntaxKind::CallExpression, |_, ctx, node| {
            check_call(ctx, node)
        })
        .on(SyntaxKind::ForOfStatement, |_, ctx, node| {
            check_for_of(ctx, node)
        })
        .on(SyntaxKind::VariableDeclarationList, |_, ctx, node| {
            check_await_using(ctx, node);
        })
        .into()
}

fn check_await(ctx: &mut RuleContext<'_>, node: Node) {
    let argument = node.expression();
    let argument_type = ctx.checker.get_type_at_location(argument);
    if needs_to_be_awaited(ctx.checker, argument, argument_type) != TypeAwaitable::Never {
        return;
    }
    let await_token = token_range_at(ctx.source_file, node.pos());
    let report = Report::new(await_token, await_message())
        .with_label(NOT_PROMISE_LIKE, ctx.trim_node_text_range(argument));
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        vec![RuleSuggestion {
            message: remove_await_message(),
            fixes: remove_await_fixes(ctx.source_file, node, argument),
        }]
    });
}

fn remove_await_fixes(source_file: Node, node: Node, argument: Node) -> Vec<RuleFix> {
    let mut fixes = vec![RuleFix::remove_range(get_await_token_removal_range(
        source_file,
        node.pos(),
    ))];
    let text = source_file_text(source_file);
    let mut scanner = get_scanner_for_source_file(source_file, &text, argument.pos());
    let mut starts_with_parenthesis = scanner.token() == SyntaxKind::OpenParenToken;
    if operand_needs_parentheses(source_file, node, &mut scanner) {
        fixes.extend(RuleFix::wrap_in_parens(source_file, argument));
        starts_with_parenthesis = true;
    }
    if starts_with_parenthesis && previous_statement_lacks_semicolon(source_file, node) {
        fixes[0].text = ";".to_owned();
    }
    fixes
}

/// Whether removing `await` at `node` leaves a statement that starts with
/// `(` and would continue the previous statement. Only sibling statements
/// get a separator: one inside an unbraced `if` or loop body would turn the
/// body into an empty statement.
fn previous_statement_lacks_semicolon(source_file: Node, node: Node) -> bool {
    let start = trim_node_text_range(source_file, node).pos();
    let mut statement = node;
    while statement.is_some() && trim_node_text_range(source_file, statement).pos() == start {
        if !is_expression_statement(statement) {
            statement = statement.parent();
            continue;
        }
        let parent = statement.parent();
        if parent.is_nil() || !parent.can_have_statements() {
            return false;
        }
        let statements = parent.statements();
        let Some(index) = statements.iter().position(|s| s.pos() == statement.pos()) else {
            return false;
        };
        if index == 0 {
            return false;
        }
        let previous = statements.get(index - 1);
        let text = source_file_text(source_file);
        return previous.end() > previous.pos()
            && text.as_bytes()[previous.end() as usize - 1] != b';';
    }
    false
}

fn check_call(ctx: &mut RuleContext<'_>, node: Node) {
    let arguments = node.arguments();
    let Some(argument) = arguments.first() else {
        return;
    };
    if !is_promise_aggregator_method(ctx.checker, node) || argument.is_nil() {
        return;
    }

    if is_array_literal_expression(argument) {
        for element in argument.elements() {
            if element.is_nil() || is_omitted_expression(element) {
                continue;
            }
            let element_type = get_constrained_type_at_location(ctx.checker, element);
            if is_always_non_awaitable_type(ctx.checker, element, element_type) {
                let argument_range = ctx.trim_node_text_range(argument);
                let element_range = ctx.trim_node_text_range(element);
                let report = Report::new(element_range, invalid_promise_aggregator_input_message())
                    .with_label(NOT_PROMISE_LIKE, element_range)
                    .with_label("Promise aggregator input", argument_range);
                ctx.report_diagnostic(report);
            }
        }
        return;
    }

    let argument_type = get_constrained_type_at_location(ctx.checker, argument);
    if is_invalid_promise_aggregator_input(ctx.checker, argument, argument_type) {
        let range = ctx.trim_node_text_range(argument);
        ctx.report_diagnostic(
            Report::new(range, invalid_promise_aggregator_input_message())
                .with_label(NOT_PROMISE_LIKE, range),
        );
    }
}

fn check_for_of(ctx: &mut RuleContext<'_>, node: Node) {
    let await_modifier = node.await_modifier();
    if await_modifier.is_nil() {
        return;
    }
    let expression = node.expression();
    let expression_type = ctx.checker.get_type_at_location(expression);
    if is_type_any_type(ctx.checker, expression_type) {
        return;
    }
    if has_well_known_symbol_part(ctx.checker, expression_type, "asyncIterator") {
        return;
    }
    let report = Report::new(
        get_for_statement_head_loc(ctx.source_file, node),
        for_await_of_non_async_iterable_message(),
    )
    .with_label(
        "This value is not async iterable",
        ctx.trim_node_text_range(expression),
    );
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        // Like tsgolint, this breaks sync iterables of promises: the loop
        // variable is no longer awaited.
        vec![RuleSuggestion {
            message: convert_to_ordinary_for_message(),
            fixes: vec![RuleFix::remove_range(get_await_token_removal_range(
                ctx.source_file,
                await_modifier.pos(),
            ))],
        }]
    });
}

fn check_await_using(ctx: &mut RuleContext<'_>, node: Node) {
    if !is_var_await_using(node) {
        return;
    }
    let declarations = node.declarations().nodes();
    for declarator in declarations {
        let initializer = declarator.initializer();
        if initializer.is_nil() {
            continue;
        }
        let initializer_type = ctx.checker.get_type_at_location(initializer);
        if is_type_any_type(ctx.checker, initializer_type)
            || has_well_known_symbol_part(ctx.checker, initializer_type, "asyncDispose")
        {
            continue;
        }
        // With several declarators (`await using a = b, c = d`) the user
        // decides what to do.
        let single = declarations.len() == 1;
        let range = ctx.trim_node_text_range(initializer);
        let report = Report::new(range, await_using_of_non_async_disposable_message())
            .with_label("This value is not async disposable", range);
        ctx.report_diagnostic_with_suggestions(report, |ctx| {
            if !single {
                return Vec::new();
            }
            vec![RuleSuggestion {
                message: remove_await_message(),
                fixes: vec![RuleFix::remove_range(get_await_token_removal_range(
                    ctx.source_file,
                    node.pos(),
                ))],
            }]
        });
    }
}

fn has_well_known_symbol_part(c: &mut Checker, t: TypeId, name: &str) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .any(|part| get_well_known_symbol_property_of_type(c, part, name).is_some())
}

fn is_promise_aggregator_method(c: &mut Checker, call: Node) -> bool {
    let callee = skip_parentheses(call.expression());
    if !is_access_expression(callee) {
        return false;
    }
    let (method_name, found) = c.get_accessed_property_name(callee);
    if !found || !PROMISE_AGGREGATOR_METHODS.contains(&method_name.as_str()) {
        return false;
    }
    let object_type = get_constrained_type_at_location(c, callee.expression());
    is_promise_constructor_like(c, object_type)
}

fn is_invalid_promise_aggregator_input(c: &mut Checker, node: Node, t: TypeId) -> bool {
    if !is_iterable(c, t) {
        return false;
    }
    union_type_parts(c, t).into_iter().any(|part| {
        value_types_of_array_like(c, part)
            .into_iter()
            .any(|value_type| contains_non_awaitable_type(c, node, value_type))
    })
}

fn value_types_of_array_like(c: &mut Checker, t: TypeId) -> Vec<TypeId> {
    if c.is_tuple_type(t) {
        return c.get_type_arguments(t).to_vec();
    }
    let number_index_type = get_number_index_type(c, t);
    if number_index_type.is_some() {
        return vec![number_index_type];
    }
    c.get_type_arguments(t)
        .first()
        .copied()
        .into_iter()
        .collect()
}

fn is_never_awaitable(c: &mut Checker, node: Node, t: TypeId) -> bool {
    needs_to_be_awaited(c, node, t) == TypeAwaitable::Never
}

fn is_always_non_awaitable_type(c: &mut Checker, node: Node, t: TypeId) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .all(|part| is_never_awaitable(c, node, part))
}

fn contains_non_awaitable_type(c: &mut Checker, node: Node, t: TypeId) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .any(|part| is_never_awaitable(c, node, part))
}

fn is_iterable(c: &mut Checker, t: TypeId) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .all(|part| get_well_known_symbol_property_of_type(c, part, "iterator").is_some())
}
