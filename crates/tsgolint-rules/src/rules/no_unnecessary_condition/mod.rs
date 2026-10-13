//! `no-unnecessary-condition`: flags conditions that are always truthy,
//! always falsy or always nullish according to their types, comparisons
//! between literals, and `?.` or `??` on values that are never nullish.

mod optional_chain;
mod resolve;
mod types;

use goport_core::ast::{
    TextRange, get_source_file_of_node, get_text_of_property_name, is_assignment_target,
    is_binary_expression, is_logical_expression, is_parenthesized_expression, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{AccessFlags, CheckMode, TypeFlags, TypePredicateKind};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use self::optional_chain::check_optional_chain;
use self::resolve::{
    constrain_indexed_access_type, get_resolved_type, has_optional_chain,
    is_array_index_expression, is_element_access, is_nullable_element_access_expression,
};
use self::types::{
    Truthiness, check_type_condition, is_always_nullish_type, is_conditional_always_necessary,
    is_nullish_type, is_static_value, is_true_literal_type, truncate_type_name,
};
use crate::utils::{
    get_constrained_type_at_location, is_array_method_call_with_predicate, is_intersection_type,
    is_type_flag_set, is_union_type, require_strict_null_checks, trim_node_text_range,
    union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-condition",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    /// A boolean or a string; tsgolint accepts any JSON value here.
    allow_constant_loop_conditions: Value,
    check_type_predicates: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LoopConditions {
    Never,
    Always,
    OnlyAllowedLiterals,
}

impl LoopConditions {
    /// `true` is `"always"`; an unknown string, `false` or another value is
    /// `"never"`.
    fn from_option(value: &Value) -> Self {
        match value {
            Value::String(mode) if mode == "always" => Self::Always,
            Value::String(mode) if mode == "only-allowed-literals" => Self::OnlyAllowedLiterals,
            Value::Bool(true) => Self::Always,
            _ => Self::Never,
        }
    }
}

struct State {
    check_type_predicates: bool,
    loop_conditions: LoopConditions,
    strict_null_checks: bool,
    no_unchecked_indexed_access: bool,
}

fn always_truthy_message() -> RuleMessage {
    RuleMessage::new(
        "alwaysTruthy",
        "Unnecessary conditional, value is always truthy.",
    )
}

fn always_falsy_message() -> RuleMessage {
    RuleMessage::new(
        "alwaysFalsy",
        "Unnecessary conditional, value is always falsy.",
    )
}

fn never_message() -> RuleMessage {
    RuleMessage::new("never", "Unnecessary conditional, value is `never`.")
}

fn always_truthy_func_message() -> RuleMessage {
    RuleMessage::new(
        "alwaysTruthyFunc",
        "This callback should return a conditional, but return is always truthy.",
    )
}

fn always_falsy_func_message() -> RuleMessage {
    RuleMessage::new(
        "alwaysFalsyFunc",
        "This callback should return a conditional, but return is always falsy.",
    )
}

fn never_nullish_message() -> RuleMessage {
    RuleMessage::new(
        "neverNullish",
        "Unnecessary conditional, expected left-hand side of `??` operator to be possibly null or undefined.",
    )
}

fn never_optional_chain_message() -> RuleMessage {
    RuleMessage::new(
        "neverOptionalChain",
        "Unnecessary optional chain on a non-nullish value.",
    )
}

fn suggest_remove_optional_chain_message() -> RuleMessage {
    RuleMessage::new(
        "suggestRemoveOptionalChain",
        "Remove unnecessary optional chain",
    )
}
fn literal_binary_expression_message() -> RuleMessage {
    RuleMessage::new(
        "comparisonBetweenLiteralTypes",
        "Unnecessary comparison between literal values.",
    )
}

fn no_overlap_message() -> RuleMessage {
    RuleMessage::new(
        "noOverlapBooleanExpression",
        "This condition will always return the same value since the types have no overlap.",
    )
}

fn always_nullish_message() -> RuleMessage {
    RuleMessage::new(
        "alwaysNullish",
        "Unnecessary conditional, value is always nullish.",
    )
}

fn type_guard_already_is_type_message() -> RuleMessage {
    RuleMessage::new(
        "typeGuardAlreadyIsType",
        "Type predicate is unnecessary as the parameter type already satisfies the predicate.",
    )
}

/// A report with a `Type: <name>` label on `type_range`, or no label when
/// the name is empty.
fn typed_value_report(
    message: RuleMessage,
    primary: TextRange,
    type_range: TextRange,
    type_name: String,
) -> Report {
    let report = Report::new(primary, message);
    if type_name.is_empty() {
        report
    } else {
        report.with_label(format!("Type: {type_name}"), type_range)
    }
}

/// Like [`typed_value_report`], with a `Return type: <name>` label.
fn typed_return_report(
    message: RuleMessage,
    primary: TextRange,
    type_range: TextRange,
    type_name: String,
) -> Report {
    let report = Report::new(primary, message);
    if type_name.is_empty() {
        report
    } else {
        report.with_label(format!("Return type: {type_name}"), type_range)
    }
}

fn type_guard_report(
    primary: TextRange,
    type_range: TextRange,
    value_type: &str,
    predicate_type: &str,
) -> Report {
    Report::new(primary, type_guard_already_is_type_message()).with_label(
        format!("Type {value_type} already satisfies predicate type {predicate_type}"),
        type_range,
    )
}

fn comparison_report(
    message: RuleMessage,
    primary: TextRange,
    left_type: &str,
    left_range: TextRange,
    right_type: &str,
    right_range: TextRange,
) -> Report {
    Report::new(primary, message)
        .with_label(format!("Type: {left_type}"), left_range)
        .with_label(format!("Type: {right_type}"), right_range)
}

fn type_name(c: &mut Checker, t: TypeId) -> String {
    truncate_type_name(c.type_to_string(t))
}

/// A literal whose type the label would only repeat.
fn is_self_explanatory_literal(node: Node) -> bool {
    node.is_some()
        && matches!(
            skip_parentheses(node).kind(),
            SyntaxKind::TrueKeyword
                | SyntaxKind::FalseKeyword
                | SyntaxKind::NullKeyword
                | SyntaxKind::NumericLiteral
                | SyntaxKind::BigIntLiteral
                | SyntaxKind::StringLiteral
                | SyntaxKind::NoSubstitutionTemplateLiteral
        )
}

/// The type name for the label of `node`, empty for a self-explanatory
/// literal.
fn type_name_for_node(c: &mut Checker, t: TypeId, node: Node) -> String {
    if is_self_explanatory_literal(node) {
        String::new()
    } else {
        type_name(c, t)
    }
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let strict_null_checks = require_strict_null_checks(ctx);
    let compiler_options = ctx.compiler_options();
    let state = State {
        check_type_predicates: options.check_type_predicates,
        loop_conditions: LoopConditions::from_option(&options.allow_constant_loop_conditions),
        strict_null_checks,
        no_unchecked_indexed_access: compiler_options.no_unchecked_indexed_access.is_true(),
    };
    Listeners::new(state)
        .on(SyntaxKind::IfStatement, |st, ctx, node| {
            check_condition(st, ctx, node.expression());
        })
        .on(SyntaxKind::WhileStatement, |st, ctx, node| {
            check_loop_condition(st, ctx, node.expression());
        })
        .on(SyntaxKind::DoStatement, |st, ctx, node| {
            check_loop_condition(st, ctx, node.expression());
        })
        .on(SyntaxKind::ForStatement, |st, ctx, node| {
            check_loop_condition(st, ctx, node.condition());
        })
        .on(SyntaxKind::ConditionalExpression, |st, ctx, node| {
            check_condition(st, ctx, node.condition());
        })
        .on(SyntaxKind::BinaryExpression, check_binary_expression)
        .on(SyntaxKind::PropertyAccessExpression, |st, ctx, node| {
            check_optional_chain(st, ctx, node);
        })
        .on(SyntaxKind::ElementAccessExpression, |st, ctx, node| {
            check_optional_chain(st, ctx, node);
        })
        .on(SyntaxKind::CallExpression, check_call_expression)
        .on(SyntaxKind::CaseClause, check_case_clause)
        .into()
}

fn check_binary_expression(st: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let (left, right) = (node.left(), node.right());
    match node.operator_token().kind() {
        SyntaxKind::QuestionQuestionToken | SyntaxKind::QuestionQuestionEqualsToken => {
            check_node_for_nullish(st, ctx, left);
        }
        SyntaxKind::AmpersandAmpersandToken
        | SyntaxKind::BarBarToken
        | SyntaxKind::AmpersandAmpersandEqualsToken
        | SyntaxKind::BarBarEqualsToken => check_condition(st, ctx, left),
        operator @ (SyntaxKind::LessThanToken
        | SyntaxKind::GreaterThanToken
        | SyntaxKind::LessThanEqualsToken
        | SyntaxKind::GreaterThanEqualsToken
        | SyntaxKind::EqualsEqualsToken
        | SyntaxKind::EqualsEqualsEqualsToken
        | SyntaxKind::ExclamationEqualsToken
        | SyntaxKind::ExclamationEqualsEqualsToken) => {
            check_comparison(st, ctx, node, left, right, operator);
        }
        _ => {}
    }
}

fn check_case_clause(st: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    let parent = node.parent();
    if expression.is_nil()
        || parent.is_nil()
        || parent.parent().is_nil()
        || parent.parent().kind() != SyntaxKind::SwitchStatement
    {
        return;
    }
    let switch_expression = parent.parent().expression();
    check_comparison(
        st,
        ctx,
        expression,
        switch_expression,
        expression,
        SyntaxKind::EqualsEqualsEqualsToken,
    );
}

/// `argument` is the argument that an `asserts x` function (no type)
/// asserts, with `checkTypePredicates` on.
fn is_assertion_argument(st: &State, c: &mut Checker, argument: Node) -> bool {
    let call = argument.parent();
    if !st.check_type_predicates || call.is_nil() || call.kind() != SyntaxKind::CallExpression {
        return false;
    }
    let Some(argument_index) = call
        .arguments()
        .iter()
        .take_while(|arg| arg.kind() != SyntaxKind::SpreadElement)
        .position(|arg| arg == argument)
    else {
        return false;
    };
    let signature = c.get_resolved_signature(call, None, CheckMode::NORMAL);
    if signature.is_nil() {
        return false;
    }
    let predicate = c.get_type_predicate_of_signature(signature);
    if predicate.is_nil() {
        return false;
    }
    let predicate = c.pred(predicate);
    predicate.kind == TypePredicateKind::ASSERTS_IDENTIFIER
        && predicate.t.is_nil()
        && usize::try_from(predicate.parameter_index) == Ok(argument_index)
}

/// The value of `node` is only tested for truthiness by the code around it
/// (a condition, `!`, the left of `&&`, or an asserted argument).
fn is_only_used_for_truthiness(st: &State, c: &mut Checker, mut node: Node) -> bool {
    let mut parent = node.parent();
    while parent.is_some() && is_parenthesized_expression(parent) {
        node = parent;
        parent = parent.parent();
    }
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        SyntaxKind::ConditionalExpression | SyntaxKind::ForStatement => parent.condition() == node,
        SyntaxKind::DoStatement | SyntaxKind::IfStatement | SyntaxKind::WhileStatement => {
            parent.expression() == node
        }
        SyntaxKind::PrefixUnaryExpression => parent.operator() == SyntaxKind::ExclamationToken,
        SyntaxKind::CallExpression => is_assertion_argument(st, c, node),
        _ if is_logical_expression(parent) => {
            (parent.operator_token().kind() == SyntaxKind::AmpersandAmpersandToken
                && parent.left() == node)
                || is_only_used_for_truthiness(st, c, parent)
        }
        _ => false,
    }
}

/// Reports a condition whose type is `never`, always truthy or always
/// falsy.
fn check_condition(st: &State, ctx: &mut RuleContext<'_>, expression: Node) {
    check_node(st, ctx, expression, false, expression);
}

/// [`check_condition`] of `expression`, reported at `report_node`, which
/// stays the same across the `!` operators that this function unwraps.
fn check_node(
    st: &State,
    ctx: &mut RuleContext<'_>,
    expression: Node,
    is_unary_not_argument: bool,
    report_node: Node,
) {
    if expression.is_nil() {
        return;
    }
    let expression = skip_parentheses(expression);

    if expression.kind() == SyntaxKind::PrefixUnaryExpression
        && expression.operator() == SyntaxKind::ExclamationToken
    {
        check_node(
            st,
            ctx,
            expression.operand(),
            !is_unary_not_argument,
            report_node,
        );
        return;
    }

    let c = &mut *ctx.checker;
    if !st.no_unchecked_indexed_access && is_array_index_expression(c, expression) {
        return;
    }

    if expression.kind() == SyntaxKind::BinaryExpression
        && matches!(
            expression.operator_token().kind(),
            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
        )
    {
        if is_only_used_for_truthiness(st, c, expression) {
            check_condition(st, ctx, expression.right());
        }
        return;
    }

    let mut node_type = get_resolved_type(c, expression);
    if node_type.is_nil() || is_conditional_always_necessary(c, node_type) {
        return;
    }
    if is_element_access(expression) && is_type_flag_set(c, node_type, TypeFlags::INDEXED_ACCESS) {
        let base_type = get_resolved_type(c, expression.expression());
        if base_type.is_some() {
            let string_index_type = c.get_string_index_type(base_type);
            if string_index_type.is_some() {
                node_type = string_index_type;
            }
        }
    }

    let message = if is_type_flag_set(c, node_type, TypeFlags::NEVER) {
        never_message()
    } else {
        // A `!` swaps truthy and falsy.
        match (check_type_condition(c, node_type), is_unary_not_argument) {
            (Truthiness::AlwaysFalsy, false) | (Truthiness::AlwaysTruthy, true) => {
                always_falsy_message()
            }
            (Truthiness::AlwaysFalsy, true) | (Truthiness::AlwaysTruthy, false) => {
                always_truthy_message()
            }
            (Truthiness::Either, _) => return,
        }
    };
    let name = type_name_for_node(c, node_type, expression);
    let report = typed_value_report(
        message,
        ctx.trim_node_text_range(report_node),
        ctx.trim_node_text_range(expression),
        name,
    );
    ctx.report_diagnostic(report);
}

/// The type to check on the left of `??` or `??=`, and whether it is the
/// recovered read type of an assignment target.
fn get_nullish_coalescing_type(st: &State, c: &mut Checker, node: Node) -> (TypeId, bool) {
    let node_type = get_resolved_type(c, node);
    let node = skip_parentheses(node);
    if !is_assignment_target(node) {
        return (node_type, false);
    }
    if !st.no_unchecked_indexed_access {
        // The type of an assignment target has no control-flow narrowing in
        // TypeScript Go.
        if node_type.is_some() && node.kind() == SyntaxKind::ElementAccessExpression {
            return (c.get_flow_type_of_reference(node, node_type), false);
        }
        return (node_type, false);
    }

    let read_type = match node.kind() {
        SyntaxKind::PropertyAccessExpression => {
            let name = node.name();
            if name.is_nil() || name.kind() == SyntaxKind::PrivateIdentifier {
                return (node_type, false);
            }
            let base_type = get_resolved_type(c, node.expression());
            let name = get_text_of_property_name(name);
            if base_type.is_nil() || c.get_property_of_type(base_type, name.as_str()).is_some() {
                return (node_type, false);
            }
            c.get_type_of_property_or_index_signature_of_type(base_type, name.as_str())
        }
        SyntaxKind::ElementAccessExpression => {
            let argument = node.argument_expression();
            if argument.is_nil() {
                return (node_type, false);
            }
            let base_type = get_resolved_type(c, node.expression());
            let key_type = get_resolved_type(c, argument);
            if base_type.is_nil() || key_type.is_nil() {
                return (node_type, false);
            }
            c.get_indexed_access_type_or_undefined(
                base_type,
                key_type,
                AccessFlags::EXPRESSION_POSITION,
                Node::NIL,
                None,
            )
        }
        _ => TypeId::NIL,
    };
    if read_type.is_nil() {
        return (node_type, false);
    }
    // The type of an assignment target has neither the unchecked-index
    // `undefined` nor flow narrowing; the read type has both.
    (c.get_flow_type_of_reference(node, read_type), true)
}

/// `obj[k] ??= v` with a union key, where some entry read through the key
/// may be non-nullish.
fn has_possibly_non_nullish_indexed_read(c: &mut Checker, node: Node) -> bool {
    let node = skip_parentheses(node);
    if node.kind() != SyntaxKind::ElementAccessExpression || !is_assignment_target(node) {
        return false;
    }
    let argument = node.argument_expression();
    if argument.is_nil() {
        return false;
    }
    let object_type = get_resolved_type(c, node.expression());
    let key_type = get_resolved_type(c, argument);
    if object_type.is_nil() || key_type.is_nil() || !is_union_type(c, key_type) {
        return false;
    }
    let read_type = c.get_indexed_access_type_or_undefined(
        object_type,
        key_type,
        AccessFlags::EXPRESSION_POSITION,
        Node::NIL,
        None,
    );
    if read_type.is_nil() {
        return false;
    }
    let flow_type = c.get_flow_type_of_reference(node, read_type);
    union_type_parts(c, flow_type)
        .iter()
        .any(|&part| !is_always_nullish_type(c, part))
}

/// An optional property access, or an element access that can read a
/// nullish value.
fn is_nullable_member_expression(c: &mut Checker, node: Node) -> bool {
    let node = skip_parentheses(node);
    match node.kind() {
        SyntaxKind::PropertyAccessExpression => {
            let name = node.name();
            if name.is_nil() {
                return false;
            }
            let base_type = c.get_type_at_location(node.expression());
            if base_type.is_nil() {
                return false;
            }
            let property_name = get_text_of_property_name(name);
            if property_name.is_empty() {
                return false;
            }
            let mut symbol = c.get_symbol_at_location_exported(name);
            if symbol.is_nil() {
                symbol = c.get_property_of_type(base_type, property_name.as_str());
            }
            if symbol.is_nil() {
                symbol = c
                    .get_properties_of_type(base_type)
                    .iter()
                    .copied()
                    .find(|&property| c.sym(property).name.as_str() == property_name)
                    .unwrap_or(goport_core::core::SymbolId::NIL);
            }
            symbol.is_some()
                && c.sym(symbol)
                    .flags
                    .intersects(goport_core::flags::SymbolFlags::OPTIONAL)
        }
        SyntaxKind::ElementAccessExpression => is_nullable_element_access_expression(c, node),
        _ => false,
    }
}

/// `a?.b` where some `?.` in the chain follows an array index.
fn option_chain_contains_option_array_index(c: &mut Checker, node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    if !matches!(
        node.kind(),
        SyntaxKind::CallExpression
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
    ) {
        return false;
    }
    let lhs = node.expression();
    if node.question_dot_token().is_some() && is_array_index_expression(c, lhs) {
        return true;
    }
    matches!(
        lhs.kind(),
        SyntaxKind::CallExpression
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
    ) && option_chain_contains_option_array_index(c, lhs)
}

/// Reports the left of `??` or `??=` when it is `never`, always nullish or
/// never nullish.
fn check_node_for_nullish(st: &State, ctx: &mut RuleContext<'_>, node: Node) {
    if node.is_nil() {
        return;
    }
    let c = &mut *ctx.checker;
    let (node_type, recovered_read_type) = get_nullish_coalescing_type(st, c, node);
    if node_type.is_nil() || is_conditional_always_necessary(c, node_type) {
        return;
    }
    let Some(node_type) = constrain_indexed_access_type(c, node_type) else {
        return;
    };

    let message = if is_type_flag_set(c, node_type, TypeFlags::NEVER) {
        never_message()
    } else if is_always_nullish_type(c, node_type)
        && !has_possibly_non_nullish_indexed_read(c, node)
    {
        always_nullish_message()
    } else {
        // A recovered read type already has the optionality and the flow
        // narrowing.
        if is_nullish_type(c, node_type)
            || (!recovered_read_type && is_nullable_member_expression(c, node))
        {
            return;
        }
        let node = skip_parentheses(node);
        if !st.no_unchecked_indexed_access
            && (is_array_index_expression(c, node)
                || (has_optional_chain(node) && option_chain_contains_option_array_index(c, node)))
        {
            return;
        }
        let name = type_name_for_node(c, node_type, node);
        let range = ctx.trim_node_text_range(node);
        ctx.report_diagnostic(typed_value_report(
            never_nullish_message(),
            range,
            range,
            name,
        ));
        return;
    };
    let name = type_name_for_node(c, node_type, node);
    let range = ctx.trim_node_text_range(node);
    ctx.report_diagnostic(typed_value_report(message, range, range, name));
}

/// Whether a value of type `t` can equal a value with one of `flags`.
fn is_comparable(c: &Checker, t: TypeId, flags: TypeFlags, loose: bool) -> bool {
    if t.is_nil() {
        return false;
    }
    let mut flags = flags
        | TypeFlags::ANY
        | TypeFlags::UNKNOWN
        | TypeFlags::TYPE_PARAMETER
        | TypeFlags::TYPE_VARIABLE;
    if loose {
        flags = flags | TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::VOID;
    }
    let type_flags = c.ty(t).flags;
    if type_flags.intersects(flags)
        || type_flags.intersects(
            TypeFlags::CONDITIONAL
                | TypeFlags::TYPE_VARIABLE
                | TypeFlags::SUBSTITUTION
                | TypeFlags::INCLUDES_CONSTRAINED_TYPE_VARIABLE,
        )
    {
        return true;
    }
    if is_union_type(c, t) {
        return c
            .ty(t)
            .types()
            .iter()
            .any(|&part| is_comparable(c, part, flags, loose));
    }
    if is_intersection_type(c, t) {
        let parts = c.ty(t).types();
        return !parts.is_empty()
            && parts
                .iter()
                .all(|&part| is_comparable(c, part, flags, loose));
    }
    false
}

/// Reports a comparison between two literal types, or a comparison with
/// `null` or `undefined` that the other side can never equal.
fn check_comparison(
    st: &State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    left: Node,
    right: Node,
    operator: SyntaxKind,
) {
    let c = &mut *ctx.checker;
    let left_type = get_resolved_type(c, left);
    let right_type = get_resolved_type(c, right);
    if left_type.is_nil() || right_type.is_nil() {
        return;
    }
    // A `case` expression that is itself a binary expression is reported at
    // its operator too.
    let primary_range = |ctx: &RuleContext<'_>| {
        if is_binary_expression(node) {
            ctx.trim_node_text_range(node.operator_token())
        } else {
            ctx.trim_node_text_range(node)
        }
    };

    if is_static_value(c, left_type) && is_static_value(c, right_type) {
        let left_name = type_name(c, left_type);
        let right_name = type_name(c, right_type);
        let report = comparison_report(
            literal_binary_expression_message(),
            primary_range(ctx),
            &left_name,
            ctx.trim_node_text_range(left),
            &right_name,
            ctx.trim_node_text_range(right),
        );
        ctx.report_diagnostic(report);
        return;
    }
    if !st.strict_null_checks {
        return;
    }

    let loose = matches!(
        operator,
        SyntaxKind::EqualsEqualsToken | SyntaxKind::ExclamationEqualsToken
    );
    let left_flags = c.ty(left_type).flags;
    let right_flags = c.ty(right_type).flags;
    let undefined_or_void = TypeFlags::UNDEFINED | TypeFlags::VOID;
    let no_overlap = (left_flags == TypeFlags::UNDEFINED
        && !is_comparable(c, right_type, undefined_or_void, loose))
        || (right_flags == TypeFlags::UNDEFINED
            && !is_comparable(c, left_type, undefined_or_void, loose))
        || (left_flags == TypeFlags::NULL && !is_comparable(c, right_type, TypeFlags::NULL, loose))
        || (right_flags == TypeFlags::NULL && !is_comparable(c, left_type, TypeFlags::NULL, loose));
    if !no_overlap {
        return;
    }
    let left_name = type_name(c, left_type);
    let right_name = type_name(c, right_type);
    // tsgolint labels the untrimmed ranges of the operands here.
    let report = comparison_report(
        no_overlap_message(),
        primary_range(ctx),
        &left_name,
        left.loc(),
        &right_name,
        right.loc(),
    );
    ctx.report_diagnostic(report);
}

