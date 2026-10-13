//! `dot-notation`: enforces dot notation where possible.

use goport_core::ast::{
    has_modifier, is_get_accessor_declaration, is_identifier, is_numeric_literal,
    is_set_accessor_declaration, is_write_access,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, SymbolId};
use goport_core::flags::ModifierFlags;
use goport_core::scanner_util::{is_identifier_part, skip_trivia};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    TextRange, decode_options,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "dot-notation",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_index_signature_property_access: bool,
    allow_keywords: bool,
    allow_pattern: String,
    allow_private_class_property_access: bool,
    allow_protected_class_property_access: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_index_signature_property_access: false,
            allow_keywords: true,
            allow_pattern: String::new(),
            allow_private_class_property_access: false,
            allow_protected_class_property_access: false,
        }
    }
}

struct State {
    options: Options,
    allow_regex: Option<Regex>,
    /// `allowIndexSignaturePropertyAccess` or the compiler option
    /// `noPropertyAccessFromIndexSignature`.
    index_signature_access_allowed: bool,
    no_property_access_from_index_signature: bool,
}

const ES3_KEYWORDS: &[&str] = &[
    "abstract",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "double",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "function",
    "goto",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "volatile",
    "while",
    "with",
];

fn use_dot_message(key: &str) -> RuleMessage {
    RuleMessage::new(
        "useDot",
        format!("[{key}] is better written in dot notation."),
    )
}

fn use_brackets_message(key: &str) -> RuleMessage {
    RuleMessage::new("useBrackets", format!(".{key} is a syntax error."))
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let allow_regex = (!options.allow_pattern.is_empty()).then(|| {
        Regex::new(&options.allow_pattern).unwrap_or_else(|err| {
            panic!(
                "dot-notation: invalid allowPattern {:?}: {err}",
                options.allow_pattern
            )
        })
    });
    let no_property_access_from_index_signature = ctx
        .compiler_options()
        .no_property_access_from_index_signature
        .is_true();
    let state = State {
        index_signature_access_allowed: options.allow_index_signature_property_access
            || no_property_access_from_index_signature,
        no_property_access_from_index_signature,
        allow_regex,
        options,
    };
    Listeners::new(state)
        .on(
            Listener::exit(SyntaxKind::ElementAccessExpression),
            check_element_access,
        )
        .on(SyntaxKind::PropertyAccessExpression, check_property_access)
        .into()
}

fn is_keyword(name: &str) -> bool {
    ES3_KEYWORDS.contains(&name)
}

/// ESLint's `validIdentifier` test: an ASCII identifier.
fn is_dot_notation_identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_' || first == b'$')
        && bytes.all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'$')
}

/// The value of a computed key and its text in the message.
fn computed_property_value(node: Node) -> Option<(String, String)> {
    match node.kind() {
        SyntaxKind::StringLiteral => {
            let value = node.text();
            // Go `strconv.Quote`; reported values are ASCII identifiers.
            Some((value.to_owned(), format!("\"{value}\"")))
        }
        SyntaxKind::TrueKeyword => Some(("true".to_owned(), "true".to_owned())),
        SyntaxKind::FalseKeyword => Some(("false".to_owned(), "false".to_owned())),
        SyntaxKind::NullKeyword => Some(("null".to_owned(), "null".to_owned())),
        SyntaxKind::NoSubstitutionTemplateLiteral => {
            let value = node.text();
            Some((value.to_owned(), format!("`{value}`")))
        }
        _ => None,
    }
}

fn static_property_name(node: Node) -> Option<&'static str> {
    match node.kind() {
        SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral => Some(node.text()),
        _ => None,
    }
}

/// A numeric literal written as a decimal integer (`1.foo` would not parse).
fn is_decimal_integer(node: Node) -> bool {
    if !is_numeric_literal(node) {
        return false;
    }
    let text = node.text();
    if text.is_empty() || text.contains(|ch| ".eExXoObBnN".contains(ch)) {
        return false;
    }
    text.char_indices()
        .all(|(i, ch)| ch.is_ascii_digit() || (ch == '_' && i > 0 && i < text.len() - 1))
}

fn needs_space_after_identifier(text: &str, end: i32) -> bool {
    let next = skip_trivia(text, end);
    if next != end || next as usize >= text.len() {
        return false;
    }
    text[next as usize..]
        .chars()
        .next()
        .is_some_and(is_identifier_part)
}

fn check_element_access(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if should_skip_for_type_aware_allowances(state, ctx, node) {
        return;
    }
    report_computed_property(state, ctx, node);
}

