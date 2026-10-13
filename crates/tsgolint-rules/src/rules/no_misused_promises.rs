//! `no-misused-promises`: disallows promises in places that do not handle
//! them: conditionals, void-returning callbacks and object spreads.

use goport_core::ast::{
    TextRange, get_source_file_of_node, is_arrow_function, is_assignment_expression,
    is_big_int_literal, is_binary_expression, is_call_expression, is_computed_property_name,
    is_function_like, is_identifier, is_logical_expression, is_method_declaration,
    is_numeric_literal, is_object_literal_expression, is_private_identifier,
    is_property_assignment, is_shorthand_property_assignment, is_static, is_string_literal,
    skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{ContextFlags, TypeFlags};
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_call_signatures, get_construct_signatures, get_function_head_loc, get_heritage_clauses,
    is_array_method_call_with_predicate, is_function_param, is_rest_parameter_declaration,
    is_thenable_type, is_type_flag_set, some_union_type_part, trim_node_text_range,
    union_type_parts, visit_union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-misused-promises",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    checks_conditionals: bool,
    checks_spreads: bool,
    /// A boolean or a `ChecksVoidReturnOptions` object.
    checks_void_return: Value,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            checks_conditionals: true,
            checks_spreads: true,
            checks_void_return: Value::Bool(true),
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ChecksVoidReturnOptions {
    arguments: bool,
    attributes: bool,
    inherited_methods: bool,
    properties: bool,
    returns: bool,
    variables: bool,
}

impl Default for ChecksVoidReturnOptions {
    fn default() -> Self {
        Self {
            arguments: true,
            attributes: true,
            inherited_methods: true,
            properties: true,
            returns: true,
            variables: true,
        }
    }
}

/// The void-return checks that `checksVoidReturn` turns on, or `None` when
/// they are all off.
fn checks_void_return_options(value: &Value) -> Option<ChecksVoidReturnOptions> {
    match value {
        Value::Bool(true) => Some(ChecksVoidReturnOptions::default()),
        // tsgolint falls back to the defaults when the object does not decode.
        Value::Object(_) => {
            Some(ChecksVoidReturnOptions::deserialize(value.clone()).unwrap_or_default())
        }
        // `false`, and values of another shape, which tsgolint ignores.
        _ => None,
    }
}

fn conditional_message() -> RuleMessage {
    RuleMessage::new(
        "conditional",
        "Expected non-Promise value in a boolean conditional.",
    )
}

fn predicate_message() -> RuleMessage {
    RuleMessage::new("predicate", "Expected a non-Promise value to be returned.")
}

fn spread_message() -> RuleMessage {
    RuleMessage::new(
        "spread",
        "Expected a non-Promise value to be spread in an object.",
    )
}

fn void_return_argument_message() -> RuleMessage {
    RuleMessage::new(
        "voidReturnArgument",
        "Promise returned in function argument where a void return was expected.",
    )
}

fn void_return_attribute_message() -> RuleMessage {
    RuleMessage::new(
        "voidReturnAttribute",
        "Promise-returning function provided to attribute where a void return was expected.",
    )
}

fn void_return_inherited_method_message(heritage_type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "voidReturnInheritedMethod",
        format!(
            "Promise-returning method provided where a void return was expected by extended/implemented type '{heritage_type_name}'."
        ),
    )
}

fn void_return_property_message() -> RuleMessage {
    RuleMessage::new(
        "voidReturnProperty",
        "Promise-returning function provided to property where a void return was expected.",
    )
}

fn void_return_return_value_message() -> RuleMessage {
    RuleMessage::new(
        "voidReturnReturnValue",
        "Promise-returning function provided to return value where a void return was expected.",
    )
}

fn void_return_variable_message() -> RuleMessage {
    RuleMessage::new(
        "voidReturnVariable",
        "Promise-returning function provided to variable where a void return was expected.",
    )
}

struct State {
    checks_conditionals: bool,
    void_return: Option<ChecksVoidReturnOptions>,
    /// Conditions already checked, so that nested listeners skip them.
    checked_nodes: FxHashSet<Node>,
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let void_return = checks_void_return_options(&options.checks_void_return);
    let checks_conditionals = options.checks_conditionals;