fn check_loop_condition(st: &State, ctx: &mut RuleContext<'_>, test: Node) {
    if test.is_nil() {
        return;
    }
    match st.loop_conditions {
        LoopConditions::OnlyAllowedLiterals if is_allowed_constant_literal(test) => return,
        LoopConditions::Always => {
            if skip_parentheses(test).kind() == SyntaxKind::TrueKeyword {
                return;
            }
            let test_type = get_resolved_type(ctx.checker, test);
            if test_type.is_some() && is_true_literal_type(ctx.checker, test_type) {
                return;
            }
        }
        _ => {}
    }
    check_condition(st, ctx, test);
}

/// `true`, `false`, `0` or `1`.
fn is_allowed_constant_literal(node: Node) -> bool {
    let node = skip_parentheses(node);
    match node.kind() {
        SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword => true,
        SyntaxKind::NumericLiteral => matches!(node.text(), "0" | "1"),
        _ => false,
    }
}

fn check_call_expression(st: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    check_optional_chain(st, ctx, node);
    if is_array_method_call_with_predicate(ctx.checker, node)
        && let Some(argument) = node.arguments().first()
    {
        check_predicate_function(ctx, argument, st.check_type_predicates);
    }
    check_type_predicate_call(st, ctx, node);
}

/// With `checkTypePredicates`, reports an argument whose type already is
/// the type that a type guard or an assertion function narrows to.
fn check_type_predicate_call(st: &State, ctx: &mut RuleContext<'_>, node: Node) {
    if !st.check_type_predicates {
        return;
    }
    let arguments: Vec<Node> = node
        .arguments()
        .iter()
        .take_while(|arg| arg.kind() != SyntaxKind::SpreadElement)
        .collect();
    if arguments.is_empty() {
        return;
    }
    let c = &mut *ctx.checker;
    let signature = c.get_resolved_signature(node, None, CheckMode::NORMAL);
    if signature.is_nil() {
        return;
    }
    let predicate = c.get_type_predicate_of_signature(signature);
    if predicate.is_nil() {
        return;
    }
    let (kind, parameter_index, predicate_type) = {
        let predicate = c.pred(predicate);
        (predicate.kind, predicate.parameter_index, predicate.t)
    };
    let Some(&argument) = usize::try_from(parameter_index)
        .ok()
        .and_then(|index| arguments.get(index))
    else {
        return;
    };

    if kind == TypePredicateKind::ASSERTS_IDENTIFIER && predicate_type.is_nil() {
        check_condition(st, ctx, argument);
        return;
    }
    if kind != TypePredicateKind::ASSERTS_IDENTIFIER && kind != TypePredicateKind::IDENTIFIER {
        return;
    }
    let argument_type = get_constrained_type_at_location(c, argument);
    if argument_type.is_nil() || argument_type != predicate_type {
        return;
    }
    let value_name = type_name(c, argument_type);
    let predicate_name = type_name(c, predicate_type);
    let range = ctx.trim_node_text_range(argument);
    ctx.report_diagnostic(type_guard_report(
        range,
        range,
        &value_name,
        &predicate_name,
    ));
}

