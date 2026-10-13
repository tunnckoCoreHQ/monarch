//! `non-nullable-type-assertion-style`: prefers `x!` over an `as` cast that
//! only removes `null` and `undefined`.

use goport_core::ast::{get_expression_precedence, is_const_assertion};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{OperatorPrecedence, TypeFlags};
use rustc_hash::FxHashSet;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
};

use crate::utils::{is_type_flag_set, is_type_parameter, union_type_parts};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "non-nullable-type-assertion-style",
    create,
};

fn prefer_non_null_assertion_message() -> RuleMessage {
    RuleMessage::new(
        "preferNonNullAssertion",
        "Use a ! assertion to more succinctly remove null and undefined from the type.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::AsExpression, check_assertion)
        .on(SyntaxKind::TypeAssertionExpression, check_assertion)
        .into()
}

/// The union parts of the type at `node`, or `None` for `any` and `unknown`.
fn types_if_not_loose(checker: &mut Checker, node: Node) -> Option<Vec<TypeId>> {
    let t = checker.get_type_at_location(node);
    if is_type_flag_set(checker, t, TypeFlags::ANY_OR_UNKNOWN) {
        return None;
    }
    Some(union_type_parts(checker, t).to_vec())
}

fn could_be_nullable(checker: &mut Checker, mut t: TypeId) -> bool {
    if is_type_parameter(checker, t) {
        t = checker.get_base_constraint_of_type(t);
        if t.is_nil() {
            return true;
        }
    }
    union_type_parts(checker, t)
        .iter()
        .any(|&part| is_type_flag_set(checker, part, TypeFlags::NULLABLE))
}

fn check_assertion(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if is_const_assertion(node) {
        return;
    }
    let expression = node.expression();
    let checker = &mut *ctx.checker;
    let Some(original_types) = types_if_not_loose(checker, expression) else {
        return;
    };
    let Some(asserted_types) = types_if_not_loose(checker, node.type_()) else {
        return;
    };

    let non_nullable_original: FxHashSet<TypeId> = original_types
        .iter()
        .copied()
        .filter(|&t| !is_type_flag_set(checker, t, TypeFlags::NULLABLE))
        .collect();
    if non_nullable_original.len() == original_types.len() {
        return;
    }

    let mut asserted = FxHashSet::default();
    for &t in &asserted_types {
        if could_be_nullable(checker, t) || !non_nullable_original.contains(&t) {
            return;
        }
        asserted.insert(t);
    }
    if !non_nullable_original.iter().all(|t| asserted.contains(t)) {
        return;
    }

    let higher_precedence_than_unary =
        get_expression_precedence(expression) > OperatorPrecedence::UNARY;
    // Both `as` and `<T>x` are assertion expressions, so tsgolint always
    // removes from the end of the expression to the end of the node.
    let remove_range = node.loc().with_pos(expression.end());
    ctx.report_node_with_suggestions(node, prefer_non_null_assertion_message(), |ctx| {
        let mut fixes = vec![RuleFix::remove_range(remove_range)];
        if higher_precedence_than_unary {
            fixes.push(RuleFix::insert_after(expression, "!"));
        } else {
            fixes.push(ctx.fix_insert_before(expression, "("));
            fixes.push(RuleFix::insert_after(expression, ")!"));
        }
        vec![RuleSuggestion {
            message: prefer_non_null_assertion_message(),
            fixes,
        }]
    });
}
