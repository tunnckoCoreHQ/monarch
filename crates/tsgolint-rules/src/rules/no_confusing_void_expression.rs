//! `no-confusing-void-expression`: requires expressions of type void to
//! appear in statement position.

use goport_core::ast::{
    TextRange, is_arrow_function, is_block, is_function_expression, is_function_like_declaration,
    is_logical_or_coalescing_binary_operator, is_return_statement, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ContextFlags, TypeFlags};
use goport_core::scanner_util::scan_token_at_position;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    decode_options,
};

use crate::utils::{
    get_call_signatures, get_constrained_type_at_location, get_parent_function_node,
    is_intrinsic_void_type, is_type_flag_set, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-confusing-void-expression",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    ignore_arrow_shorthand: bool,
    ignore_void_operator: bool,
    ignore_void_returning_functions: bool,
}

fn invalid_void_expr_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExpr",
        "Placing a void expression inside another expression is forbidden.",
    )
    .with_help("Move it to its own statement instead.")
}

fn invalid_void_expr_arrow_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprArrow",
        "Returning a void expression from an arrow function shorthand is forbidden.",
    )
    .with_help("Add braces to the arrow function.")
}

fn invalid_void_expr_arrow_wrap_void_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprArrowWrapVoid",
        "Void expressions returned from an arrow function shorthand must be marked explicitly with the `void` operator.",
    )
}

fn invalid_void_expr_return_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprReturn",
        "Returning a void expression from a function is forbidden.",
    )
    .with_help("Move it before the `return` statement.")
}

fn invalid_void_expr_return_last_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprReturnLast",
        "Returning a void expression from a function is forbidden.",
    )
    .with_help("Remove the `return` statement.")
}

fn invalid_void_expr_return_wrap_void_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprReturnWrapVoid",
        "Void expressions returned from a function must be marked explicitly with the `void` operator.",
    )
}

fn invalid_void_expr_wrap_void_message() -> RuleMessage {
    RuleMessage::new(
        "invalidVoidExprWrapVoid",
        "Void expressions used inside another expression must be moved to its own statement or marked explicitly with the `void` operator.",
    )
}

fn void_expr_wrap_void_message() -> RuleMessage {
    RuleMessage::new("voidExprWrapVoid", "Mark with an explicit `void` operator.")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::AwaitExpression, check_expression)
        .on(SyntaxKind::CallExpression, check_expression)
        .on(SyntaxKind::TaggedTemplateExpression, check_expression)
        .into()
}

fn is_void_like_at(checker: &mut Checker, node: Node) -> bool {
    let t = get_constrained_type_at_location(checker, node);
    is_type_flag_set(checker, t, TypeFlags::VOID_LIKE)
}

/// The nearest ancestor that makes the void expression confusing, or `None`
/// when it sits in a valid position.
fn find_invalid_ancestor(options: &Options, mut node: Node) -> Option<Node> {
    loop {
        let parent = node.parent();
        let pass_through = match parent.kind() {
            SyntaxKind::ParenthesizedExpression => true,
            SyntaxKind::BinaryExpression => {
                let operator = parent.operator_token().kind();
                // `x && console.log(x)` is valid when its own position is.
                if is_logical_or_coalescing_binary_operator(operator) && parent.right() == node {
                    true
                } else if operator == SyntaxKind::CommaToken && parent.left() == node {
                    return None;
                } else {
                    // tsgolint (like typescript-eslint) does not look through
                    // the right side of a comma.
                    false
                }
            }
            SyntaxKind::ExpressionStatement => return None,
            SyntaxKind::ConditionalExpression => {
                parent.when_true() == node || parent.when_false() == node
            }
            SyntaxKind::ArrowFunction if options.ignore_arrow_shorthand => return None,
            SyntaxKind::VoidExpression if options.ignore_void_operator => return None,
            _ => false,
        };
        if !pass_through {
            return Some(parent);
        }
        node = parent;
    }
}

fn returns_void(checker: &Checker, t: TypeId) -> bool {
    union_type_parts(checker, t)
        .into_iter()
        .any(|part| is_intrinsic_void_type(checker, part))
}