    let mut listeners = Listeners::new(State {
        checks_conditionals,
        void_return,
        checked_nodes: FxHashSet::default(),
    })
    .on(SyntaxKind::BinaryExpression, |state, ctx, node| {
        if state.checks_conditionals {
            check_conditional(state, ctx, node, false);
        }
        if state.void_return.as_ref().is_some_and(|v| v.variables)
            && is_assignment_expression(node, false)
        {
            check_assignment(ctx, node);
        }
    });

    if checks_conditionals {
        listeners = listeners
            .on(SyntaxKind::PropertyAccessExpression, check_array_predicates)
            .on(SyntaxKind::ElementAccessExpression, check_array_predicates)
            .on(SyntaxKind::PrefixUnaryExpression, |state, ctx, node| {
                if node.operator() == SyntaxKind::ExclamationToken {
                    check_conditional(state, ctx, node.operand(), true);
                }
            })
            .on(SyntaxKind::ConditionalExpression, |state, ctx, node| {
                check_conditional(state, ctx, node.condition(), true);
            })
            .on(SyntaxKind::ForStatement, |state, ctx, node| {
                check_conditional(state, ctx, node.condition(), true);
            })
            .on(SyntaxKind::DoStatement, check_statement_condition)
            .on(SyntaxKind::WhileStatement, check_statement_condition)
            .on(SyntaxKind::IfStatement, check_statement_condition);
    }

    if let Some(void_return) = &void_return {
        if void_return.arguments {
            listeners = listeners
                .on(SyntaxKind::CallExpression, |_, ctx, node| {
                    check_arguments(ctx, node)
                })
                .on(SyntaxKind::NewExpression, |_, ctx, node| {
                    check_arguments(ctx, node)
                });
        }
        if void_return.attributes {
            listeners = listeners.on(SyntaxKind::JsxAttribute, |_, ctx, node| {
                check_jsx_attribute(ctx, node);
            });
        }
        if void_return.inherited_methods {
            listeners = listeners
                .on(SyntaxKind::ClassDeclaration, check_class_like_or_interface)
                .on(SyntaxKind::ClassExpression, check_class_like_or_interface)
                .on(
                    SyntaxKind::InterfaceDeclaration,
                    check_class_like_or_interface,
                );
        }
        if void_return.properties {
            listeners = listeners
                .on(SyntaxKind::PropertyAssignment, check_property)
                .on(SyntaxKind::MethodDeclaration, check_property)
                .on(SyntaxKind::ShorthandPropertyAssignment, check_property);
        }
        if void_return.returns {
            listeners = listeners.on(SyntaxKind::ReturnStatement, |_, ctx, node| {
                check_return_statement(ctx, node);
            });
        }
        if void_return.variables {
            listeners = listeners.on(SyntaxKind::VariableDeclaration, |_, ctx, node| {
                check_variable_declaration(ctx, node);
            });
        }
    }

    if options.checks_spreads {
        listeners = listeners
            .on(SyntaxKind::SpreadElement, |_, ctx, node| {
                check_spread(ctx, node)
            })
            .on(SyntaxKind::SpreadAssignment, |_, ctx, node| {
                check_spread(ctx, node)
            });
    }

    listeners.into()
}

// Types

/// Some call signature of `t` returns a thenable.
fn any_signature_is_thenable_type(checker: &mut Checker, node: Node, t: TypeId) -> bool {
    get_call_signatures(checker, t).iter().any(|&signature| {
        let return_type = checker.get_return_type_of_signature(signature);
        is_thenable_type(checker, node, return_type)
    })
}

/// `node` is a function that returns a thenable.
fn returns_thenable(checker: &mut Checker, node: Node) -> bool {
    let node_type = checker.get_type_at_location(node);
    let t = checker.get_apparent_type(node_type);
    union_type_parts(checker, t)
        .iter()
        .any(|&part| any_signature_is_thenable_type(checker, node, part))
}

fn is_thenable_returning_function_type(checker: &mut Checker, node: Node, t: TypeId) -> bool {
    some_union_type_part(checker, t, |checker, part| {
        any_signature_is_thenable_type(checker, node, part)
    })
}

