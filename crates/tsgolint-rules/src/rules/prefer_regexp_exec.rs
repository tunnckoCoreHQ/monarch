//! `prefer-regexp-exec`: prefers `RegExp#exec()` over `String#match()`
//! when the regular expression has no `g` flag.

use goport_core::ast::{
    is_call_expression, is_element_access_expression, is_identifier, is_new_expression,
    is_property_access_expression, is_variable_declaration, is_variable_declaration_list,
    skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::NodeFlags;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{
    get_type_name, is_parenthesized, is_strong_precedence_node, is_undefined_literal,
    is_valid_regexp_pattern, is_weak_precedence_parent, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-regexp-exec",
    create,
};

fn regexp_exec_over_string_match_message() -> RuleMessage {
    RuleMessage::new(
        "regExpExecOverStringMatch",
        "Use the `RegExp#exec()` method instead.",
    )
}

/// What the argument of `match()` is known to be without running code.
enum StaticArgument {
    Unknown,
    /// A string, number, boolean or `null`.
    NotRegExp,
    RegExp {
        global: bool,
    },
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_call)
        .into()
}

fn check_call(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let arguments = node.arguments();
    if arguments.len() != 1 {
        return;
    }
    let callee = node.expression();
    if !is_property_access_expression(callee) && !is_element_access_expression(callee) {
        return;
    }
    let (property_name, found) = ctx.checker.get_accessed_property_name(callee);
    if !found || property_name.as_str() != "match" {
        return;
    }

    let object = callee.expression();
    let object_type = ctx.checker.get_type_at_location(object);
    if get_type_name(ctx.checker, object_type) != "string" {
        return;
    }

    let argument = arguments.get(0);
    let static_argument = static_argument_value(ctx, argument, &mut Vec::new());
    if matches!(static_argument, StaticArgument::RegExp { global: true }) {
        return;
    }

    let report_node = if is_property_access_expression(callee) {
        callee.name()
    } else {
        callee.argument_expression()
    };

    if argument.kind() == SyntaxKind::StringLiteral {
        let pattern = argument.text();
        if !is_valid_regexp_pattern(pattern) {
            return;
        }
        let literal = format!("/{}/", pattern.replace('/', "\\/"));
        report_with_fix(ctx, report_node, node, object, argument, |object, _| {
            format!("{literal}.exec({object})")
        });
        return;
    }

    let argument_type = ctx.checker.get_type_at_location(argument);
    let argument_types = collect_argument_types(ctx, argument_type);
    if matches!(static_argument, StaticArgument::Unknown)
        && argument_types.reg_exp
        && !definitely_does_not_contain_global_flag(argument)
    {
        return;
    }

    match argument_types {
        ArgumentTypes {
            reg_exp: true,
            string: false,
        } => report_with_fix(
            ctx,
            report_node,
            node,
            object,
            argument,
            |object, argument| format!("{argument}.exec({object})"),
        ),
        ArgumentTypes {
            reg_exp: false,
            string: true,
        } => report_with_fix(
            ctx,
            report_node,
            node,
            object,
            argument,
            |object, argument| format!("RegExp({argument}).exec({object})"),
        ),
        _ => {}
    }
}

/// Whether some union member of the argument's type is named `RegExp` or
/// `string`.
#[derive(Clone, Copy)]
struct ArgumentTypes {
    reg_exp: bool,
    string: bool,
}

fn collect_argument_types(ctx: &mut RuleContext<'_>, t: TypeId) -> ArgumentTypes {
    let mut result = ArgumentTypes {
        reg_exp: false,
        string: false,
    };
    for part in union_type_parts(ctx.checker, t) {
        match get_type_name(ctx.checker, part).as_str() {
            "RegExp" => result.reg_exp = true,
            "string" => result.string = true,
            _ => {}
        }
    }
    result
}

fn report_with_fix(
    ctx: &mut RuleContext<'_>,
    report_node: Node,
    call: Node,
    object: Node,
    argument: Node,
    build: impl Fn(&str, &str) -> String,
) {
    ctx.report_node_with_fixes(
        report_node,
        regexp_exec_over_string_match_message(),
        |ctx| {
            let object_code = operand_code(ctx, object);
            let argument_code = operand_code(ctx, argument);
            let mut code = build(&object_code, &argument_code);
            if is_weak_precedence_parent(call) && !is_parenthesized(call) {
                code = format!("({code})");
            }
            vec![ctx.fix_replace(call, code)]
        },
    );
}

