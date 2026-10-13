//! `prefer-find`: prefers `.find(...)` over `.filter(...)[0]` and
//! `.filter(...).at(0)`.

use goport_core::ast::{
    is_call_expression, is_comma_expression, is_element_access_expression, is_identifier,
    is_property_access_expression, is_variable_declaration, is_variable_declaration_list,
    skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::NodeFlags;
use rustc_hash::FxHashSet;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    TextRange,
};

use crate::utils::{
    get_constrained_type_at_location, go_parse_float, intersection_type_parts, is_type_null_type,
    is_type_undefined_type, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-find",
    create,
};

fn prefer_find_message() -> RuleMessage {
    RuleMessage::new(
        "preferFind",
        "Prefer .find(...) instead of .filter(...)[0].",
    )
}

fn prefer_find_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "preferFindSuggestion",
        "Use .find(...) instead of .filter(...)[0].",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_call)
        .on(SyntaxKind::ElementAccessExpression, check_element_access)
        .into()
}

/// A statically known value (ESLint's `getStaticValue`, reduced to what the
/// rule compares).
#[derive(Clone, Copy)]
enum StaticValue {
    String(&'static str),
    Number(f64),
    Boolean(bool),
    Null,
    /// Only whether a bigint is zero matters to the rule.
    BigInt {
        is_zero: bool,
    },
    Undefined,
    Symbol,
}

impl StaticValue {
    /// JavaScript `Number(value)`; None for a bigint or a symbol.
    fn to_number(self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(n),
            Self::String(s) => Some(string_to_number(s)),
            Self::Boolean(b) => Some(if b { 1.0 } else { 0.0 }),
            Self::Null => Some(0.0),
            Self::Undefined => Some(f64::NAN),
            Self::BigInt { .. } | Self::Symbol => None,
        }
    }

    /// `array.at(value)` reads index 0.
    fn is_treated_as_zero_by_array_at(self) -> bool {
        self.to_number()
            .is_some_and(|n| n.is_nan() || n.trunc() == 0.0)
    }

    /// `array[value]` reads index 0.
    fn is_treated_as_zero_by_member_access(self) -> bool {
        match self {
            Self::String(s) => s == "0",
            Self::Number(n) => n == 0.0,
            Self::BigInt { is_zero } => is_zero,
            _ => false,
        }
    }
}

/// tsgolint's string to number conversion: Go `strings.TrimSpace`, the
/// `Infinity` spellings, integers with a `0x`/`0b`/`0o` prefix, else Go
/// `strconv.ParseFloat` (NaN on error).
fn string_to_number(s: &str) -> f64 {
    let s = s.trim();
    match s {
        "" => return 0.0,
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let (sign, unsigned) = match s.as_bytes()[0] {
        b'-' | b'+' => s.split_at(1),
        _ => ("", s),
    };
    let radix = match unsigned.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0b" | "0B") => Some(2),
        Some("0o" | "0O") => Some(8),
        _ => None,
    };
    if let Some(radix) = radix {
        // tsgolint puts the sign back in front of the digits, and
        // `big.Int.SetString` reads one sign of its own, so `0x-5` is -5.
        let digits = format!("{sign}{}", &unsigned[2..]);
        return parse_integer(&digits, radix).unwrap_or(f64::NAN);
    }
    go_parse_float(s).unwrap_or(f64::NAN)
}

/// An optional sign and digits of `radix` (Go `big.Int.SetString` with an
/// explicit base) as an `f64`; None when there are no digits or one is
/// invalid.
fn parse_integer(text: &str, radix: u32) -> Option<f64> {
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() {
        return None;
    }
    let magnitude = digits.chars().try_fold(0.0_f64, |acc, ch| {
        ch.to_digit(radix)
            .map(|digit| acc * f64::from(radix) + f64::from(digit))
    })?;
    Some(if negative { -magnitude } else { magnitude })
}