/// Checks the predicate of `arr.filter(...)` and similar calls: a type guard
/// that the element type already satisfies (with `checkTypePredicates`), or
/// a return type that is always truthy or always falsy.
fn check_predicate_function(ctx: &mut RuleContext<'_>, function: Node, check_type_guards: bool) {
    let function_type = ctx.checker.get_type_at_location(function);
    for signature in ctx.checker.get_call_signatures(function_type) {
        let predicate = ctx.checker.get_type_predicate_of_signature(signature);
        if check_type_guards
            && predicate.is_some()
            && check_type_guard(ctx, function, signature, predicate)
        {
            return;
        }

        let c = &mut *ctx.checker;
        let mut return_type = c.get_return_type_of_signature(signature);
        if is_type_flag_set(c, return_type, TypeFlags::TYPE_PARAMETER) {
            let constraint = c.get_constraint_of_type_parameter_exported(return_type);
            if constraint.is_some() {
                return_type = constraint;
            }
        }
        let truthy = match check_type_condition(c, return_type) {
            Truthiness::AlwaysTruthy => true,
            Truthiness::AlwaysFalsy => false,
            Truthiness::Either => continue,
        };
        let is_function_literal = matches!(
            function.kind(),
            SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression
        );
        let report_node = if is_function_literal && function.body().is_some() {
            function.body()
        } else {
            function
        };
        let message = match (truthy, is_function_literal) {
            (true, true) => always_truthy_message(),
            (true, false) => always_truthy_func_message(),
            (false, true) => always_falsy_message(),
            (false, false) => always_falsy_func_message(),
        };
        let name = type_name_for_node(c, return_type, report_node);
        let range = ctx.trim_node_text_range(report_node);
        ctx.report_diagnostic(typed_return_report(message, range, range, name));
    }
}

