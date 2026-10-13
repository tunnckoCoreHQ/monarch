//! `strict-boolean-expressions`: restricts the types allowed in boolean
//! contexts.

use goport_core::ast::{get_function_flags, is_logical_expression};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, LiteralValue};
use goport_core::core::{Node, TypeId, TypePredicateId};
use goport_core::flags::{FunctionFlags, TypeFlags, TypePredicateKind};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    boolean_literal_value, get_call_signatures, get_constrained_type_at_location,
    is_array_method_call_with_predicate, is_intersection_type, literal_type_value,
    require_strict_null_checks, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "strict-boolean-expressions",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_any: bool,
    allow_nullable_boolean: bool,
    allow_nullable_number: bool,
    allow_nullable_string: bool,
    allow_nullable_enum: bool,
    allow_nullable_object: bool,
    allow_string: bool,
    allow_number: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_any: false,
            allow_nullable_boolean: false,
            allow_nullable_number: false,
            allow_nullable_string: false,
            allow_nullable_enum: false,
            allow_nullable_object: true,
            allow_string: true,
            allow_number: true,
        }
    }
}

struct State {
    options: Options,
    /// Nodes already checked, so that a nested condition is reported once.
    traversed: FxHashSet<Node>,
}

fn condition_error_number_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNumber",
        "Unexpected number value in conditional. A number can be falsy (0, NaN) or truthy.",
    )
}

fn condition_error_string_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorString",
        "Unexpected string value in conditional. A string can be falsy (empty string) or truthy.",
    )
}

fn condition_error_object_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorObject",
        "Unexpected object value in conditional. An object is always truthy.",
    )
}

fn condition_error_nullish_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullish",
        "Unexpected nullish value in conditional. The expression is always falsy.",
    )
}

fn condition_error_other_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorOther",
        "Unexpected value in conditional. A union of different types has inconsistent truthiness.",
    )
}

fn condition_error_nullable_boolean_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullableBoolean",
        "Unexpected nullable boolean value in conditional.",
    )
    .with_help("Handle the nullish case explicitly.")
}

fn condition_error_nullable_object_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullableObject",
        "Unexpected nullable object value in conditional.",
    )
    .with_help("Handle the nullish case explicitly.")
}

fn condition_error_nullable_string_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullableString",
        "Unexpected nullable string value in conditional.",
    )
    .with_help("Handle the nullish and empty string cases explicitly.")
}

fn condition_error_nullable_number_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullableNumber",
        "Unexpected nullable number value in conditional.",
    )
    .with_help("Handle the nullish and zero cases explicitly.")
}

fn condition_error_nullable_enum_message() -> RuleMessage {
    RuleMessage::new(
        "conditionErrorNullableEnum",
        "Unexpected nullable enum value in conditional.",
    )
    .with_help("Handle the nullish and falsy enum cases explicitly.")
}

fn condition_error_any_message() -> RuleMessage {
    RuleMessage::new("conditionErrorAny", "Unexpected any value in conditional.")
        .with_help("Use a more specific type to ensure type safety.")
}
fn predicate_cannot_be_async_message() -> RuleMessage {
    RuleMessage::new(
        "predicateCannotBeAsync",
        "Predicate function should not be 'async'; expected a boolean return type.",
    )
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    require_strict_null_checks(ctx);
    let state = State {
        options,
        traversed: FxHashSet::default(),
    };
    Listeners::new(state)
        .on(SyntaxKind::IfStatement, |state, ctx, node| {
            traverse_node(state, ctx, node.expression(), true);
        })
        .on(SyntaxKind::WhileStatement, |state, ctx, node| {
            traverse_node(state, ctx, node.expression(), true);
        })
        .on(SyntaxKind::DoStatement, |state, ctx, node| {
            traverse_node(state, ctx, node.expression(), true);
        })
        .on(SyntaxKind::ForStatement, |state, ctx, node| {
            let condition = node.condition();
            if condition.is_some() {
                traverse_node(state, ctx, condition, true);
            }
        })
        .on(SyntaxKind::ConditionalExpression, |state, ctx, node| {
            traverse_node(state, ctx, node.condition(), true);
        })
        .on(SyntaxKind::BinaryExpression, |state, ctx, node| {
            if is_logical_non_coalescing(node) {
                traverse_logical_expression(state, ctx, node, false);
            }
        })
        .on(SyntaxKind::CallExpression, check_call)
        .on(SyntaxKind::PrefixUnaryExpression, |state, ctx, node| {
            if node.operator() == SyntaxKind::ExclamationToken {
                traverse_node(state, ctx, node.operand(), true);
            }
        })
        .into()
}