/// Some call signature of `t` returns `void` and none returns a thenable.
fn is_void_returning_function_type(checker: &mut Checker, node: Node, t: TypeId) -> bool {
    let mut had_void_return = false;
    let no_thenable = visit_union_type_parts(checker, t, |checker, part| {
        for signature in get_call_signatures(checker, part) {
            let return_type = checker.get_return_type_of_signature(signature);
            // A position that accepts both thenable and void returns takes a
            // promise-returning function.
            if is_thenable_type(checker, node, return_type) {
                return false;
            }
            had_void_return =
                had_void_return || is_type_flag_set(checker, return_type, TypeFlags::VOID);
        }
        true
    });
    no_thenable && had_void_return
}

/// Every union member of the type of `node` is thenable, unlike
/// `is_thenable_type`, so that `promise | undefined` checks pass.
fn is_always_thenable(checker: &mut Checker, node: Node) -> bool {
    let node_type = checker.get_type_at_location(node);
    let apparent = checker.get_apparent_type(node_type);
    for part in union_type_parts(checker, apparent) {
        let then = checker.get_property_of_type(part, "then");
        if then.is_nil() {
            return false;
        }
        let then_type = checker.get_type_of_symbol_at_location(then, node);
        let mut has_thenable_signature = false;
        for then_part in union_type_parts(checker, then_type) {
            for signature in get_call_signatures(checker, then_part) {
                let first = checker.sig(signature).parameters().first().copied();
                if first.is_some_and(|param| is_function_param(checker, param, node)) {
                    has_thenable_signature = true;
                }
            }
            if has_thenable_signature {
                break;
            }
        }
        if !has_thenable_signature {
            return false;
        }
    }
    true
}

/// The member of `t`'s symbol named `name`, else the property of `t`.
fn get_member_if_exists(checker: &mut Checker, t: TypeId, name: &str) -> SymbolId {
    let symbol = checker.ty(t).symbol;
    if symbol.is_some() {
        let members = checker.sym(symbol).members;
        let member = checker.symbols.get(members, name);
        if member.is_some() {
            return member;
        }
    }
    checker.get_property_of_type(t, name)
}

// Diagnostics

/// Where a `void`-returning callback is expected: a declaration in this file
/// and its type.
#[derive(Clone, Copy)]
struct VoidExpectation {
    declaration: Node,
    t: TypeId,
}

fn local_expectation_for_declaration(
    ctx: &RuleContext<'_>,
    declaration: Node,
    t: TypeId,
) -> Option<VoidExpectation> {
    (declaration.is_some() && get_source_file_of_node(declaration) == ctx.source_file)
        .then_some(VoidExpectation { declaration, t })
}

fn local_expectation_for_symbol(
    ctx: &RuleContext<'_>,
    symbol: SymbolId,
    t: TypeId,
) -> Option<VoidExpectation> {
    if symbol.is_nil() {
        return None;
    }
    let data = ctx.checker.sym(symbol);
    std::iter::once(data.value_declaration)
        .filter(|declaration| declaration.is_some())
        .chain(data.declarations.iter().copied())
        .find_map(|declaration| local_expectation_for_declaration(ctx, declaration, t))
}

fn expectation_range(source_file: Node, expectation: VoidExpectation) -> TextRange {
    let declaration = expectation.declaration;
    let type_node = declaration.type_();
    if type_node.is_some() {
        return trim_node_text_range(source_file, type_node);
    }
    let name = declaration.name();
    if name.is_some() {
        return trim_node_text_range(source_file, name);
    }
    trim_node_text_range(source_file, declaration)
}

/// The return type of a function, its `=>` or its head; else the node.
fn promise_range(source_file: Node, node: Node) -> TextRange {
    let node = skip_parentheses(node);
    if !is_function_like(node) {
        return trim_node_text_range(source_file, node);
    }
    let type_node = node.type_();
    if type_node.is_some() {
        return trim_node_text_range(source_file, type_node);
    }
    if is_arrow_function(node) {
        return trim_node_text_range(source_file, node.equals_greater_than_token());
    }
    get_function_head_loc(source_file, node)
}

