//! `no-unsafe-enum-comparison`: disallows comparing an enum value with a
//! value that is not of the same enum.

use goport_core::ast::{
    is_element_access_expression, is_enum_member, is_property_access_expression, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, LiteralValue};
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{LanguageVariant, SymbolFlags, TypeFlags};
use goport_core::jsnum::Number;
use goport_core::scanner_util::is_identifier_text;
use rustc_hash::FxHashSet;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage, RuleSuggestion,
};

use crate::utils::{
    get_enum_literals, get_enum_types, intersection_type_parts, is_symbol_flag_set,
    is_type_flag_set, quote_single_string_literal, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-enum-comparison",
    create,
};

fn mismatched_case_message() -> RuleMessage {
    RuleMessage::new(
        "mismatchedCase",
        "The case statement does not have a shared enum type with the switch predicate.",
    )
    .with_help(
        "Compare against a member of the same enum as the switch value, or normalize both sides to the same primitive representation first.",
    )
}

fn mismatched_condition_message() -> RuleMessage {
    RuleMessage::new(
        "mismatchedCondition",
        "The two values in this comparison do not have a shared enum type.",
    )
    .with_help(
        "Compare enum values to members of the same enum, or convert both sides to the same primitive type before comparing them.",
    )
}

fn replace_value_with_enum_message() -> RuleMessage {
    RuleMessage::new(
        "replaceValueWithEnum",
        "Replace with an enum value comparison.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::BinaryExpression, check_binary_expression)
        .on(SyntaxKind::CaseClause, check_case_clause)
        .into()
}

#[allow(clippy::too_many_arguments)]
fn comparison_report(
    ctx: &mut RuleContext<'_>,
    node: Node,
    message: RuleMessage,
    left_label: &str,
    left: Node,
    left_type: TypeId,
    right_label: &str,
    right: Node,
    right_type: TypeId,
) -> Report {
    let left_text = ctx.checker.type_to_string(left_type);
    let right_text = ctx.checker.type_to_string(right_type);
    Report::new(ctx.trim_node_text_range(node), message)
        .with_label(
            format!("{left_label}: {left_text}"),
            ctx.trim_node_text_range(left),
        )
        .with_label(
            format!("{right_label}: {right_text}"),
            ctx.trim_node_text_range(right),
        )
}

fn check_binary_expression(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if !matches!(
        node.operator_token().kind(),
        SyntaxKind::LessThanToken
            | SyntaxKind::LessThanEqualsToken
            | SyntaxKind::GreaterThanToken
            | SyntaxKind::GreaterThanEqualsToken
            | SyntaxKind::EqualsEqualsToken
            | SyntaxKind::EqualsEqualsEqualsToken
            | SyntaxKind::ExclamationEqualsToken
            | SyntaxKind::ExclamationEqualsEqualsToken
    ) {
        return;
    }
    let (left, right) = (node.left(), node.right());
    let left_type = ctx.checker.get_type_at_location(left);
    let right_type = ctx.checker.get_type_at_location(right);
    if !is_mismatched_comparison(ctx.checker, left_type, right_type) {
        return;
    }
    let report = comparison_report(
        ctx,
        node,
        mismatched_condition_message(),
        "Left operand",
        left,
        left_type,
        "Right operand",
        right,
        right_type,
    );
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        enum_comparison_suggestions(ctx, node, left_type, right_type)
    });
}

fn check_case_clause(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let switch_expression = node.parent().parent().expression();
    let case_expression = node.expression();
    let left_type = ctx.checker.get_type_at_location(switch_expression);
    let right_type = ctx.checker.get_type_at_location(case_expression);
    if !is_mismatched_comparison(ctx.checker, left_type, right_type) {
        return;
    }
    let report = comparison_report(
        ctx,
        node,
        mismatched_case_message(),
        "Switch value",
        switch_expression,
        left_type,
        "Case value",
        case_expression,
        right_type,
    );
    ctx.report_diagnostic(report);
}

/// The kind of the values of an enum type.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EnumValueKind {
    Number,
    String,
}

/// The kind of the values of `t`, or None when it is not an enum type.
fn enum_value_kind(checker: &Checker, t: TypeId) -> Option<EnumValueKind> {
    if !is_type_flag_set(checker, t, TypeFlags::ENUM_LIKE) {
        None
    } else if is_type_flag_set(checker, t, TypeFlags::NUMBER_LITERAL) {
        Some(EnumValueKind::Number)
    } else {
        Some(EnumValueKind::String)
    }
}

/// Every union part has an intersection part with one of `flags`.
fn type_is_primitive_like(checker: &Checker, t: TypeId, flags: TypeFlags) -> bool {
    union_type_parts(checker, t).iter().all(|&union_part| {
        intersection_type_parts(checker, union_part)
            .iter()
            .any(|&part| is_type_flag_set(checker, part, flags))
    })
}