/// Reports a `x is T` (or `this is T`) predicate whose parameter type is
/// already assignable to `T`. Returns whether it reported.
fn check_type_guard(
    ctx: &mut RuleContext<'_>,
    function: Node,
    signature: goport_core::core::SignatureId,
    predicate: goport_core::core::TypePredicateId,
) -> bool {
    let c = &mut *ctx.checker;
    let (kind, parameter_index, predicate_type) = {
        let predicate = c.pred(predicate);
        (predicate.kind, predicate.parameter_index, predicate.t)
    };
    let parameter = usize::try_from(parameter_index)
        .ok()
        .and_then(|index| c.sig(signature).parameters().get(index).copied());
    let Some(parameter) = parameter.filter(|parameter| parameter.is_some()) else {
        return false;
    };
    let parameter_type = c.get_type_of_symbol(parameter);
    // `asserts x` predicates are checked through the return type.
    if parameter_type.is_nil()
        || !(kind == TypePredicateKind::IDENTIFIER || kind == TypePredicateKind::THIS)
        || predicate_type.is_nil()
        || !c.is_type_assignable_to(parameter_type, predicate_type)
    {
        return false;
    }
    let declaration = c.sym(parameter).value_declaration;
    let primary =
        if declaration.is_some() && get_source_file_of_node(declaration) == ctx.source_file {
            trim_node_text_range(ctx.source_file, declaration)
        } else {
            trim_node_text_range(ctx.source_file, function)
        };
    let value_name = type_name(c, parameter_type);
    let predicate_name = type_name(c, predicate_type);
    ctx.report_diagnostic(type_guard_report(
        primary,
        primary,
        &value_name,
        &predicate_name,
    ));
    true
}
