//! `use-unknown-in-catch-callback-variable`: requires `unknown` for the
//! error variable of a `catch` or `then` rejection callback.

use goport_core::ast::{
    is_access_expression, is_logical_expression, is_spread_element, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
};

use crate::utils::{
    get_call_signatures, is_parenless_arrow_function, is_thenable_type, is_type_flag_set,
    union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "use-unknown-in-catch-callback-variable",
    create,
};

fn use_unknown_message_base(method: &str) -> String {
    format!("Prefer the safe `: unknown` for a {method} callback variable.")
}

fn use_unknown_message(method: &str) -> RuleMessage {
    RuleMessage::new("useUnknown", use_unknown_message_base(method))
}

fn use_unknown_array_destructuring_pattern_message(method: &str) -> RuleMessage {
    RuleMessage::new(
        "useUnknownArrayDestructuringPattern",
        use_unknown_message_base(method) + " The thrown error may not be iterable.",
    )
}

fn use_unknown_object_destructuring_pattern_message(method: &str) -> RuleMessage {
    RuleMessage::new(
        "useUnknownObjectDestructuringPattern",
        use_unknown_message_base(method)
            + " The thrown error may be nullable, or may not have the expected shape.",
    )
}

fn add_unknown_rest_type_annotation_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "addUnknownRestTypeAnnotationSuggestion",
        "Add an explicit `: [unknown]` type annotation to the rejection callback rest variable.",
    )
}

fn add_unknown_type_annotation_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "addUnknownTypeAnnotationSuggestion",
        "Add an explicit `: unknown` type annotation to the rejection callback variable.",
    )
}

fn wrong_rest_type_annotation_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "wrongRestTypeAnnotationSuggestion",
        "Change existing type annotation to `: [unknown]`.",
    )
}

fn wrong_type_annotation_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "wrongTypeAnnotationSuggestion",
        "Change existing type annotation to `: unknown`.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, check_call)
        .into()
}

fn check_call(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    if !is_access_expression(callee) {
        return;
    }
    let (property_name, found) = ctx.checker.get_accessed_property_name(callee);
    if !found {
        return;
    }
    let (method, arg_index) = match property_name.as_str() {
        "catch" => ("`catch`", 0),
        "then" => ("`then` rejection", 1),
        _ => return,
    };
    let arguments = node.arguments();
    if arguments.len() < arg_index + 1 {
        return;
    }
    // The checked argument and the ones before it must not be spreads.
    if arguments.iter().take(arg_index + 1).any(is_spread_element) {
        return;
    }
    let object_type = ctx.checker.get_type_at_location(callee.expression());
    if !is_thenable_type(ctx.checker, callee, object_type) {
        return;
    }

    let mut flagged = Vec::new();
    collect_flagged_nodes(ctx.checker, arguments.get(arg_index), &mut flagged);
    for function in flagged {
        report_catch_param(ctx, function, method);
    }
}

fn report_catch_param(ctx: &mut RuleContext<'_>, function: Node, method: &str) {
    let param = function.parameters().get(0);
    let variable = param.name();
    let annotation = param.type_();

    if param.dot_dot_dot_token().is_some() {
        if annotation.is_nil() {
            ctx.report_node_with_suggestions(param, use_unknown_message(method), |_| {
                vec![RuleSuggestion {
                    message: add_unknown_rest_type_annotation_suggestion_message(),
                    fixes: vec![RuleFix::insert_after(variable, ": [unknown]")],
                }]
            });
        } else {
            ctx.report_node_with_suggestions(param, use_unknown_message(method), |ctx| {
                vec![RuleSuggestion {
                    message: wrong_rest_type_annotation_suggestion_message(),
                    fixes: vec![ctx.fix_replace(annotation, "[unknown]")],
                }]
            });
        }
        return;
    }

    match variable.kind() {
        SyntaxKind::Identifier if annotation.is_nil() => {
            ctx.report_node_with_suggestions(param, use_unknown_message(method), |ctx| {
                let fixes = if is_parenless_arrow_function(function) {
                    vec![
                        ctx.fix_insert_before(variable, "("),
                        RuleFix::insert_after(variable, ": unknown)"),
                    ]
                } else {
                    let question = param.question_token();
                    let after = if question.is_some() {
                        question
                    } else {
                        variable
                    };
                    vec![RuleFix::insert_after(after, ": unknown")]
                };
                vec![RuleSuggestion {
                    message: add_unknown_type_annotation_suggestion_message(),
                    fixes,
                }]
            });
        }
        SyntaxKind::Identifier => {
            ctx.report_node_with_suggestions(param, use_unknown_message(method), |ctx| {
                vec![RuleSuggestion {
                    message: wrong_type_annotation_suggestion_message(),
                    fixes: vec![ctx.fix_replace(annotation, "unknown")],
                }]
            });
        }
        SyntaxKind::ArrayBindingPattern => {
            ctx.report_node(
                param,
                use_unknown_array_destructuring_pattern_message(method),
            );
        }
        SyntaxKind::ObjectBindingPattern => {
            ctx.report_node(
                param,
                use_unknown_object_destructuring_pattern_message(method),
            );
        }
        _ => {}
    }
}

/// The function expressions that `node` may evaluate to and whose type takes
/// a first parameter that is not `unknown`.
fn collect_flagged_nodes(checker: &mut Checker, node: Node, out: &mut Vec<Node>) {
    let node = skip_parentheses(node);
    match node.kind() {
        SyntaxKind::BinaryExpression => {
            if is_logical_expression(node) {
                collect_flagged_nodes(checker, node.left(), out);
                collect_flagged_nodes(checker, node.right(), out);
            } else if node.operator_token().kind() == SyntaxKind::CommaToken {
                collect_flagged_nodes(checker, node.right(), out);
            }
        }
        SyntaxKind::ConditionalExpression => {
            collect_flagged_nodes(checker, node.when_true(), out);
            collect_flagged_nodes(checker, node.when_false(), out);
        }
        SyntaxKind::ArrowFunction | SyntaxKind::FunctionExpression => {
            let t = checker.get_type_at_location(node);
            if is_flaggable_handler_type(checker, t) {
                out.push(node);
            }
        }
        _ => {}
    }
}

/// Whether a call signature of `t` takes a first parameter (or rest element)
/// that is not `unknown`.
fn is_flaggable_handler_type(checker: &mut Checker, t: TypeId) -> bool {
    for part in union_type_parts(checker, t) {
        for signature in get_call_signatures(checker, part) {
            let Some(&first) = checker.sig(signature).parameters().first() else {
                continue;
            };
            let mut first_type = checker.get_type_of_symbol(first);
            let declaration = checker.sym(first).value_declaration;
            if declaration.is_some() && declaration.dot_dot_dot_token().is_some() {
                // A rest parameter that is not an array or tuple is flagged.
                if !checker.is_array_or_tuple_type(first_type) {
                    return true;
                }
                first_type = checker.get_type_arguments(first_type)[0];
            }
            if !is_type_flag_set(checker, first_type, TypeFlags::UNKNOWN) {
                return true;
            }
        }
    }
    false
}
