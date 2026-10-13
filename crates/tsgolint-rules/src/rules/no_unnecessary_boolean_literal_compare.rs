//! `no-unnecessary-boolean-literal-compare`: flags comparisons of boolean
//! values to `true` or `false`.

use goport_core::ast::{skip_parentheses, walk_up_parenthesized_expressions};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_constraint_info, is_strong_precedence_node, is_type_flag_set, is_union_type,
    require_strict_null_checks,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-boolean-literal-compare",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_comparing_nullable_booleans_to_false: bool,
    allow_comparing_nullable_booleans_to_true: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_comparing_nullable_booleans_to_false: true,
            allow_comparing_nullable_booleans_to_true: true,
        }
    }
}

fn comparing_nullable_to_false_message() -> RuleMessage {
    RuleMessage::new(
        "comparingNullableToFalse",
        "This expression unnecessarily compares a nullable boolean value to false instead of using the ?? operator to provide a default.",
    )
}

fn comparing_nullable_to_true_direct_message() -> RuleMessage {
    RuleMessage::new(
        "comparingNullableToTrueDirect",
        "This expression unnecessarily compares a nullable boolean value to true instead of using it directly.",
    )
}

fn comparing_nullable_to_true_negated_message() -> RuleMessage {
    RuleMessage::new(
        "comparingNullableToTrueNegated",
        "This expression unnecessarily compares a nullable boolean value to true instead of negating it.",
    )
}

fn direct_message() -> RuleMessage {
    RuleMessage::new(
        "direct",
        "This expression unnecessarily compares a boolean value to a boolean instead of using it directly.",
    )
}

fn negated_message() -> RuleMessage {
    RuleMessage::new(
        "negated",
        "This expression unnecessarily compares a boolean value to a boolean instead of negating it.",
    )
}
struct BooleanComparison {
    /// The side compared to the literal.
    expression: Node,
    /// The literal is `true`.
    literal_true: bool,
    /// `!=` or `!==`.
    negated: bool,
    expression_is_nullable_boolean: bool,
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    require_strict_null_checks(ctx);
    Listeners::new(options)
        .on(SyntaxKind::BinaryExpression, check_binary)
        .into()
}

/// A union of only nullish and boolean types, with at least one of each.
fn is_nullable_boolean(ctx: &RuleContext<'_>, t: TypeId) -> bool {
    if !is_union_type(ctx.checker, t) {
        return false;
    }
    let flags = ctx
        .checker
        .ty(t)
        .types()
        .iter()
        .fold(TypeFlags::NONE, |flags, &part| {
            flags | ctx.checker.ty(part).flags
        });
    flags.intersects(TypeFlags::NULLABLE) && flags.intersects(TypeFlags::BOOLEAN_LIKE)
}

fn get_boolean_comparison(ctx: &mut RuleContext<'_>, node: Node) -> Option<BooleanComparison> {
    let negated = match node.operator_token().kind() {
        SyntaxKind::ExclamationEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken => true,
        SyntaxKind::EqualsEqualsToken | SyntaxKind::EqualsEqualsEqualsToken => false,
        _ => return None,
    };
    let literal = |against: Node| match skip_parentheses(against).kind() {
        SyntaxKind::TrueKeyword => Some(true),
        SyntaxKind::FalseKeyword => Some(false),
        _ => None,
    };
    let (literal_true, expression) = match literal(node.right()) {
        Some(value) => (value, node.left()),
        None => (literal(node.left())?, node.right()),
    };

    let expression_type = ctx.checker.get_type_at_location(expression);
    let constraint = get_constraint_info(ctx.checker, expression_type).constraint()?;
    let expression_is_nullable_boolean =
        if is_type_flag_set(ctx.checker, constraint, TypeFlags::BOOLEAN_LIKE) {
            false
        } else if is_nullable_boolean(ctx, constraint) {
            true
        } else {
            return None;
        };
    Some(BooleanComparison {
        expression,
        literal_true,
        negated,
        expression_is_nullable_boolean,
    })
}

/// Whether `node` is the condition of an `if`, loop or `?:` (through
/// parentheses and `&&`/`||`), or the operand of `!`.
fn is_conditional_test(mut node: Node) -> bool {
    let mut parent = node.parent();
    while parent.is_some() {
        match parent.kind() {
            SyntaxKind::ParenthesizedExpression => {}
            SyntaxKind::BinaryExpression => {
                if !matches!(
                    parent.operator_token().kind(),
                    SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
                ) {
                    return false;
                }
            }
            SyntaxKind::IfStatement | SyntaxKind::WhileStatement | SyntaxKind::DoStatement => {
                return parent.expression() == node;
            }
            SyntaxKind::ForStatement | SyntaxKind::ConditionalExpression => {
                return parent.condition() == node;
            }
            SyntaxKind::PrefixUnaryExpression => {
                return parent.operator() == SyntaxKind::ExclamationToken;
            }
            _ => return false,
        }
        node = parent;
        parent = node.parent();
    }
    false
}

fn check_binary(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(comparison) = get_boolean_comparison(ctx, node) else {
        return;
    };
    if comparison.expression_is_nullable_boolean
        && if comparison.literal_true {
            options.allow_comparing_nullable_booleans_to_true
        } else {
            options.allow_comparing_nullable_booleans_to_false
        }
    {
        return;
    }

    let message = match (
        comparison.expression_is_nullable_boolean,
        comparison.literal_true,
        comparison.negated,
    ) {
        (true, true, true) => comparing_nullable_to_true_negated_message(),
        (true, true, false) => comparing_nullable_to_true_direct_message(),
        (true, false, _) => comparing_nullable_to_false_message(),
        (false, _, true) => negated_message(),
        (false, _, false) => direct_message(),
    };

    ctx.report_node_with_fixes(node, message, |ctx| fixes(ctx, node, &comparison));
}

fn fixes(ctx: &RuleContext<'_>, node: Node, comparison: &BooleanComparison) -> Vec<RuleFix> {
    let parent = walk_up_parenthesized_expressions(node.parent());
    let is_unary_negation = parent.kind() == SyntaxKind::PrefixUnaryExpression
        && parent.operator() == SyntaxKind::ExclamationToken;
    let should_negate = comparison.negated != comparison.literal_true;
    let mutated_node = if is_unary_negation { parent } else { node };

    let expression = comparison.expression;
    // tsgolint slices from `pos()`, so the text keeps the leading trivia.
    let expression_text = ctx.range_text(expression.loc());
    let strong_precedence = is_strong_precedence_node(expression);

    if comparison.expression_is_nullable_boolean
        && comparison.literal_true
        && should_negate != is_unary_negation
        && !is_conditional_test(mutated_node)
    {
        let text = expression_text.trim();
        let text = if strong_precedence {
            text.to_owned()
        } else {
            format!("({text})")
        };
        // Coercion keeps both the boolean result and TypeScript's narrowing.
        return vec![ctx.fix_replace(mutated_node, format!("(!!{text})"))];
    }

    let mut fixes = vec![ctx.fix_replace(mutated_node, expression_text)];
    if should_negate == is_unary_negation {
        fixes.push(ctx.fix_insert_before(mutated_node, "!"));
        if !strong_precedence {
            fixes.extend(ctx.fix_wrap_in_parens(mutated_node));
        }
    }
    if comparison.expression_is_nullable_boolean && !comparison.literal_true {
        fixes.push(ctx.fix_insert_before(mutated_node, "("));
        fixes.push(RuleFix::insert_after(mutated_node, " ?? true)"));
    }
    fixes
}