fn report_computed_property(state: &State, ctx: &mut RuleContext<'_>, node: Node) {
    let property = node.argument_expression();
    let Some((value, formatted)) = computed_property_value(property) else {
        return;
    };
    if !is_dot_notation_identifier(&value)
        || (!state.options.allow_keywords && is_keyword(&value))
        || state
            .allow_regex
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(&value))
    {
        return;
    }

    ctx.report_node_with_fixes(property, use_dot_message(&formatted), |ctx| {
        let object = node.expression();
        let object_range = ctx.trim_node_text_range(object);
        let property_range = ctx.trim_node_text_range(property);
        let left_bracket = token_range_at(ctx.source_file, object_range.end());
        let right_bracket = token_range_at(ctx.source_file, property_range.end());

        let mut fixes = Vec::with_capacity(3);
        let question_dot = node.question_dot_token();
        let replace_start = if question_dot.is_nil() {
            let dot = if is_decimal_integer(object) {
                " ."
            } else {
                "."
            };
            fixes.push(RuleFix::replace_range(
                TextRange::new(left_bracket.pos(), left_bracket.pos()),
                dot,
            ));
            left_bracket.pos()
        } else {
            question_dot.end()
        };
        fixes.push(RuleFix::replace_range(
            TextRange::new(replace_start, right_bracket.end()),
            value.as_str(),
        ));
        if needs_space_after_identifier(&ctx.source_text(), node.end()) {
            fixes.push(RuleFix::insert_after(node, " "));
        }
        fixes
    });
}

fn check_property_access(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if state.options.allow_keywords {
        return;
    }
    let property = node.name();
    if !is_identifier(property) {
        return;
    }
    let name = property.text();
    if !is_keyword(name) {
        return;
    }
    ctx.report_node_with_fixes(property, use_brackets_message(name), |ctx| {
        let question_dot = node.question_dot_token();
        let object = node.expression();
        // `let["x"]` would start a declaration.
        if question_dot.is_nil() && is_identifier(object) && object.text() == "let" {
            return Vec::new();
        }
        let object_range = ctx.trim_node_text_range(object);
        let dot = token_range_at(ctx.source_file, object_range.end());
        let mut fixes = Vec::with_capacity(2);
        if question_dot.is_nil() {
            fixes.push(RuleFix::remove_range(dot));
        }
        fixes.push(ctx.fix_replace(property, format!("[\"{name}\"]")));
        fixes
    });
}

/// The declaration whose modifiers decide an element access: for an
/// accessor pair, the setter of a write and the getter of a read.
fn relevant_declaration(ctx: &RuleContext<'_>, symbol: SymbolId, access: Node) -> Node {
    if symbol.is_nil() {
        return Node::NIL;
    }
    let declarations = &ctx.checker.sym(symbol).declarations;
    let Some(&first) = declarations.first() else {
        return Node::NIL;
    };
    let getter = declarations
        .iter()
        .copied()
        .find(|&d| is_get_accessor_declaration(d));
    let setter = declarations
        .iter()
        .copied()
        .find(|&d| is_set_accessor_declaration(d));
    let preferred = if is_write_access(access) {
        setter.or(getter)
    } else {
        getter.or(setter)
    };
    preferred.unwrap_or(first)
}

fn should_skip_for_type_aware_allowances(
    state: &State,
    ctx: &mut RuleContext<'_>,
    node: Node,
) -> bool {
    let options = &state.options;
    let allow_index_signature = state.index_signature_access_allowed;
    if !options.allow_private_class_property_access
        && !options.allow_protected_class_property_access
        && !allow_index_signature
    {
        return false;
    }

    let property = node.argument_expression();
    let object = node.expression();
    let mut symbol = ctx.checker.get_symbol_at_location_exported(property);
    if symbol.is_nil()
        && let Some(name) = static_property_name(property)
    {
        let object_type = ctx.checker.get_type_at_location(object);
        let object_type = ctx.checker.get_non_nullable_type(object_type);
        if object_type.is_some() {
            let properties = ctx.checker.get_properties_of_type(object_type);
            if let Some(&candidate) = properties
                .iter()
                .find(|&&candidate| ctx.checker.sym(candidate).name.as_str() == name)
            {
                symbol = candidate;
            }
        }
    }

    let declaration = relevant_declaration(ctx, symbol, node);
    if declaration.is_some()
        && ((options.allow_private_class_property_access
            && has_modifier(declaration, ModifierFlags::PRIVATE))
            || (options.allow_protected_class_property_access
                && has_modifier(declaration, ModifierFlags::PROTECTED))
            || (allow_index_signature && declaration.kind() == SyntaxKind::IndexSignature))
    {
        return true;
    }

    let has_declarations = symbol.is_some() && !ctx.checker.sym(symbol).declarations.is_empty();
    if !has_declarations && allow_index_signature {
        if state.no_property_access_from_index_signature {
            return true;
        }
        let object_type = ctx.checker.get_type_at_location(object);
        let object_type = ctx.checker.get_non_nullable_type(object_type);
        if object_type.is_some() {
            let object_type = ctx.checker.get_apparent_type(object_type);
            let key_type = ctx.checker.get_type_at_location(property);
            let base_key_type = ctx.checker.get_base_type_of_literal_type(key_type);
            if ctx
                .checker
                .get_index_type_of_type(object_type, key_type)
                .is_some()
                || (base_key_type.is_some()
                    && ctx
                        .checker
                        .get_index_type_of_type(object_type, base_key_type)
                        .is_some())
            {
                return true;
            }
        }
    }
    false
}
