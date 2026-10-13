//! `prefer-string-starts-ends-with`: prefers `startsWith()` and
//! `endsWith()` over index, `indexOf`, `lastIndexOf`, `match`, `slice`,
//! `substring` and `RegExp#test` checks.

use goport_core::ast::{
    TextRange, is_binary_expression, is_call_expression, is_element_access_expression,
    is_identifier, is_literal_expression, is_new_expression, is_numeric_literal,
    is_prefix_unary_expression, is_property_access_expression, is_string_literal,
    is_variable_declaration, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::gostd::strconv::quote;
use goport_core::gostd::unicode::is_digit;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_type_name, go_parse_float, is_null_literal, is_property_or_element_access,
    is_undefined_literal,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-string-starts-ends-with",
    create,
};

#[derive(Deserialize, Clone, Copy, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AllowSingleElementEquality {
    Always,
    #[default]
    Never,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_single_element_equality: AllowSingleElementEquality,
}

fn prefer_starts_with_message() -> RuleMessage {
    RuleMessage::new(
        "preferStartsWith",
        "Use 'String#startsWith' method instead.",
    )
}

fn prefer_ends_with_message() -> RuleMessage {
    RuleMessage::new("preferEndsWith", "Use 'String#endsWith' method instead.")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Start,
    End,
}

impl Kind {
    fn message(self) -> RuleMessage {
        match self {
            Kind::Start => prefer_starts_with_message(),
            Kind::End => prefer_ends_with_message(),
        }
    }

    fn method(self) -> &'static str {
        match self {
            Kind::Start => "startsWith",
            Kind::End => "endsWith",
        }
    }
}

/// A regular expression that only tests a literal prefix or suffix.
struct ParsedRegExp {
    kind: Kind,
    text: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Nullish {
    Null,
    Undefined,
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::BinaryExpression, check_binary)
        .on(SyntaxKind::CallExpression, check_regex_test_call)
        .into()
}

fn check_binary(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    if !matches!(
        node.operator_token().kind(),
        SyntaxKind::EqualsEqualsToken
            | SyntaxKind::EqualsEqualsEqualsToken
            | SyntaxKind::ExclamationEqualsToken
            | SyntaxKind::ExclamationEqualsEqualsToken
    ) {
        return;
    }
    let left = skip_parentheses(node.left());
    if left.is_nil() {
        return;
    }
    if is_element_access_expression(left) {
        report_string_index_or_char_at(options, ctx, node, left, left.argument_expression());
    } else if is_call_expression(left) {
        check_binary_call(options, ctx, node, left);
    }
}

fn is_negative_equality(binary: Node) -> bool {
    matches!(
        binary.operator_token().kind(),
        SyntaxKind::ExclamationEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken
    )
}

fn is_loose_equality(binary: Node) -> bool {
    matches!(
        binary.operator_token().kind(),
        SyntaxKind::EqualsEqualsToken | SyntaxKind::ExclamationEqualsToken
    )
}

fn member_object(node: Node) -> Node {
    if is_property_or_element_access(node) {
        node.expression()
    } else {
        Node::NIL
    }
}

/// `?.` for an optional member access, else `.`.
fn member_access_operator(node: Node) -> &'static str {
    let optional = is_property_or_element_access(node) && node.question_dot_token().is_some();
    if optional { "?." } else { "." }
}

fn property_name(node: Node) -> Option<&'static str> {
    if is_property_access_expression(node) {
        let name = node.name();
        return name.is_some().then(|| name.text());
    }
    if is_element_access_expression(node) {
        let argument = skip_parentheses(node.argument_expression());
        if argument.is_some()
            && (is_string_literal(argument)
                || argument.kind() == SyntaxKind::NoSubstitutionTemplateLiteral)
        {
            return Some(argument.text());
        }
    }
    None
}

/// From the token after the object (`.`, `?.` or `[`) to the end of the
/// member access.
fn property_range(ctx: &RuleContext<'_>, member: Node) -> TextRange {
    let object = member_object(member);
    let member_range = ctx.trim_node_text_range(member);
    if object.is_nil() {
        return member_range;
    }
    token_range_at(ctx.source_file, object.end()).with_end(member_range.end())
}

/// The member access callee of a call, inside parentheses.
fn call_member_callee(call: Node) -> Node {
    let callee = skip_parentheses(call.expression());
    if is_property_or_element_access(callee) {
        callee
    } else {
        Node::NIL
    }
}