fn build_report(
    ctx: &mut RuleContext<'_>,
    node: Node,
    range: TextRange,
    message: RuleMessage,
    expectation: Option<VoidExpectation>,
) -> Report {
    let t = ctx.checker.get_type_at_location(node);
    let is_callback =
        is_function_like(skip_parentheses(node)) || !get_call_signatures(ctx.checker, t).is_empty();
    let description = if is_callback {
        "This callback"
    } else {
        "This expression"
    };
    let type_name = ctx.checker.type_to_string(t);
    let mut report = Report::new(range, message).with_label(
        format!("{description} has type `{type_name}`."),
        promise_range(ctx.source_file, node),
    );
    if let Some(expectation) = expectation
        && expectation.t.is_some()
    {
        let expected_name = ctx.checker.type_to_string(expectation.t);
        report = report.with_label(
            format!(
                "This context accepts a `void`-returning callback through type `{expected_name}`."
            ),
            expectation_range(ctx.source_file, expectation),
        );
    }
    report
}

fn report_node(
    ctx: &mut RuleContext<'_>,
    node: Node,
    message: RuleMessage,
    expectation: Option<VoidExpectation>,
) {
    let range = promise_range(ctx.source_file, node);
    let report = build_report(ctx, node, range, message, expectation);
    ctx.report_diagnostic(report);
}

// Conditionals

fn check_statement_condition(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    check_conditional(state, ctx, node.expression(), true);
}

fn check_conditional(
    state: &mut State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    is_test_expression: bool,
) {
    if node.is_nil() || is_assignment_expression(node, false) {
        return;
    }
    if !state.checked_nodes.insert(node) {
        return;
    }
    let node = skip_parentheses(node);
    if is_binary_expression(node) && is_logical_expression(node) {
        // Outside a test, the left of `??` and the right of any logical
        // operator are not conditions.
        if node.operator_token().kind() != SyntaxKind::QuestionQuestionToken || is_test_expression {
            check_conditional(state, ctx, node.left(), is_test_expression);
        }
        if is_test_expression {
            check_conditional(state, ctx, node.right(), is_test_expression);
        }
        return;
    }
    if is_always_thenable(ctx.checker, node) {
        report_node(ctx, node, conditional_message(), None);
    }
}

/// `node` is the callee or an argument of `array.filter(...)` and the like.
fn check_array_predicates(_: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let call = node.parent();
    if !is_call_expression(call) {
        return;
    }
    let Some(callback) = call.arguments().first() else {
        return;
    };
    if is_array_method_call_with_predicate(ctx.checker, call)
        && returns_thenable(ctx.checker, callback)
    {
        report_node(ctx, callback, predicate_message(), None);
    }
}

// Void returns

/// The argument positions of the void-returning positions.
#[derive(Default)]
struct ArgumentChecks {
    thenable_return_indices: Vec<usize>,
    void_return_indices: Vec<usize>,
    void_return_expectations: FxHashMap<usize, VoidExpectation>,
}

impl ArgumentChecks {
    fn check_argument(
        &mut self,
        ctx: &mut RuleContext<'_>,
        call: Node,
        t: TypeId,
        index: usize,
        parameter_declaration: Node,
        from_contextual_type: bool,
    ) {
        let callee = call.expression();
        if is_thenable_returning_function_type(ctx.checker, callee, t) {
            self.thenable_return_indices.push(index);
        } else if is_void_returning_function_type(ctx.checker, callee, t)
            && !self.thenable_return_indices.contains(&index)
        {
            self.void_return_indices.push(index);
            if let Some(expectation) =
                local_expectation_for_declaration(ctx, parameter_declaration, t)
                && (!from_contextual_type || !self.void_return_expectations.contains_key(&index))
            {
                self.void_return_expectations.insert(index, expectation);
            }
        }
        let contextual_type = ctx
            .checker
            .get_contextual_type_for_argument_at_index(call, index as i32);
        if contextual_type != t {
            self.check_argument(
                ctx,
                call,
                contextual_type,
                index,
                parameter_declaration,
                true,
            );
        }
    }
}