fn is_logical_non_coalescing(node: Node) -> bool {
    is_logical_expression(node) && node.operator_token().kind() != SyntaxKind::QuestionQuestionToken
}

fn check_call(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if let Some(argument) = find_truthiness_asserted_argument(ctx.checker, node) {
        traverse_node(state, ctx, argument, true);
    }

    if !is_array_method_call_with_predicate(ctx.checker, node) {
        return;
    }
    let Some(argument) = node.arguments().first() else {
        return;
    };
    if get_function_flags(argument).intersects(FunctionFlags::ASYNC) {
        ctx.report_node(argument, predicate_cannot_be_async_message());
        return;
    }
    let checker = &mut *ctx.checker;
    let function_type = checker.get_type_at_location(argument);
    let mut types = Vec::new();
    for signature in get_call_signatures(checker, function_type) {
        let mut return_type = checker.get_return_type_of_signature(signature);
        if checker
            .ty(return_type)
            .flags
            .intersects(TypeFlags::TYPE_PARAMETER)
        {
            let constraint = checker.get_constraint_of_type_parameter_exported(return_type);
            if constraint.is_some() {
                return_type = constraint;
            }
        }
        types.extend(union_type_parts(checker, return_type));
    }
    check_condition(&state.options, ctx, node, &types);
}

/// The argument that an `asserts x` signature (without a type) asserts
/// truthy.
fn find_truthiness_asserted_argument(checker: &mut Checker, call: Node) -> Option<Node> {
    let checkable_arguments: Vec<Node> = call
        .arguments()
        .into_iter()
        .take_while(|argument| argument.kind() != SyntaxKind::SpreadElement)
        .collect();
    if checkable_arguments.is_empty() {
        return None;
    }
    let callee_type = checker.get_type_at_location(call.expression());
    if callee_type.is_nil() {
        return None;
    }
    let union_types = union_type_parts(checker, callee_type);
    let is_union = union_types.len() > 1;

    let signature = checker.get_resolved_signature_exported(call);
    let predicate = if signature.is_some() {
        checker.get_type_predicate_of_signature_exported(signature)
    } else {
        TypePredicateId::NIL
    };
    if predicate.is_some() {
        return asserted_argument_of_predicate(checker, predicate, &checkable_arguments);
    }
    if !is_union {
        return None;
    }
    union_types.into_iter().find_map(|t| {
        get_call_signatures(checker, t)
            .into_iter()
            .find_map(|signature| {
                let predicate = checker.get_type_predicate_of_signature_exported(signature);
                asserted_argument_of_predicate(checker, predicate, &checkable_arguments)
            })
    })
}

fn asserted_argument_of_predicate(
    checker: &Checker,
    predicate: TypePredicateId,
    checkable_arguments: &[Node],
) -> Option<Node> {
    if predicate.is_nil() {
        return None;
    }
    let predicate = checker.pred(predicate);
    if predicate.kind != TypePredicateKind::ASSERTS_IDENTIFIER || predicate.t.is_some() {
        return None;
    }
    let index = usize::try_from(predicate.parameter_index).ok()?;
    checkable_arguments.get(index).copied()
}

fn traverse_logical_expression(
    state: &mut State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    is_condition: bool,
) {
    traverse_node(state, ctx, node.left(), true);
    traverse_node(state, ctx, node.right(), is_condition);
}