fn is_string_type(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    let t = ctx.checker.get_type_at_location(skip_parentheses(node));
    get_type_name(ctx.checker, t) == "string"
}

/// The text of `node` without parentheses and white space.
fn normalized_node_text(ctx: &RuleContext<'_>, node: Node) -> String {
    ctx.node_text(skip_parentheses(node))
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect()
}

fn is_same_tokens(ctx: &RuleContext<'_>, a: Node, b: Node) -> bool {
    normalized_node_text(ctx, a) == normalized_node_text(ctx, b)
}

/// A number literal, possibly negated.
fn static_number(node: Node) -> Option<f64> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    if is_numeric_literal(node) {
        return go_parse_float(&node.text().replace('_', ""));
    }
    if is_prefix_unary_expression(node) && node.operator() == SyntaxKind::MinusToken {
        return static_number(node.operand()).map(|n| -n);
    }
    None
}

fn is_static_number(node: Node, value: f64) -> bool {
    static_number(node) == Some(value)
}

/// The initializer of the variable that `node` names.
fn variable_initializer(ctx: &mut RuleContext<'_>, node: Node) -> Node {
    let symbol = ctx.checker.get_symbol_at_location_exported(node);
    if symbol.is_nil() {
        return Node::NIL;
    }
    let declaration = ctx.checker.sym(symbol).value_declaration;
    if declaration.is_nil() || !is_variable_declaration(declaration) {
        return Node::NIL;
    }
    declaration.initializer()
}

/// A string literal, or a variable initialized with one (`let` too).
fn static_string(ctx: &mut RuleContext<'_>, node: Node) -> Option<&'static str> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    if is_string_literal(node) || node.kind() == SyntaxKind::NoSubstitutionTemplateLiteral {
        return Some(node.text());
    }
    if is_identifier(node) {
        let initializer = variable_initializer(ctx, node);
        if initializer.is_some() {
            return static_string(ctx, initializer);
        }
    }
    None
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_character(ctx: &mut RuleContext<'_>, node: Node) -> bool {
    static_string(ctx, node).is_some_and(|value| utf16_len(value) == 1)
}

fn nullish_kind(ctx: &mut RuleContext<'_>, node: Node) -> Option<Nullish> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    if is_null_literal(node) {
        return Some(Nullish::Null);
    }
    if is_undefined_literal(node) {
        return Some(Nullish::Undefined);
    }
    if is_identifier(node) {
        let initializer = variable_initializer(ctx, node);
        if initializer.is_some() {
            return nullish_kind(ctx, initializer);
        }
    }
    None
}

/// `expected.length`, or a number equal to the length of the static string
/// `expected`.
fn is_length_expression(ctx: &mut RuleContext<'_>, node: Node, expected: Node) -> bool {
    let node = skip_parentheses(node);
    let expected = skip_parentheses(expected);
    if node.is_nil() || expected.is_nil() {
        return false;
    }
    if is_property_or_element_access(node) && property_name(node) == Some("length") {
        let object = member_object(node);
        if object.is_some() && is_same_tokens(ctx, object, expected) {
            return true;
        }
    }
    let Some(length) = static_number(node) else {
        return false;
    };
    let Some(string) = static_string(ctx, expected) else {
        return false;
    };
    length == utf16_len(string) as f64
}

/// `-substring.length` or `parent.length - substring.length`.
fn is_length_ahead_of_end(
    ctx: &mut RuleContext<'_>,
    node: Node,
    substring: Node,
    parent: Node,
) -> bool {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return false;
    }
    if is_prefix_unary_expression(node) {
        return node.operator() == SyntaxKind::MinusToken
            && is_length_expression(ctx, node.operand(), substring);
    }
    if is_binary_expression(node) {
        return node.operator_token().kind() == SyntaxKind::MinusToken
            && is_length_expression(ctx, node.left(), parent)
            && is_length_expression(ctx, node.right(), substring);
    }
    false
}

/// `expected.length - 1`.
fn is_last_index_expression(ctx: &mut RuleContext<'_>, node: Node, expected: Node) -> bool {
    let node = skip_parentheses(node);
    is_binary_expression(node)
        && node.operator_token().kind() == SyntaxKind::MinusToken
        && is_length_expression(ctx, node.left(), expected)
        && is_static_number(node.right(), 1.0)
}