/// The text of `node`, parenthesized unless it binds tightly.
fn operand_code(ctx: &RuleContext<'_>, node: Node) -> String {
    let text = ctx.node_text(node);
    if is_strong_precedence_node(node) {
        text
    } else {
        format!("({text})")
    }
}

/// The flags of a regular expression literal (the text after its closing
/// unescaped `/`).
fn regex_literal_flags(node: Node) -> Option<&'static str> {
    let text = node.text();
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'/' {
        return None;
    }
    let is_escaped = |index: usize| {
        bytes[..index]
            .iter()
            .rev()
            .take_while(|&&b| b == b'\\')
            .count()
            % 2
            == 1
    };
    let closing_slash = (1..bytes.len())
        .rev()
        .find(|&i| bytes[i] == b'/' && !is_escaped(i))?;
    Some(&text[closing_slash + 1..])
}

/// A `RegExp(...)` or `new RegExp(...)` call.
fn is_reg_exp_constructor_call(node: Node) -> bool {
    if !is_call_expression(node) && !is_new_expression(node) {
        return false;
    }
    let callee = node.expression();
    is_identifier(callee) && callee.text() == "RegExp"
}

fn definitely_does_not_contain_global_flag(node: Node) -> bool {
    let node = skip_parentheses(node);
    if !is_reg_exp_constructor_call(node) {
        return false;
    }
    let arguments = node.arguments();
    if arguments.len() < 2 {
        return true;
    }
    let flags = skip_parentheses(arguments.get(1));
    if is_undefined_literal(flags) {
        return true;
    }
    flags.kind() == SyntaxKind::StringLiteral && !flags.text().contains('g')
}

fn static_argument_value(
    ctx: &mut RuleContext<'_>,
    node: Node,
    visited: &mut Vec<SymbolId>,
) -> StaticArgument {
    let node = skip_parentheses(node);
    match node.kind() {
        SyntaxKind::StringLiteral => return StaticArgument::NotRegExp,
        SyntaxKind::RegularExpressionLiteral => {
            return match regex_literal_flags(node) {
                Some(flags) => StaticArgument::RegExp {
                    global: flags.contains('g'),
                },
                None => StaticArgument::Unknown,
            };
        }
        SyntaxKind::NoSubstitutionTemplateLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::TrueKeyword
        | SyntaxKind::FalseKeyword
        | SyntaxKind::NullKeyword => return StaticArgument::NotRegExp,
        SyntaxKind::Identifier => {
            let symbol = ctx.checker.get_symbol_at_location_exported(node);
            if symbol.is_nil() || visited.contains(&symbol) {
                return StaticArgument::Unknown;
            }
            let declaration = ctx.checker.sym(symbol).value_declaration;
            if declaration.is_nil() || !is_variable_declaration(declaration) {
                return StaticArgument::Unknown;
            }
            let initializer = declaration.initializer();
            if initializer.is_nil() {
                return StaticArgument::Unknown;
            }
            // Like `getStaticValue`, only `const` bindings have a known value.
            let list = declaration.parent();
            if !is_variable_declaration_list(list) || !list.flags().intersects(NodeFlags::CONST) {
                return StaticArgument::Unknown;
            }
            visited.push(symbol);
            let value = static_argument_value(ctx, initializer, visited);
            visited.pop();
            return value;
        }
        SyntaxKind::AsExpression
        | SyntaxKind::TypeAssertionExpression
        | SyntaxKind::NonNullExpression => {
            return static_argument_value(ctx, node.expression(), visited);
        }
        _ => {}
    }

    if !is_reg_exp_constructor_call(node) {
        return StaticArgument::Unknown;
    }
    let arguments = node.arguments();
    let pattern = arguments.first();
    if pattern.is_some_and(|pattern| pattern.kind() != SyntaxKind::StringLiteral) {
        return StaticArgument::Unknown;
    }
    let mut flags = "";
    if arguments.len() > 1 {
        let flags_node = arguments.get(1);
        if flags_node.kind() != SyntaxKind::StringLiteral {
            return StaticArgument::Unknown;
        }
        flags = flags_node.text();
    }
    if pattern.is_some_and(|pattern| !is_valid_regexp_pattern(pattern.text())) {
        return StaticArgument::Unknown;
    }
    StaticArgument::RegExp {
        global: flags.contains('g'),
    }
}