/// The positions of arguments that expect a void function and not also a
/// thenable function, with the declarations that expect it.
///
/// The resolved signature is not used: it prefers an early `() => void`
/// over a later `() => Promise<void>` (microsoft/TypeScript#48077). A rest
/// array parameter covers every trailing argument.
fn void_function_arguments(
    ctx: &mut RuleContext<'_>,
    call: Node,
) -> (Vec<usize>, FxHashMap<usize, VoidExpectation>) {
    // `new Foo` has no argument list.
    if call.argument_list().is_nil() {
        return (Vec::new(), FxHashMap::default());
    }
    let argument_count = call.arguments().len();
    let callee = call.expression();
    let mut checks = ArgumentChecks::default();
    let callee_type = ctx.checker.get_type_at_location(callee);
    for part in union_type_parts(ctx.checker, callee_type) {
        let signatures = if is_call_expression(call) {
            get_call_signatures(ctx.checker, part)
        } else {
            get_construct_signatures(ctx.checker, part)
        };
        for signature in signatures {
            let parameters = ctx.checker.sig(signature).parameters().to_vec();
            for (index, parameter) in parameters.into_iter().enumerate() {
                let declaration = ctx.checker.sym(parameter).value_declaration;
                let t = ctx
                    .checker
                    .get_type_of_symbol_at_location(parameter, callee);
                if declaration.is_nil() || !is_rest_parameter_declaration(declaration) {
                    checks.check_argument(ctx, call, t, index, declaration, false);
                } else if ctx.checker.is_array_type(t) {
                    // Check each trailing argument as a `param: Element`.
                    let element = ctx.checker.get_type_arguments(t)[0];
                    for i in index..argument_count {
                        checks.check_argument(ctx, call, element, i, declaration, false);
                    }
                } else if ctx.checker.is_tuple_type(t) {
                    let elements = ctx.checker.get_type_arguments(t);
                    for (i, &element) in (index..argument_count).zip(elements.iter()) {
                        checks.check_argument(ctx, call, element, i, declaration, false);
                    }
                }
            }
        }
    }

    let ArgumentChecks {
        thenable_return_indices,
        mut void_return_indices,
        mut void_return_expectations,
    } = checks;
    for index in thenable_return_indices {
        if let Some(at) = void_return_indices.iter().position(|&i| i == index) {
            void_return_indices.remove(at);
            void_return_expectations.remove(&index);
        }
    }
    (void_return_indices, void_return_expectations)
}

fn check_arguments(ctx: &mut RuleContext<'_>, call: Node) {
    let (void_arguments, expectations) = void_function_arguments(ctx, call);
    if void_arguments.is_empty() {
        return;
    }
    for (index, argument) in call.arguments().iter().enumerate() {
        if void_arguments.contains(&index) && returns_thenable(ctx.checker, argument) {
            report_node(
                ctx,
                argument,
                void_return_argument_message(),
                expectations.get(&index).copied(),
            );
        }
    }
}

fn check_jsx_attribute(ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() || initializer.kind() != SyntaxKind::JsxExpression {
        return;
    }
    let expression = initializer.expression();
    if expression.is_nil() {
        return;
    }
    let contextual_type = ctx
        .checker
        .get_contextual_type(initializer, ContextFlags::NONE);
    if contextual_type.is_nil()
        || !is_void_returning_function_type(ctx.checker, initializer, contextual_type)
        || !returns_thenable(ctx.checker, expression)
    {
        return;
    }
    let attributes_type = ctx
        .checker
        .get_contextual_type(node.parent(), ContextFlags::NONE);
    let expectation = if attributes_type.is_some() {
        let property = ctx
            .checker
            .get_property_of_type(attributes_type, node.name().text());
        local_expectation_for_symbol(ctx, property, contextual_type)
    } else {
        None
    };
    report_node(
        ctx,
        expression,
        void_return_attribute_message(),
        expectation,
    );
}

fn check_spread(ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    if !is_thenable_type(ctx.checker, expression, TypeId::NIL) {
        return;
    }
    let range = ctx
        .trim_node_text_range(node)
        .with_end(ctx.trim_node_text_range(expression).pos());
    let report = build_report(ctx, expression, range, spread_message(), None);
    ctx.report_diagnostic(report);
}