/// The pattern and flags of a regular expression literal, split at the last
/// unescaped `/`.
fn split_regex_literal(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'/' {
        return None;
    }
    let closing_slash = (1..bytes.len()).rev().find(|&i| {
        bytes[i] == b'/' && bytes[..i].iter().rev().take_while(|&&b| b == b'\\').count() % 2 == 0
    })?;
    Some((&text[1..closing_slash], &text[closing_slash + 1..]))
}

/// The literal text of a `^text` or `text$` pattern.
fn parse_regexp_text(pattern: &str) -> Option<String> {
    let starts_with = pattern.starts_with('^');
    if starts_with == pattern.ends_with('$') {
        return None;
    }
    let content = if starts_with {
        &pattern[1..]
    } else {
        &pattern[..pattern.len() - 1]
    };
    let mut text = String::new();
    let mut escaped = false;
    for ch in content.chars() {
        if escaped {
            escaped = false;
            text.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'v' => '\u{b}',
                'f' => '\u{c}',
                '0' => '\0',
                'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'b' | 'B' | 'c' | 'x' | 'u' | 'k' | 'p'
                | 'P' => return None,
                ch if is_digit(ch) => return None,
                ch => ch,
            });
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '.' | '*' | '+' | '?' | '|' | '^' | '$' | '[' | ']' | '(' | ')' | '{' | '}' => {
                return None;
            }
            ch => text.push(ch),
        }
    }
    (!escaped).then_some(text)
}

/// A regular expression literal, `new RegExp('...')`, or a variable
/// initialized with one, that tests a literal prefix or suffix.
fn parse_regexp(ctx: &mut RuleContext<'_>, node: Node) -> Option<ParsedRegExp> {
    let node = skip_parentheses(node);
    if node.is_nil() {
        return None;
    }
    let (pattern, flags) = if node.kind() == SyntaxKind::RegularExpressionLiteral {
        split_regex_literal(node.text())?
    } else if is_new_expression(node) {
        let callee = node.expression();
        if !is_identifier(callee) || callee.text() != "RegExp" {
            return None;
        }
        let arguments = node.arguments();
        let pattern = arguments.first().filter(|&a| is_string_literal(a))?;
        let flags = match arguments.len() {
            0 | 1 => "",
            _ => {
                let flags = arguments.get(1);
                if !is_string_literal(flags) {
                    return None;
                }
                flags.text()
            }
        };
        (pattern.text(), flags)
    } else if is_identifier(node) {
        let initializer = variable_initializer(ctx, node);
        if initializer.is_nil() {
            return None;
        }
        return parse_regexp(ctx, initializer);
    } else {
        return None;
    };

    if flags.contains(['i', 'm', 'g', 'y']) {
        return None;
    }
    let starts_with = pattern.starts_with('^');
    if starts_with == pattern.ends_with('$') {
        return None;
    }
    let text = parse_regexp_text(pattern)?;
    Some(ParsedRegExp {
        kind: if starts_with { Kind::Start } else { Kind::End },
        text,
    })
}

/// `s.<kind>sWith(<right operand>)`, negated for `!=` and `!==`.
fn fix_with_right_operand(
    ctx: &RuleContext<'_>,
    binary: Node,
    member: Node,
    kind: Kind,
) -> Vec<RuleFix> {
    let mut fixes = Vec::new();
    if is_negative_equality(binary) {
        fixes.push(ctx.fix_insert_before(binary, "!"));
    }
    let property_range = property_range(ctx, member);
    let right_range = ctx.trim_node_text_range(skip_parentheses(binary.right()));
    let binary_range = ctx.trim_node_text_range(binary);
    fixes.push(RuleFix::replace_range(
        property_range.with_end(right_range.pos()),
        format!("{}{}(", member_access_operator(member), kind.method()),
    ));
    fixes.push(RuleFix::replace_range(
        right_range
            .with_pos(right_range.end())
            .with_end(binary_range.end()),
        ")",
    ));
    fixes
}