/// Whether comparing `right_type` with any of `left_parts` is unsafe.
fn type_violates(checker: &Checker, left_parts: &[TypeId], right_type: TypeId) -> bool {
    let right_number_like = type_is_primitive_like(
        checker,
        right_type,
        TypeFlags::NUMBER | TypeFlags::NUMBER_LIKE,
    );
    let right_string_like = type_is_primitive_like(
        checker,
        right_type,
        TypeFlags::STRING | TypeFlags::STRING_LIKE,
    );
    if !right_number_like && !right_string_like {
        return false;
    }
    left_parts.iter().any(|&part| {
        let value_kind = enum_value_kind(checker, part);
        (value_kind == Some(EnumValueKind::Number) && right_number_like)
            || (value_kind == Some(EnumValueKind::String) && right_string_like)
    })
}

fn is_mismatched_comparison(checker: &mut Checker, left_type: TypeId, right_type: TypeId) -> bool {
    if left_type == right_type {
        return false;
    }

    // Comparisons without enums, like `1 === 2`, are fine.
    let left_enum_types = get_enum_types(checker, left_type);
    let right_enum_types: FxHashSet<TypeId> =
        get_enum_types(checker, right_type).into_iter().collect();
    if left_enum_types.is_empty() && right_enum_types.is_empty() {
        return false;
    }

    // A shared enum, like `Fruit.Apple === Fruit.Banana`, is fine.
    if left_enum_types.iter().any(|t| right_enum_types.contains(t)) {
        return false;
    }

    // A type on both sides is fine:
    // `declare const fruit: Fruit.Apple | 0; fruit === 0;`
    let left_parts = union_type_parts(checker, left_type);
    let right_parts = union_type_parts(checker, right_type);
    if left_parts.iter().any(|part| right_parts.contains(part)) {
        return false;
    }

    type_violates(checker, &left_parts, right_type)
        || type_violates(checker, &right_parts, left_type)
}

// Suggestions.

/// A string or number that the expression evaluates to without types.
#[derive(Clone, Debug)]
enum StaticValue {
    String(String),
    Number(Number),
}

impl StaticValue {
    fn to_js_string(&self) -> String {
        match self {
            StaticValue::String(s) => s.clone(),
            StaticValue::Number(n) => n.to_string(),
        }
    }
}

fn static_value(node: Node) -> Option<StaticValue> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    match node.kind() {
        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
            Some(StaticValue::String(node.text().to_string()))
        }
        SyntaxKind::NumericLiteral => Some(StaticValue::Number(Number::from_string(node.text()))),
        SyntaxKind::PrefixUnaryExpression => {
            let StaticValue::Number(value) = static_value(node.operand())? else {
                return None;
            };
            match node.operator() {
                SyntaxKind::MinusToken => Some(StaticValue::Number(-value)),
                SyntaxKind::PlusToken => Some(StaticValue::Number(value)),
                _ => None,
            }
        }
        SyntaxKind::AsExpression
        | SyntaxKind::TypeAssertionExpression
        | SyntaxKind::NonNullExpression
        | SyntaxKind::SatisfiesExpression => static_value(node.expression()),
        SyntaxKind::BinaryExpression => {
            if node.operator_token().kind() != SyntaxKind::PlusToken {
                return None;
            }
            let left = static_value(node.left())?;
            let right = static_value(node.right())?;
            match (left, right) {
                (StaticValue::Number(l), StaticValue::Number(r)) => {
                    Some(StaticValue::Number(l + r))
                }
                (left, right) => Some(StaticValue::String(
                    left.to_js_string() + &right.to_js_string(),
                )),
            }
        }
        _ => None,
    }
}

fn enum_value_matches_static_value(enum_value: Option<&LiteralValue>, value: &StaticValue) -> bool {
    match (enum_value, value) {
        (Some(LiteralValue::String(e)), StaticValue::String(v)) => e == v,
        (Some(LiteralValue::Number(e)), StaticValue::Number(v)) => e.0 == v.0,
        _ => false,
    }
}

/// `.Name` or `['name']` for an enum member.
fn enum_member_suffix_text(ctx: &RuleContext<'_>, member: Node) -> Option<String> {
    let name = member.name();
    if name.is_nil() {
        return None;
    }
    let suffix = match name.kind() {
        SyntaxKind::Identifier => format!(".{}", name.text()),
        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
            let text = name.text();
            if is_identifier_text(text, LanguageVariant::STANDARD) {
                format!(".{text}")
            } else {
                format!("[{}]", quote_single_string_literal(text))
            }
        }
        SyntaxKind::ComputedPropertyName => {
            format!("[{}]", ctx.node_text(name.expression()))
        }
        _ => return None,
    };
    Some(suffix)
}

fn is_qualified_identifier_text(value: &str) -> bool {
    value
        .split('.')
        .all(|part| is_identifier_text(part, LanguageVariant::STANDARD))
}

fn symbol_matches_enum(checker: &mut Checker, symbol: SymbolId, enum_symbol: SymbolId) -> bool {
    if symbol.is_nil() || enum_symbol.is_nil() {
        return false;
    }
    if symbol == enum_symbol || checker.get_export_symbol_of_symbol(symbol) == enum_symbol {
        return true;
    }
    if is_symbol_flag_set(checker, symbol, SymbolFlags::ALIAS) {
        let aliased = checker.get_aliased_symbol(symbol);
        return aliased == enum_symbol
            || checker.get_export_symbol_of_symbol(aliased) == enum_symbol;
    }
    false
}