/// Go `big.Int.SetString(text, 0)` of a bigint literal: None when invalid,
/// else whether it is zero.
fn parse_big_int_literal(text: &str) -> Option<StaticValue> {
    let text = text.trim();
    let text = text.strip_suffix('n').unwrap_or(text).replace('_', "");
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(&text);
    let (digits, radix) = match unsigned.get(..2) {
        Some("0x" | "0X") => (&unsigned[2..], 16),
        Some("0b" | "0B") => (&unsigned[2..], 2),
        Some("0o" | "0O") => (&unsigned[2..], 8),
        // Base 0 reads a leading `0` as octal.
        _ if unsigned.len() > 1 && unsigned.starts_with('0') => (&unsigned[1..], 8),
        _ => (unsigned, 10),
    };
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_digit(radix)) {
        return None;
    }
    Some(StaticValue::BigInt {
        is_zero: digits.bytes().all(|b| b == b'0'),
    })
}

/// The initializer of a `const` variable.
fn const_initializer(checker: &Checker, symbol: SymbolId) -> Option<Node> {
    let declaration = checker.sym(symbol).value_declaration;
    if declaration.is_nil() || !is_variable_declaration(declaration) {
        return None;
    }
    let list = declaration.parent();
    if !is_variable_declaration_list(list) || !list.flags().intersects(NodeFlags::CONST) {
        return None;
    }
    let initializer = declaration.initializer();
    initializer.is_some().then_some(initializer)
}

fn static_value(
    checker: &mut Checker,
    node: Node,
    visited: &mut FxHashSet<SymbolId>,
) -> Option<StaticValue> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    match node.kind() {
        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => {
            return Some(StaticValue::String(node.text()));
        }
        SyntaxKind::NumericLiteral => {
            return go_parse_float(&node.text().replace('_', "")).map(StaticValue::Number);
        }
        SyntaxKind::TrueKeyword => return Some(StaticValue::Boolean(true)),
        SyntaxKind::FalseKeyword => return Some(StaticValue::Boolean(false)),
        SyntaxKind::NullKeyword => return Some(StaticValue::Null),
        SyntaxKind::BigIntLiteral => return parse_big_int_literal(node.text()),
        SyntaxKind::Identifier => {
            match node.text() {
                "undefined" => return Some(StaticValue::Undefined),
                "NaN" => return Some(StaticValue::Number(f64::NAN)),
                "Infinity" => return Some(StaticValue::Number(f64::INFINITY)),
                _ => {}
            }
            let symbol = checker.get_symbol_at_location_exported(node);
            if symbol.is_nil() || visited.contains(&symbol) {
                return None;
            }
            let initializer = const_initializer(checker, symbol)?;
            visited.insert(symbol);
            let value = static_value(checker, initializer, visited);
            visited.remove(&symbol);
            return value;
        }
        SyntaxKind::PrefixUnaryExpression => {
            let operand = static_value(checker, node.operand(), visited)?;
            match node.operator() {
                SyntaxKind::MinusToken => {
                    if let StaticValue::BigInt { is_zero } = operand {
                        return Some(StaticValue::BigInt { is_zero });
                    }
                    return operand.to_number().map(|n| StaticValue::Number(-n));
                }
                SyntaxKind::PlusToken => return operand.to_number().map(StaticValue::Number),
                _ => {}
            }
        }
        SyntaxKind::AsExpression
        | SyntaxKind::TypeAssertionExpression
        | SyntaxKind::NonNullExpression => {
            return static_value(checker, node.expression(), visited);
        }
        _ => {}
    }

    if is_call_expression(node) && node.question_dot_token().is_nil() {
        let callee = skip_parentheses(node.expression());
        if is_identifier(callee) && callee.text() == "Symbol" {
            return Some(StaticValue::Symbol);
        }
        if is_property_access_expression(callee) {
            let object = skip_parentheses(callee.expression());
            if is_identifier(object) && object.text() == "Symbol" && callee.name().text() == "for" {
                return Some(StaticValue::Symbol);
            }
        }
    }
    None
}