/// `s.<kind>sWith(<call arguments>)`, negated for `!=` and `!==`.
fn fix_with_argument(
    ctx: &RuleContext<'_>,
    binary: Node,
    call: Node,
    member: Node,
    kind: Kind,
) -> Vec<RuleFix> {
    let mut fixes = Vec::new();
    if is_negative_equality(binary) {
        fixes.push(ctx.fix_insert_before(binary, "!"));
    }
    let property_range = property_range(ctx, member);
    let call_range = ctx.trim_node_text_range(call);
    let binary_range = ctx.trim_node_text_range(binary);
    fixes.push(RuleFix::replace_range(
        property_range,
        format!("{}{}", member_access_operator(member), kind.method()),
    ));
    fixes.push(RuleFix::remove_range(
        call_range
            .with_pos(call_range.end())
            .with_end(binary_range.end()),
    ));
    fixes
}

/// `s[0] === 'a'`, `s.charAt(s.length - 1) === 'a'`, ...
fn report_string_index_or_char_at(
    options: &Options,
    ctx: &mut RuleContext<'_>,
    binary: Node,
    member: Node,
    index: Node,
) {
    let object = member_object(member);
    if object.is_nil() || !is_string_type(ctx, object) {
        return;
    }
    let allow_single_element_equality =
        options.allow_single_element_equality == AllowSingleElementEquality::Always;
    let is_ends_with = is_last_index_expression(ctx, index, object);
    if allow_single_element_equality && is_ends_with {
        return;
    }
    let starts_at_zero = !is_ends_with && is_static_number(index, 0.0);
    if allow_single_element_equality && starts_at_zero {
        return;
    }
    if !starts_at_zero && !is_ends_with {
        return;
    }
    let kind = if starts_at_zero {
        Kind::Start
    } else {
        Kind::End
    };
    ctx.report_node_with_fixes(binary, kind.message(), |ctx| {
        if !is_character(ctx, binary.right()) {
            return Vec::new();
        }
        fix_with_right_operand(ctx, binary, member, kind)
    });
}

fn check_binary_call(options: &Options, ctx: &mut RuleContext<'_>, binary: Node, call: Node) {
    let member = call_member_callee(call);
    if member.is_nil() {
        return;
    }
    let Some(name) = property_name(member) else {
        return;
    };
    let arguments = call.arguments();
    let right = binary.right();
    match name {
        "charAt" if arguments.len() == 1 => {
            report_string_index_or_char_at(options, ctx, binary, member, arguments.get(0));
        }
        "indexOf" => {
            if arguments.len() != 1 || !is_static_number(right, 0.0) {
                return;
            }
            let object = member_object(member);
            if object.is_nil() || !is_string_type(ctx, object) {
                return;
            }
            ctx.report_node_with_fixes(binary, prefer_starts_with_message(), |ctx| {
                fix_with_argument(ctx, binary, call, member, Kind::Start)
            });
        }
        "lastIndexOf" => {
            if arguments.len() != 1 || !is_binary_expression(right) {
                return;
            }
            if right.operator_token().kind() != SyntaxKind::MinusToken {
                return;
            }
            let object = member_object(member);
            if object.is_nil() || !is_string_type(ctx, object) {
                return;
            }
            if !is_length_expression(ctx, right.left(), object)
                || !is_length_expression(ctx, right.right(), arguments.get(0))
            {
                return;
            }
            ctx.report_node_with_fixes(binary, prefer_ends_with_message(), |ctx| {
                fix_with_argument(ctx, binary, call, member, Kind::End)
            });
        }
        "match" => check_match(ctx, binary, call, member),
        "slice" | "substring" => check_slice(ctx, binary, call, member, name),
        _ => {}
    }
}

/// `s.match(/^a/) !== null` and friends.
fn check_match(ctx: &mut RuleContext<'_>, binary: Node, call: Node, member: Node) {
    let arguments = call.arguments();
    if arguments.len() != 1 {
        return;
    }
    let object = member_object(member);
    let nullish = nullish_kind(ctx, binary.right());
    if object.is_nil() || !is_string_type(ctx, object) {
        return;
    }
    let Some(nullish) = nullish else {
        return;
    };
    // `match` gives `null`, so only `null` or a loose comparison works.
    if !is_loose_equality(binary) && nullish != Nullish::Null {
        return;
    }
    let argument = arguments.get(0);
    let Some(parsed) = parse_regexp(ctx, argument) else {
        return;
    };
    ctx.report_node_with_fixes(binary, parsed.kind.message(), |ctx| {
        let mut fixes = Vec::new();
        // `match(...) === null` means the string does not match.
        if !is_negative_equality(binary) {
            fixes.push(ctx.fix_insert_before(binary, "!"));
        }
        let property_range = property_range(ctx, member);
        let call_range = ctx.trim_node_text_range(call);
        let argument_range = ctx.trim_node_text_range(argument);
        let binary_range = ctx.trim_node_text_range(binary);
        fixes.push(RuleFix::replace_range(
            property_range,
            format!("{}{}", member_access_operator(member), parsed.kind.method()),
        ));
        fixes.push(RuleFix::replace_range(argument_range, quote(&parsed.text)));
        fixes.push(RuleFix::remove_range(
            call_range
                .with_pos(call_range.end())
                .with_end(binary_range.end()),
        ));
        fixes
    });
}