/// The enum's name when it is in scope at `at_node`, or its qualified name.
fn enum_qualifier_from_type(
    checker: &mut Checker,
    at_node: Node,
    enum_type: TypeId,
    enum_declaration: Node,
) -> Option<String> {
    let qualifier = checker.type_to_string(enum_type);
    if !is_qualified_identifier_text(&qualifier) {
        return None;
    }
    if qualifier.contains('.') {
        return Some(qualifier);
    }
    let enum_symbol = checker.get_symbol_at_location_exported(enum_declaration.name());
    let in_scope = checker.get_symbols_in_scope_exported(at_node, SymbolFlags::VALUE);
    for scope_symbol in in_scope {
        if checker.sym(scope_symbol).name.as_str() == qualifier
            && symbol_matches_enum(checker, scope_symbol, enum_symbol)
        {
            return Some(qualifier);
        }
    }
    None
}

fn symbol_matches_enum_declaration(
    checker: &mut Checker,
    symbol: SymbolId,
    enum_declaration: Node,
) -> bool {
    if symbol.is_nil() || enum_declaration.is_nil() {
        return false;
    }
    let mut symbol = symbol;
    if is_symbol_flag_set(checker, symbol, SymbolFlags::ALIAS) {
        symbol = checker.get_aliased_symbol(symbol);
    }
    symbol = checker.get_export_symbol_of_symbol(symbol);
    if symbol.is_nil() {
        return false;
    }
    let value_declaration = checker.sym(symbol).value_declaration;
    value_declaration.is_some()
        && is_enum_member(value_declaration)
        && value_declaration.parent() == enum_declaration
}

/// The text before the member in `E.A` or `E['A']` when it names a member of
/// `enum_declaration`.
fn enum_qualifier_from_member_access(
    ctx: &mut RuleContext<'_>,
    node: Node,
    enum_declaration: Node,
) -> Option<String> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    if is_property_access_expression(node) {
        let symbol = ctx.checker.get_symbol_at_location_exported(node.name());
        if !symbol_matches_enum_declaration(ctx.checker, symbol, enum_declaration) {
            return None;
        }
        return Some(ctx.node_text(node.expression()));
    }
    if is_element_access_expression(node) {
        let symbol = ctx.checker.get_symbol_at_location_exported(node);
        if !symbol_matches_enum_declaration(ctx.checker, symbol, enum_declaration) {
            let symbol = ctx
                .checker
                .get_symbol_at_location_exported(node.argument_expression());
            if !symbol_matches_enum_declaration(ctx.checker, symbol, enum_declaration) {
                return None;
            }
        }
        return Some(ctx.node_text(node.expression()));
    }
    None
}

/// The enum member expression (`E.A`) whose value is `value`.
fn enum_key_for_literal(
    ctx: &mut RuleContext<'_>,
    at_node: Node,
    enum_side: Node,
    enum_literals: &[TypeId],
    value: &StaticValue,
) -> Option<String> {
    for &enum_literal in enum_literals {
        let symbol = ctx.checker.ty(enum_literal).symbol;
        if symbol.is_nil() {
            continue;
        }
        let member = ctx.checker.sym(symbol).value_declaration;
        if member.is_nil() || !is_enum_member(member) {
            continue;
        }
        let enum_value = ctx.checker.get_constant_value(member);
        if !enum_value_matches_static_value(enum_value.as_ref(), value) {
            continue;
        }
        let Some(suffix) = enum_member_suffix_text(ctx, member) else {
            continue;
        };
        let enum_declaration = member.parent();
        let qualifier = enum_qualifier_from_member_access(ctx, enum_side, enum_declaration)
            .or_else(|| {
                let enum_type = ctx.checker.get_type_at_location(enum_declaration);
                enum_qualifier_from_type(ctx.checker, at_node, enum_type, enum_declaration)
            });
        if let Some(qualifier) = qualifier {
            return Some(qualifier + &suffix);
        }
    }
    None
}

fn enum_comparison_suggestions(
    ctx: &mut RuleContext<'_>,
    node: Node,
    left_type: TypeId,
    right_type: TypeId,
) -> Vec<RuleSuggestion> {
    let (left, right) = (node.left(), node.right());
    let sides = [(right, left, left_type), (left, right, right_type)];
    for (value_side, enum_side, enum_side_type) in sides {
        let Some(value) = static_value(value_side) else {
            continue;
        };
        let enum_literals = get_enum_literals(ctx.checker, enum_side_type);
        if let Some(enum_key) = enum_key_for_literal(ctx, node, enum_side, &enum_literals, &value) {
            return vec![RuleSuggestion {
                message: replace_value_with_enum_message(),
                fixes: vec![ctx.fix_replace(value_side, enum_key)],
            }];
        }
    }
    Vec::new()
}