/// Whether the declared or contextual return type of `function` includes
/// `void`.
fn is_void_returning_function(checker: &mut Checker, function: Node) -> bool {
    let return_type_node = function.type_();
    if return_type_node.is_some() {
        let return_type = checker.get_type_from_type_node(return_type_node);
        return returns_void(checker, return_type);
    }
    if !is_arrow_function(function) && !is_function_expression(function) {
        return false;
    }
    let function_type = checker.get_contextual_type(function, ContextFlags::NONE);
    if function_type.is_nil() {
        return false;
    }
    union_type_parts(checker, function_type)
        .into_iter()
        .any(|part| {
            get_call_signatures(checker, part)
                .into_iter()
                .any(|signature| {
                    let return_type = checker.get_return_type_of_signature(signature);
                    returns_void(checker, return_type)
                })
        })
}

/// The last statement of a function body.
fn is_final_return(node: Node) -> bool {
    let block = node.parent();
    is_block(block)
        && is_function_like_declaration(block.parent())
        && block.statements().last() == Some(node)
}

/// `;` when the returned expression starts with a token that would join the
/// previous line once `return` is gone.
fn return_replacement(source_file: Node, expression: Node) -> &'static str {
    match scan_token_at_position(source_file, expression.pos()) {
        SyntaxKind::OpenParenToken | SyntaxKind::OpenBracketToken | SyntaxKind::BacktickToken => {
            ";"
        }
        _ => "",
    }
}

fn check_expression(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(invalid_ancestor) = find_invalid_ancestor(options, node) else {
        return;
    };
    if !is_void_like_at(ctx.checker, node) {
        return;
    }
    let insert_void = |ctx: &mut RuleContext<'_>| vec![ctx.fix_insert_before(node, "void ")];

    if is_arrow_function(invalid_ancestor) {
        if options.ignore_void_returning_functions
            && is_void_returning_function(ctx.checker, invalid_ancestor)
        {
            return;
        }
        if options.ignore_void_operator {
            ctx.report_node_with_fixes(
                node,
                invalid_void_expr_arrow_wrap_void_message(),
                insert_void,
            );
            return;
        }
        ctx.report_node_with_fixes(node, invalid_void_expr_arrow_message(), |ctx| {
            let body = invalid_ancestor.body();
            if is_block(body) || !is_void_like_at(ctx.checker, body) {
                return Vec::new();
            }
            let without_parens = skip_parentheses(body);
            vec![
                RuleFix::replace_range(body.loc().with_end(without_parens.pos()), "{ "),
                RuleFix::replace_range(body.loc().with_pos(without_parens.end()), "; }"),
            ]
        });
        return;
    }

    if is_return_statement(invalid_ancestor) {
        if options.ignore_void_returning_functions {
            let function = get_parent_function_node(invalid_ancestor);
            if function.is_some() && is_void_returning_function(ctx.checker, function) {
                return;
            }
        }
        if options.ignore_void_operator {
            ctx.report_node_with_fixes(
                node,
                invalid_void_expr_return_wrap_void_message(),
                insert_void,
            );
            return;
        }
        let expression = invalid_ancestor.expression();
        let return_token = |ctx: &RuleContext<'_>| -> TextRange {
            token_range_at(ctx.source_file, invalid_ancestor.pos())
        };
        if is_final_return(invalid_ancestor) {
            ctx.report_node_with_fixes(node, invalid_void_expr_return_last_message(), |ctx| {
                if !is_void_like_at(ctx.checker, expression) {
                    return Vec::new();
                }
                let text = return_replacement(ctx.source_file, expression);
                vec![RuleFix::replace_range(return_token(ctx), text)]
            });
            return;
        }
        ctx.report_node_with_fixes(node, invalid_void_expr_return_message(), |ctx| {
            let text = return_replacement(ctx.source_file, expression);
            let mut fixes = vec![
                RuleFix::replace_range(return_token(ctx), text),
                RuleFix::insert_after(invalid_ancestor, "; return;"),
            ];
            // `if (cond) return console.error();` needs braces.
            if !is_block(invalid_ancestor.parent()) {
                fixes.push(ctx.fix_insert_before(invalid_ancestor, "{ "));
                fixes.push(RuleFix::insert_after(invalid_ancestor, " }"));
            }
            fixes
        });
        return;
    }

    if options.ignore_void_operator {
        ctx.report_node_with_suggestions(node, invalid_void_expr_wrap_void_message(), |ctx| {
            vec![RuleSuggestion {
                message: void_expr_wrap_void_message(),
                fixes: insert_void(ctx),
            }]
        });
        return;
    }

    ctx.report_node(node, invalid_void_expr_message());
}