fn traverse_node(state: &mut State, ctx: &mut RuleContext<'_>, node: Node, is_condition: bool) {
    if !state.traversed.insert(node) {
        return;
    }
    if node.kind() == SyntaxKind::ParenthesizedExpression {
        traverse_node(state, ctx, node.expression(), is_condition);
        return;
    }
    if node.kind() == SyntaxKind::BinaryExpression && is_logical_non_coalescing(node) {
        traverse_logical_expression(state, ctx, node, is_condition);
        return;
    }
    if !is_condition {
        return;
    }
    let node_type = get_constrained_type_at_location(ctx.checker, node);
    let parts = union_type_parts(ctx.checker, node_type);
    check_condition(&state.options, ctx, node, &parts);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Variant {
    Nullish,
    Boolean,
    String,
    Number,
    BigInt,
    Object,
    Any,
    Unknown,
    Never,
    Mixed,
    Generic,
}

struct PartInfo {
    variant: Variant,
    is_truthy: bool,
    is_enum: bool,
}

impl PartInfo {
    fn new(variant: Variant) -> Self {
        Self {
            variant,
            is_truthy: false,
            is_enum: false,
        }
    }
}

struct TypeInfo {
    variant: Variant,
    is_nullable: bool,
    is_truthy: bool,
    is_enum: bool,
}

fn analyze_type_parts(checker: &Checker, types: &[TypeId]) -> TypeInfo {
    let mut info = TypeInfo {
        variant: Variant::Nullish,
        is_nullable: false,
        is_truthy: false,
        is_enum: false,
    };
    let mut has_non_nullish_variant = false;
    let mut met_not_truthy = false;
    for &part in types {
        let part = analyze_type_part(checker, part);
        if part.variant == Variant::Nullish {
            info.is_nullable = true;
        } else if !has_non_nullish_variant {
            info.variant = part.variant;
            has_non_nullish_variant = true;
        } else if info.variant != part.variant {
            info.variant = Variant::Mixed;
        }
        info.is_enum |= part.is_enum;
        // The first part that is not truthy decides.
        if matches!(
            part.variant,
            Variant::Boolean | Variant::Number | Variant::String | Variant::BigInt
        ) && !met_not_truthy
        {
            info.is_truthy = part.is_truthy;
            met_not_truthy = !part.is_truthy;
        }
    }
    if types.is_empty() {
        info.variant = Variant::Mixed;
    }
    info
}

fn analyze_type_part(checker: &Checker, t: TypeId) -> PartInfo {
    let flags = checker.ty(t).flags;

    if is_intersection_type(checker, t) {
        let is_boolean = checker
            .ty(t)
            .types()
            .iter()
            .any(|&part| analyze_type_part(checker, part).variant == Variant::Boolean);
        return PartInfo::new(if is_boolean {
            Variant::Boolean
        } else {
            Variant::Object
        });
    }
    if flags.intersects(TypeFlags::TYPE_PARAMETER) {
        return PartInfo::new(Variant::Generic);
    }
    if flags.intersects(TypeFlags::ANY) {
        return PartInfo::new(Variant::Any);
    }
    if flags.intersects(TypeFlags::UNKNOWN) {
        return PartInfo::new(Variant::Unknown);
    }
    if flags.intersects(TypeFlags::NEVER) {
        return PartInfo::new(Variant::Never);
    }
    if flags.intersects(TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::VOID) {
        return PartInfo::new(Variant::Nullish);
    }
    if flags.intersects(TypeFlags::BOOLEAN | TypeFlags::BOOLEAN_LITERAL | TypeFlags::BOOLEAN_LIKE) {
        let mut info = PartInfo::new(Variant::Boolean);
        info.is_truthy = boolean_literal_value(checker, t) == Some(true);
        return info;
    }
    if flags.intersects(TypeFlags::ENUM | TypeFlags::ENUM_LITERAL | TypeFlags::ENUM_LIKE) {
        let variant = if flags.intersects(TypeFlags::STRING_LITERAL) {
            Variant::String
        } else {
            Variant::Number
        };
        let mut info = PartInfo::new(variant);
        info.is_enum = true;
        return info;
    }
    if flags.intersects(TypeFlags::STRING | TypeFlags::STRING_LITERAL | TypeFlags::STRING_LIKE) {
        let mut info = PartInfo::new(Variant::String);
        if flags.intersects(TypeFlags::STRING_LITERAL) {
            info.is_truthy = !matches!(literal_type_value(checker, t), Some(LiteralValue::String(s)) if s.is_empty());
        }
        return info;
    }
    if flags.intersects(TypeFlags::NUMBER | TypeFlags::NUMBER_LITERAL | TypeFlags::NUMBER_LIKE) {
        let mut info = PartInfo::new(Variant::Number);
        if flags.intersects(TypeFlags::NUMBER_LITERAL) {
            // tsgolint compares the printed number with "0", so NaN is truthy.
            info.is_truthy = !matches!(literal_type_value(checker, t), Some(LiteralValue::Number(n)) if n.0 == 0.0);
        }
        return info;
    }
    if flags.intersects(TypeFlags::BIG_INT | TypeFlags::BIG_INT_LITERAL) {
        let mut info = PartInfo::new(Variant::BigInt);
        // tsgolint compares the printed literal ("0n") with "0", so every
        // bigint literal counts as truthy.
        info.is_truthy = flags.intersects(TypeFlags::BIG_INT_LITERAL);
        return info;
    }
    if flags.intersects(
        TypeFlags::ES_SYMBOL
            | TypeFlags::UNIQUE_ES_SYMBOL
            | TypeFlags::OBJECT
            | TypeFlags::NON_PRIMITIVE,
    ) {
        return PartInfo::new(Variant::Object);
    }
    PartInfo::new(Variant::Mixed)
}

fn check_condition(options: &Options, ctx: &mut RuleContext<'_>, node: Node, types: &[TypeId]) {
    let info = analyze_type_parts(ctx.checker, types);
    let message = match info.variant {
        Variant::Any | Variant::Unknown | Variant::Generic => {
            (!options.allow_any).then(condition_error_any_message)
        }
        Variant::Never => None,
        Variant::Nullish => Some(condition_error_nullish_message()),
        // Truthy primitives are always valid.
        Variant::String if options.allow_string && info.is_truthy => None,
        Variant::Number if options.allow_number && info.is_truthy => None,
        Variant::String | Variant::Number => {
            let is_string = info.variant == Variant::String;
            if info.is_nullable {
                if info.is_enum {
                    (!options.allow_nullable_enum).then(condition_error_nullable_enum_message)
                } else if is_string {
                    (!options.allow_nullable_string).then(condition_error_nullable_string_message)
                } else {
                    (!options.allow_nullable_number).then(condition_error_nullable_number_message)
                }
            } else if is_string {
                (!options.allow_string).then(condition_error_string_message)
            } else {
                (!options.allow_number).then(condition_error_number_message)
            }
        }
        Variant::Boolean => {
            (!info.is_truthy && info.is_nullable && !options.allow_nullable_boolean)
                .then(condition_error_nullable_boolean_message)
        }
        Variant::Object => {
            if info.is_nullable {
                (!options.allow_nullable_object).then(condition_error_nullable_object_message)
            } else {
                Some(condition_error_object_message())
            }
        }
        Variant::Mixed => {
            if info.is_enum {
                (info.is_nullable && !options.allow_nullable_enum)
                    .then(condition_error_nullable_enum_message)
            } else {
                Some(condition_error_other_message())
            }
        }
        Variant::BigInt => {
            if info.is_nullable {
                (!options.allow_nullable_number).then(condition_error_nullable_number_message)
            } else {
                (!options.allow_number).then(condition_error_number_message)
            }
        }
    };
    if let Some(message) = message {
        ctx.report_node(node, message);
    }
}