/// `s.slice(0, 3) === 'abc'`, `s.substring(s.length - 3) === 'abc'`, ...
fn check_slice(ctx: &mut RuleContext<'_>, binary: Node, call: Node, member: Node, name: &str) {
    let object = member_object(member);
    if object.is_nil() || !is_string_type(ctx, object) {
        return;
    }
    let arguments = call.arguments();
    let right = binary.right();
    let kind = match arguments.len() {
        1 if is_length_ahead_of_end(ctx, arguments.get(0), right, object) => Kind::End,
        2 => {
            let (start, end) = (arguments.get(0), arguments.get(1));
            if is_static_number(start, 0.0) && is_length_expression(ctx, end, right) {
                Kind::Start
            } else if (is_length_expression(ctx, end, object) || is_static_number(end, 0.0))
                && is_length_ahead_of_end(ctx, start, right, object)
            {
                Kind::End
            } else {
                return;
            }
        }
        _ => return,
    };
    let is_slice = name == "slice";
    ctx.report_node_with_fixes(binary, kind.message(), |ctx| {
        if is_loose_equality(binary) && !is_string_literal(skip_parentheses(right)) {
            return Vec::new();
        }
        if kind == Kind::Start {
            if arguments.len() < 2 || !is_length_expression(ctx, arguments.get(1), right) {
                return Vec::new();
            }
        } else {
            let position = skip_parentheses(arguments.get(0));
            let valid_position = if is_binary_expression(position) {
                position.operator_token().kind() == SyntaxKind::MinusToken
                    && is_length_expression(ctx, position.left(), object)
                    && is_length_expression(ctx, position.right(), right)
            } else if is_slice && is_prefix_unary_expression(position) {
                position.operator() == SyntaxKind::MinusToken
                    && is_length_expression(ctx, position.operand(), right)
            } else {
                false
            };
            if !valid_position {
                return Vec::new();
            }
        }
        fix_with_right_operand(ctx, binary, member, kind)
    });
}

/// `/^a/.test(s)` becomes `s.startsWith("a")`.
fn check_regex_test_call(_: &mut Options, ctx: &mut RuleContext<'_>, call: Node) {
    let arguments = call.arguments();
    if arguments.len() != 1 {
        return;
    }
    let member = call_member_callee(call);
    if member.is_nil() || property_name(member) != Some("test") {
        return;
    }
    let object = member_object(member);
    if object.is_nil() {
        return;
    }
    let Some(parsed) = parse_regexp(ctx, object) else {
        return;
    };
    let argument = skip_parentheses(arguments.get(0));
    ctx.report_node_with_fixes(call, parsed.kind.message(), |ctx| {
        let needs_parens = !is_literal_expression(argument)
            && !matches!(
                argument.kind(),
                SyntaxKind::NoSubstitutionTemplateLiteral
                    | SyntaxKind::TemplateExpression
                    | SyntaxKind::Identifier
                    | SyntaxKind::PropertyAccessExpression
                    | SyntaxKind::ElementAccessExpression
                    | SyntaxKind::CallExpression
            );
        let call_range = ctx.trim_node_text_range(call);
        let argument_range = ctx.trim_node_text_range(argument);
        let mut fixes = vec![RuleFix::remove_range(
            call_range.with_end(argument_range.pos()),
        )];
        if needs_parens {
            fixes.extend(ctx.fix_wrap_in_parens(argument));
        }
        fixes.push(RuleFix::insert_after(
            argument,
            format!(
                "{}{}({}",
                member_access_operator(member),
                parsed.kind.method(),
                quote(&parsed.text)
            ),
        ));
        fixes
    });
}