fn check_class_like_or_interface(_: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let heritage_clauses = get_heritage_clauses(node);
    if heritage_clauses.is_nil() || heritage_clauses.nodes().is_empty() {
        return;
    }
    let mut heritage_types: Option<Vec<TypeId>> = None;
    for member in node.members() {
        // Call, construct and index signatures have no name. TypeScript lets
        // call signatures mismatch, and construct signatures cannot be async.
        let name = member.name();
        if name.is_nil() {
            continue;
        }
        if !(is_identifier(name)
            || is_private_identifier(name)
            || is_string_literal(name)
            || is_numeric_literal(name)
            || is_big_int_literal(name))
        {
            continue;
        }
        let member_name = name.text();
        if is_static(member) || !returns_thenable(ctx.checker, member) {
            continue;
        }
        let heritage_types = heritage_types.get_or_insert_with(|| {
            heritage_clauses
                .nodes()
                .iter()
                .flat_map(|clause| clause.types().nodes())
                .map(|type_node| ctx.checker.get_type_at_location(type_node))
                .collect()
        });
        for &heritage_type in heritage_types.iter() {
            check_heritage_type_for_member_returning_void(ctx, member, heritage_type, member_name);
        }
    }
}

/// Reports `member` when `heritage_type` has a void-returning member of the
/// same name.
fn check_heritage_type_for_member_returning_void(
    ctx: &mut RuleContext<'_>,
    member: Node,
    heritage_type: TypeId,
    member_name: &str,
) {
    let heritage_member = get_member_if_exists(ctx.checker, heritage_type, member_name);
    if heritage_member.is_nil() {
        return;
    }
    let member_type = ctx
        .checker
        .get_type_of_symbol_at_location(heritage_member, member);
    if !is_void_returning_function_type(ctx.checker, member, member_type) {
        return;
    }
    let message = void_return_inherited_method_message(&ctx.checker.type_to_string(heritage_type));
    let expectation = local_expectation_for_symbol(ctx, heritage_member, member_type);
    report_node(ctx, member, message, expectation);
}

/// The property of the contextual type of the object literal around
/// `property`.
fn local_property_expectation(
    ctx: &mut RuleContext<'_>,
    property: Node,
    t: TypeId,
) -> Option<VoidExpectation> {
    let name = property.name();
    if name.is_nil() || !is_object_literal_expression(property.parent()) {
        return None;
    }
    let object_type = ctx
        .checker
        .get_contextual_type(property.parent(), ContextFlags::NONE);
    if object_type.is_nil() {
        return None;
    }
    let property_symbol = ctx.checker.get_property_of_type(object_type, name.text());
    local_expectation_for_symbol(ctx, property_symbol, t)
}

fn check_property(_: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if is_property_assignment(node) {
        let initializer = node.initializer();
        let contextual_type = ctx
            .checker
            .get_contextual_type(initializer, ContextFlags::NONE);
        if contextual_type.is_some()
            && is_void_returning_function_type(ctx.checker, initializer, contextual_type)
            && returns_thenable(ctx.checker, initializer)
        {
            let expectation = local_property_expectation(ctx, node, contextual_type);
            report_node(
                ctx,
                initializer,
                void_return_property_message(),
                expectation,
            );
        }
    } else if is_shorthand_property_assignment(node) {
        let name = node.name();
        let contextual_type = ctx.checker.get_contextual_type(name, ContextFlags::NONE);
        if contextual_type.is_some()
            && is_void_returning_function_type(ctx.checker, name, contextual_type)
            && returns_thenable(ctx.checker, name)
        {
            let expectation = local_property_expectation(ctx, node, contextual_type);
            report_node(ctx, name, void_return_property_message(), expectation);
        }
    } else if is_method_declaration(node) {
        let name = node.name();
        if is_computed_property_name(name) {
            return;
        }
        // Class methods are checked as inherited methods.
        let object = node.parent();
        if !is_object_literal_expression(object) || !returns_thenable(ctx.checker, node) {
            return;
        }
        let object_type = ctx.checker.get_contextual_type(object, ContextFlags::NONE);
        if object_type.is_nil() {
            return;
        }
        let property = ctx.checker.get_property_of_type(object_type, name.text());
        if property.is_nil() {
            return;
        }
        let contextual_type = ctx.checker.get_type_of_symbol_at_location(property, name);
        if is_void_returning_function_type(ctx.checker, name, contextual_type) {
            let expectation = local_expectation_for_symbol(ctx, property, contextual_type);
            report_node(ctx, node, void_return_property_message(), expectation);
        }
    }
}