/// `node` is `x.<name>` or `x[<static name>]`.
fn is_static_member_access_of_value(checker: &mut Checker, node: Node, name: &str) -> bool {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return false;
    }
    if is_property_access_expression(node) {
        let property = node.name();
        return property.is_some() && property.text() == name;
    }
    if is_element_access_expression(node) {
        let value = static_value(
            checker,
            node.argument_expression(),
            &mut FxHashSet::default(),
        );
        // tsgolint turns the value into a property name first; only a string
        // can spell `filter` or `at`.
        return matches!(value, Some(StaticValue::String(s)) if s == name);
    }
    false
}

/// A union of arrays and tuples (or intersections of them), ignoring
/// `null` and `undefined`, with at least one array member.
fn is_arrayish(checker: &mut Checker, t: TypeId) -> bool {
    let mut has_arrayish_part = false;
    for part in union_type_parts(checker, t).iter().copied() {
        if is_type_null_type(checker, part) || is_type_undefined_type(checker, part) {
            continue;
        }
        let all_arrays = intersection_type_parts(checker, part)
            .iter()
            .all(|&t| checker.is_array_type(t) || checker.is_tuple_type(t));
        if !all_arrays {
            return false;
        }
        has_arrayish_part = true;
    }
    has_arrayish_part
}

/// The `filter` name of a `.filter(...)` call, and whether it is a computed
/// key.
#[derive(Clone, Copy)]
struct FilterExpression {
    filter_node: Node,
    is_bracket_syntax: bool,
}

/// The `.filter(...)` calls that produce `expression`: through a comma
/// expression, and through both branches of a conditional.
fn parse_array_filter_expressions(
    checker: &mut Checker,
    expression: Node,
) -> Vec<FilterExpression> {
    let node = skip_parentheses(expression);
    if node.is_nil() {
        return Vec::new();
    }
    if is_comma_expression(node) {
        return parse_array_filter_expressions(checker, node.right());
    }
    if node.kind() == SyntaxKind::ConditionalExpression {
        let mut consequent = parse_array_filter_expressions(checker, node.when_true());
        if consequent.is_empty() {
            return Vec::new();
        }
        let alternate = parse_array_filter_expressions(checker, node.when_false());
        if alternate.is_empty() {
            return Vec::new();
        }
        consequent.extend(alternate);
        return consequent;
    }
    if !is_call_expression(node) || node.question_dot_token().is_some() {
        return Vec::new();
    }
    let callee = skip_parentheses(node.expression());
    let is_property_access = is_property_access_expression(callee);
    if !is_property_access && !is_element_access_expression(callee) {
        return Vec::new();
    }
    if !is_static_member_access_of_value(checker, callee, "filter") {
        return Vec::new();
    }
    let object_type = get_constrained_type_at_location(checker, callee.expression());
    if !is_arrayish(checker, object_type) {
        return Vec::new();
    }
    let filter = if is_property_access {
        FilterExpression {
            filter_node: callee.name(),
            is_bracket_syntax: false,
        }
    } else {
        FilterExpression {
            filter_node: callee.argument_expression(),
            is_bracket_syntax: true,
        }
    };
    vec![filter]
}

/// The object of `object.at(0)` (any argument that `at` reads as 0).
fn object_if_array_at_zero(checker: &mut Checker, node: Node) -> Option<Node> {
    let arguments = node.arguments();
    if arguments.len() != 1 || node.question_dot_token().is_some() {
        return None;
    }
    let callee = skip_parentheses(node.expression());
    if callee.is_nil()
        || (!is_property_access_expression(callee) && !is_element_access_expression(callee))
    {
        return None;
    }
    if !is_static_member_access_of_value(checker, callee, "at") {
        return None;
    }
    static_value(checker, arguments.get(0), &mut FxHashSet::default())
        .is_some_and(|value| value.is_treated_as_zero_by_array_at())
        .then(|| callee.expression())
}

