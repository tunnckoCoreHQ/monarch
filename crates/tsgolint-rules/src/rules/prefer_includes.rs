//! `prefer-includes`: prefers `includes()` over `indexOf()` comparisons and
//! `String#includes()` over `RegExp#test()` with a literal pattern.

use goport_core::ast::{TextRange, get_source_file_of_node, is_function_like, is_identifier};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, SymbolId};
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, range_text,
};

use crate::utils::{get_constrained_type_at_location, is_valid_regexp_pattern};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-includes",
    create,
};

fn prefer_includes_message() -> RuleMessage {
    RuleMessage::new("preferIncludes", "Use 'includes()' method instead.")
}

fn prefer_string_includes_message() -> RuleMessage {
    RuleMessage::new(
        "preferStringIncludes",
        "Use `String#includes()` method with a string instead.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_regexp_test)
        .on(SyntaxKind::BinaryExpression, check_index_of)
        .into()
}

/// `/bar/.test(a)` becomes `a.includes('bar')`.
fn check_regexp_test(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    if callee.kind() != SyntaxKind::PropertyAccessExpression {
        return;
    }
    let name = callee.name();
    if !is_identifier(name) || name.text() != "test" {
        return;
    }
    let arguments = node.arguments();
    if arguments.len() != 1 {
        return;
    }
    let Some(pattern) = resolve_regex_pattern(ctx, callee.expression()) else {
        return;
    };

    let argument = arguments.get(0);
    let argument_type = get_constrained_type_at_location(ctx.checker, argument);
    if argument_type.is_nil() {
        return;
    }
    let includes = ctx.checker.get_property_of_type(argument_type, "includes");
    if includes.is_nil() || ctx.checker.sym(includes).declarations.is_empty() {
        return;
    }

    // Member access binds tightly, so only operands such as `a + b` need
    // parentheses.
    let needs_parens = !matches!(
        argument.kind(),
        SyntaxKind::Identifier
            | SyntaxKind::StringLiteral
            | SyntaxKind::NumericLiteral
            | SyntaxKind::NoSubstitutionTemplateLiteral
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::CallExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::ParenthesizedExpression
    );
    let call_range = ctx.trim_node_text_range(node);
    let (start, end) = (argument.pos(), argument.end());
    let mut fixes = vec![
        RuleFix::remove_range(TextRange::new(call_range.pos(), start)),
        RuleFix::remove_range(TextRange::new(end, call_range.end())),
    ];
    if needs_parens {
        fixes.push(RuleFix::replace_range(TextRange::new(start, start), "("));
        fixes.push(RuleFix::replace_range(TextRange::new(end, end), ")"));
    }
    // The pattern keeps its escapes; only quotes need escaping.
    let escaped = pattern.replace('\'', "\\'");
    fixes.push(RuleFix::replace_range(
        TextRange::new(end, end),
        format!(".includes('{escaped}')"),
    ));
    ctx.report_node_with_fixes(node, prefer_string_includes_message(), |_| fixes);
}

/// `a.indexOf(b) !== -1` becomes `a.includes(b)`.
fn check_index_of(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let call = node.left();
    if call.kind() != SyntaxKind::CallExpression {
        return;
    }
    let callee = call.expression();
    if callee.kind() != SyntaxKind::PropertyAccessExpression {
        return;
    }
    let name = callee.name();
    if !is_identifier(name) || name.text() != "indexOf" {
        return;
    }

    let operator = node.operator_token().kind();
    let right = node.right();
    let is_positive = match operator {
        SyntaxKind::ExclamationEqualsEqualsToken
        | SyntaxKind::ExclamationEqualsToken
        | SyntaxKind::GreaterThanToken => is_number_literal(right, -1),
        SyntaxKind::GreaterThanEqualsToken => is_number_literal(right, 0),
        _ => false,
    };
    let is_negative = match operator {
        SyntaxKind::EqualsEqualsEqualsToken
        | SyntaxKind::EqualsEqualsToken
        | SyntaxKind::LessThanEqualsToken => is_number_literal(right, -1),
        SyntaxKind::LessThanToken => is_number_literal(right, 0),
        _ => false,
    };
    if !is_positive && !is_negative {
        return;
    }

    let index_of = ctx.checker.get_symbol_at_location_exported(name);
    if index_of.is_nil() || !index_of_has_compatible_includes(ctx, index_of) {
        return;
    }

    let mut fixes = vec![
        RuleFix::replace_range(ctx.trim_node_text_range(name), "includes"),
        RuleFix::remove_range(TextRange::new(call.end(), node.end())),
    ];
    if is_negative {
        let start = ctx.trim_node_text_range(call).pos();
        fixes.push(RuleFix::replace_range(TextRange::new(start, start), "!"));
    }
    ctx.report_node_with_fixes(node, prefer_includes_message(), |_| fixes);
}

/// `node` is the number literal `value`, or `-` and a number literal.
fn is_number_literal(node: Node, value: i64) -> bool {
    // Go's `strconv.Atoi` on the literal text: decimal integers only.
    let parse = |literal: Node| literal.text().parse::<i64>().ok();
    match node.kind() {
        SyntaxKind::NumericLiteral => parse(node) == Some(value),
        SyntaxKind::PrefixUnaryExpression => {
            let operand = node.operand();
            node.operator() == SyntaxKind::MinusToken
                && operand.kind() == SyntaxKind::NumericLiteral
                && parse(operand).map(|n| -n) == Some(value)
        }
        _ => false,
    }
}

/// Every declaration of `indexOf` has an `includes` declaration with the
/// same parameter text on the type that declares it.
fn index_of_has_compatible_includes(ctx: &mut RuleContext<'_>, index_of: SymbolId) -> bool {
    let declarations = ctx.checker.sym(index_of).declarations.clone();
    if declarations.is_empty() {
        return false;
    }
    declarations.iter().all(|&index_of_declaration| {
        let container = index_of_declaration.parent();
        if container.is_nil() {
            return false;
        }
        let t = ctx.checker.get_type_at_location(container);
        if t.is_nil() {
            return false;
        }
        let includes = ctx.checker.get_property_of_type(t, "includes");
        if includes.is_nil() {
            return false;
        }
        ctx.checker
            .sym(includes)
            .declarations
            .iter()
            .any(|&includes_declaration| {
                has_same_parameters(index_of_declaration, includes_declaration)
            })
    })
}

/// Both are function-like with parameters of the same text (name, type
/// and optionality, with the trivia before each).
fn has_same_parameters(a: Node, b: Node) -> bool {
    if !is_function_like(a) || !is_function_like(b) {
        return false;
    }
    let (parameters_a, parameters_b) = (a.parameters(), b.parameters());
    if parameters_a.len() != parameters_b.len() {
        return false;
    }
    parameters_a.iter().zip(parameters_b.iter()).all(|(a, b)| {
        let (file_a, file_b) = (get_source_file_of_node(a), get_source_file_of_node(b));
        if file_a.is_nil() || file_b.is_nil() {
            return false;
        }
        range_text(file_a, a.loc()) == range_text(file_b, b.loc())
    })
}

/// A literal pattern from `/bar/`, or from a variable initialized with
/// `/bar/` or `new RegExp('bar')`.
fn resolve_regex_pattern(ctx: &mut RuleContext<'_>, node: Node) -> Option<&'static str> {
    regex_literal_pattern(node).or_else(|| variable_pattern(ctx, node))
}

fn variable_pattern(ctx: &mut RuleContext<'_>, node: Node) -> Option<&'static str> {
    if !is_identifier(node) {
        return None;
    }
    let symbol = ctx.checker.get_symbol_at_location_exported(node);
    if symbol.is_nil() {
        return None;
    }
    let declaration = ctx.checker.sym(symbol).value_declaration;
    if declaration.is_nil() || declaration.kind() != SyntaxKind::VariableDeclaration {
        return None;
    }
    let initializer = declaration.initializer();
    if initializer.is_nil() {
        return None;
    }
    regex_literal_pattern(initializer).or_else(|| reg_exp_constructor_pattern(initializer))
}

/// `/bar/` without flags gives `bar`.
fn regex_literal_pattern(node: Node) -> Option<&'static str> {
    if node.kind() != SyntaxKind::RegularExpressionLiteral {
        return None;
    }
    let text = node.text();
    if text.len() < 3 || !text.starts_with('/') {
        return None;
    }
    // tsgolint takes the last `/`, escaped or not.
    let last_slash = text.rfind('/').filter(|&i| i > 0)?;
    let (pattern, flags) = (&text[1..last_slash], &text[last_slash + 1..]);
    if !flags.is_empty() {
        return None;
    }
    literal_pattern(pattern)
}

/// `new RegExp('bar')` gives `bar`.
fn reg_exp_constructor_pattern(node: Node) -> Option<&'static str> {
    if node.kind() != SyntaxKind::NewExpression {
        return None;
    }
    let callee = node.expression();
    if callee.kind() != SyntaxKind::Identifier || callee.text() != "RegExp" {
        return None;
    }
    let pattern = node.arguments().first()?;
    if pattern.kind() != SyntaxKind::StringLiteral {
        return None;
    }
    literal_pattern(pattern.text())
}

/// `pattern` when it matches only its own text and compiles. tsgolint
/// treats an empty pattern as no pattern.
fn literal_pattern(pattern: &'static str) -> Option<&'static str> {
    (!pattern.is_empty() && is_simple_literal_pattern(pattern) && is_valid_regexp_pattern(pattern))
        .then_some(pattern)
}

/// No unescaped metacharacter and no escape that is a character class or
/// a code point escape. typescript-eslint parses the pattern with regexpp;
/// tsgolint only looks at the previous character, so in `\\.` the `.`
/// counts as escaped.
fn is_simple_literal_pattern(pattern: &str) -> bool {
    let mut previous = '\0';
    for ch in pattern.chars() {
        if previous != '\\' {
            if matches!(
                ch,
                '.' | '*' | '+' | '?' | '|' | '^' | '$' | '[' | ']' | '(' | ')' | '{' | '}'
            ) {
                return false;
            }
        } else if matches!(
            ch,
            'd' | 'D' | 'w' | 'W' | 's' | 'S' | 'b' | 'B' | 'c' | 'x' | 'u'
        ) {
            return false;
        }
        previous = ch;
    }
    true
}