/// A syntactic test of whether a type annotation may be a function type, to
/// avoid type lookups.
fn is_possibly_function_type(node: Node) -> bool {
    match node.kind() {
        SyntaxKind::ConditionalType
        | SyntaxKind::ConstructorType
        | SyntaxKind::FunctionType
        | SyntaxKind::ImportType
        | SyntaxKind::IndexedAccessType
        | SyntaxKind::InferType
        | SyntaxKind::IntersectionType
        | SyntaxKind::QualifiedName
        | SyntaxKind::ThisType
        | SyntaxKind::TypeOperator
        | SyntaxKind::TypeQuery
        | SyntaxKind::TypeReference
        | SyntaxKind::UnionType => true,
        SyntaxKind::TypeLiteral => node.members().iter().any(|member| {
            matches!(
                member.kind(),
                SyntaxKind::CallSignature | SyntaxKind::ConstructSignature
            )
        }),
        _ => false,
    }
}

fn check_return_statement(ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    if expression.is_nil() {
        return;
    }
    let mut function = node.parent();
    while function.is_some() && !is_function_like(function) {
        function = function.parent();
    }
    let return_type_node = if function.is_some() {
        function.type_()
    } else {
        Node::NIL
    };
    if return_type_node.is_some() && !is_possibly_function_type(return_type_node) {
        return;
    }

    let contextual_type = ctx
        .checker
        .get_contextual_type(expression, ContextFlags::NONE);
    if contextual_type.is_nil()
        || !is_void_returning_function_type(ctx.checker, expression, contextual_type)
        || !returns_thenable(ctx.checker, expression)
    {
        return;
    }
    let expectation = if return_type_node.is_some() {
        Some(VoidExpectation {
            declaration: function,
            t: contextual_type,
        })
    } else if function.is_some() {
        // A function can have no contextual type of its own, such as a
        // getter typed by the parameter of its setter.
        let function_type = ctx
            .checker
            .get_contextual_type(function, ContextFlags::NONE);
        if function_type.is_some() {
            get_call_signatures(ctx.checker, function_type)
                .iter()
                .find_map(|&signature| {
                    let declaration = ctx.checker.sig(signature).declaration();
                    local_expectation_for_declaration(ctx, declaration, contextual_type)
                })
        } else {
            None
        }
    } else {
        None
    };
    report_node(
        ctx,
        expression,
        void_return_return_value_message(),
        expectation,
    );
}

fn check_assignment(ctx: &mut RuleContext<'_>, node: Node) {
    let left = node.left();
    let right = node.right();
    let variable_type = ctx.checker.get_type_at_location(left);
    if !is_void_returning_function_type(ctx.checker, left, variable_type)
        || !returns_thenable(ctx.checker, right)
    {
        return;
    }
    let mut symbol = ctx.checker.get_symbol_at_location_exported(left);
    if symbol.is_nil() && left.name().is_some() {
        symbol = ctx.checker.get_symbol_at_location_exported(left.name());
    }
    let expectation = local_expectation_for_symbol(ctx, symbol, variable_type);
    report_node(ctx, right, void_return_variable_message(), expectation);
}

fn check_variable_declaration(ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    let type_node = node.type_();
    if initializer.is_nil() || type_node.is_nil() || !is_possibly_function_type(type_node) {
        return;
    }
    let variable_type = ctx.checker.get_type_at_location(node.name());
    if !is_void_returning_function_type(ctx.checker, initializer, variable_type)
        || !returns_thenable(ctx.checker, initializer)
    {
        return;
    }
    let expectation = VoidExpectation {
        declaration: node,
        t: variable_type,
    };
    report_node(
        ctx,
        initializer,
        void_return_variable_message(),
        Some(expectation),
    );
}