fn is_member_access_of_zero(checker: &mut Checker, node: Node) -> bool {
    is_element_access_expression(node)
        && node.question_dot_token().is_nil()
        && static_value(
            checker,
            node.argument_expression(),
            &mut FxHashSet::default(),
        )
        .is_some_and(|value| value.is_treated_as_zero_by_member_access())
}

fn check_call(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let Some(object) = object_if_array_at_zero(ctx.checker, node) else {
        return;
    };
    let filters = parse_array_filter_expressions(ctx.checker, object);
    if !filters.is_empty() {
        report_prefer_find(ctx, node, object, filters);
    }
}

fn check_element_access(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if !is_member_access_of_zero(ctx.checker, node) {
        return;
    }
    let object = node.expression();
    let filters = parse_array_filter_expressions(ctx.checker, object);
    if !filters.is_empty() {
        report_prefer_find(ctx, node, object, filters);
    }
}

/// The `.` or `[` that starts the element access after `array`, skipping
/// whitespace, comments and closing parentheses.
fn find_array_element_access_start(ctx: &RuleContext<'_>, array: Node, whole: Node) -> Option<i32> {
    let array_range = ctx.trim_node_text_range(skip_parentheses(array));
    let text = ctx.source_text();
    let bytes = text.as_bytes();
    let end = whole.end() as usize;
    let mut i = array_range.end() as usize;
    while i < end {
        // Go decodes a rune here; a byte that does not start one has size 1.
        let (ch, size) = text
            .get(i..)
            .and_then(|rest| rest.chars().next())
            .map_or(('\u{FFFD}', 1), |ch| (ch, ch.len_utf8()));
        if ch.is_whitespace() {
            i += size;
            continue;
        }
        if bytes[i] == b'/' && i + 1 < end {
            if bytes[i + 1] == b'/' {
                i += 2;
                while i < end && bytes[i] != b'\n' && bytes[i] != b'\r' {
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                i += 2;
                while i + 1 < end && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                if i + 1 < end {
                    i += 2;
                }
                continue;
            }
        }
        if bytes[i] == b'.' || bytes[i] == b'[' {
            return Some(i as i32);
        }
        i += size;
    }
    None
}

fn report_prefer_find(
    ctx: &mut RuleContext<'_>,
    node: Node,
    array: Node,
    filters: Vec<FilterExpression>,
) {
    let Some(start) = find_array_element_access_start(ctx, array, node) else {
        return;
    };
    let remove_fix = RuleFix::remove_range(TextRange::new(start, node.end()));
    ctx.report_node_with_suggestions(node, prefer_find_message(), |ctx| {
        let mut fixes: Vec<RuleFix> = filters
            .iter()
            .map(|filter| {
                let replacement = if filter.is_bracket_syntax {
                    "\"find\""
                } else {
                    "find"
                };
                RuleFix::replace_range(ctx.trim_node_text_range(filter.filter_node), replacement)
            })
            .collect();
        fixes.push(remove_fix);
        vec![RuleSuggestion {
            message: prefer_find_suggestion_message(),
            fixes,
        }]
    });
}

#[cfg(test)]
mod tests {
    use super::string_to_number;

    #[test]
    fn radix_integers_take_one_sign_as_go_big_int_does() {
        assert_eq!(string_to_number("0x-5"), -5.0);
        assert_eq!(string_to_number("0x+5"), 5.0);
        assert_eq!(string_to_number("-0x5"), -5.0);
        assert_eq!(string_to_number(" 0b-11 "), -3.0);
        assert!(string_to_number("-0x-5").is_nan());
        assert!(string_to_number("+0x-5").is_nan());
        assert!(string_to_number("0x-").is_nan());
        assert!(string_to_number("0x1_0").is_nan());
    }
}
