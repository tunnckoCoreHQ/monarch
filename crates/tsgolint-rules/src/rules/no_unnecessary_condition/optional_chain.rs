//! `neverOptionalChain`: a `?.` on a value that is never nullish.

use goport_core::ast::skip_parentheses;
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{MappedTypeModifiers, ObjectFlags, TypeFlags};
use tsgolint_core::{RuleContext, RuleSuggestion};

use super::resolve::{
    get_call_return_type, get_property_type_from_base, get_resolved_type,
    get_type_from_call_property, has_own_question_dot, is_call,
    is_call_expression_nullable_origin_from_callee, is_element_access, is_optionable_expression,
    is_property_access,
};
use super::types::{
    is_indeterminate_type, is_nullish_type, remove_nullish_from_type, string_literal_value,
    truncate_type_name,
};
use super::{
    State, never_optional_chain_message, suggest_remove_optional_chain_message, type_name_for_node,
    typed_value_report,
};
use crate::utils::{is_type_flag_set, is_union_type, union_type_parts};

/// `tuple[0]`: an element access with a numeric literal on a tuple.
fn is_safe_tuple_access(c: &mut Checker, access: Node) -> bool {
    let argument = access.argument_expression();
    if argument.is_nil() || skip_parentheses(argument).kind() != SyntaxKind::NumericLiteral {
        return false;
    }
    let base_type = get_resolved_type(c, access.expression());
    base_type.is_some() && c.is_tuple_type(base_type)
}

/// An element access without `?.` in the chain of `node` that is not a safe
/// tuple access.
fn has_unsafe_element_access(st: &State, c: &mut Checker, node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    if is_element_access(node) {
        if node.question_dot_token().is_nil()
            && !st.no_unchecked_indexed_access
            && !is_safe_tuple_access(c, node)
        {
            return true;
        }
        return has_unsafe_element_access(st, c, node.expression());
    }
    if is_property_access(node) || is_call(node) {
        return has_unsafe_element_access(st, c, node.expression());
    }
    false
}

/// The type of `expression` (the object of the checked `?.`), without the
/// `undefined` that an earlier `?.` adds. The label is the type name to
/// report when it is not the name of the type.
fn optional_chain_object_type(
    st: &State,
    c: &mut Checker,
    expression: Node,
) -> Option<(TypeId, Option<String>)> {
    let unlabeled = |t: TypeId| t.is_some().then_some((t, None));

    // For `foo?.bar?.baz`, `expression` is `foo?.bar` and `base` is `foo`.
    let chained_base = match expression.kind() {
        SyntaxKind::PropertyAccessExpression
        | SyntaxKind::ElementAccessExpression
        | SyntaxKind::CallExpression
            if expression.question_dot_token().is_some() =>
        {
            Some(expression.expression())
        }
        _ => None,
    };

    let Some(base) = chained_base else {
        if is_property_access(expression) || is_element_access(expression) {
            let inner = expression.expression();
            if is_call(inner) {
                return unlabeled(get_type_from_call_property(st, c, inner, expression));
            }
            return unlabeled(get_resolved_type(c, expression));
        }
        if is_call(expression) {
            return call_type(c, expression).and_then(unlabeled);
        }
        return unlabeled(get_resolved_type(c, expression));
    };

    let base_type = get_resolved_type(c, base);
    if base_type.is_nil() {
        return None;
    }
    let base_type = remove_nullish_from_type(c, base_type);
    if base_type.is_nil() {
        return None;
    }

    if is_property_access(expression) {
        let mut t = get_property_type_from_base(st, c, base_type, expression);
        if t.is_nil() {
            t = c.get_type_at_location(expression);
            // The type at the location has the short-circuit `undefined`. A
            // mapped type without `?` does not add it to its properties.
            if t.is_some()
                && !st.no_unchecked_indexed_access
                && c.ty(base_type).object_flags.intersects(ObjectFlags::MAPPED)
                && !c
                    .get_mapped_type_modifiers(base_type)
                    .intersects(MappedTypeModifiers::INCLUDE_OPTIONAL)
            {
                t = remove_nullish_from_type(c, t);
            }
        }
        return unlabeled(t);
    }
    if is_element_access(expression) {
        let argument = expression.argument_expression();
        if argument.is_some() {
            let key_type = c.get_type_at_location(argument);
            if key_type.is_some()
                && let Some((t, label)) = literal_keys_property_type(c, base_type, key_type)
            {
                return Some((t, Some(label)));
            }
        }
        return unlabeled(c.get_type_at_location(expression));
    }
    // A `?.` call.
    call_type(c, expression).and_then(unlabeled)
}

/// The return type of a call, or its resolved type.
fn call_type(c: &mut Checker, call: Node) -> Option<TypeId> {
    let t = get_call_return_type(c, call);
    if t.is_some() {
        return Some(t);
    }
    let t = get_resolved_type(c, call);
    t.is_some().then_some(t)
}

/// For `base?.[key]` where `key` is a string literal or a union of them:
/// when every key names a non-nullish property, the first property type and
/// the label `A | B` of the distinct property types.
fn literal_keys_property_type(
    c: &mut Checker,
    base_type: TypeId,
    key_type: TypeId,
) -> Option<(TypeId, String)> {
    let mut keys = Vec::new();
    if is_type_flag_set(c, key_type, TypeFlags::STRING_LITERAL) {
        keys.extend(string_literal_value(c, key_type));
    } else if is_union_type(c, key_type) {
        for part in c.ty(key_type).types_list().iter().copied() {
            if !is_type_flag_set(c, part, TypeFlags::STRING_LITERAL) {
                return None;
            }
            keys.extend(string_literal_value(c, part));
        }
    } else {
        return None;
    }
    if keys.is_empty() {
        return None;
    }

    let mut representative = TypeId::NIL;
    let mut type_names: Vec<String> = Vec::new();
    for key in &keys {
        let property = c.get_property_of_type(base_type, key.as_str());
        if property.is_nil() {
            return None;
        }
        let property_type = c.get_type_of_symbol(property);
        if property_type.is_nil() || is_nullish_type(c, property_type) {
            return None;
        }
        if representative.is_nil() {
            representative = property_type;
        }
        let name = c.type_to_string(property_type);
        if !type_names.contains(&name) {
            type_names.push(name);
        }
    }
    Some((representative, truncate_type_name(type_names.join(" | "))))
}

/// Some non-nullish member of the callee's union has a first signature that
/// returns a nullish type.
fn callee_part_returns_nullish(c: &mut Checker, call: Node) -> bool {
    let callee_type = get_resolved_type(c, call.expression());
    if callee_type.is_nil() {
        return false;
    }
    for part in union_type_parts(c, callee_type).iter().copied() {
        if is_type_flag_set(
            c,
            part,
            TypeFlags::NULL | TypeFlags::UNDEFINED | TypeFlags::VOID,
        ) {
            continue;
        }
        if let Some(&signature) = c.get_call_signatures(part).first() {
            let return_type = c.get_return_type_of_signature(signature);
            if return_type.is_some() && is_nullish_type(c, return_type) {
                return true;
            }
        }
    }
    false
}

pub(super) fn check_optional_chain(st: &State, ctx: &mut RuleContext<'_>, node: Node) {
    if !matches!(
        node.kind(),
        SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::CallExpression
    ) {
        return;
    }
    let expression = node.expression();
    let question_dot = node.question_dot_token();
    if question_dot.is_nil() {
        return;
    }
    let c = &mut *ctx.checker;

    // `arr[0]?.foo`: the element may be missing although its type says
    // otherwise.
    let skipped = skip_parentheses(expression);
    if is_element_access(skipped)
        && !st.no_unchecked_indexed_access
        && skipped.question_dot_token().is_nil()
        && !is_safe_tuple_access(c, skipped)
    {
        return;
    }
    // `arr[0]?.foo?.bar`: the same, further up the chain.
    if has_own_question_dot(skipped) && has_unsafe_element_access(st, c, expression) {
        return;
    }
    if is_optionable_expression(st, c, expression) {
        return;
    }

    let Some((mut expression_type, label)) = optional_chain_object_type(st, c, expression) else {
        return;
    };
    if is_call(expression) {
        if is_call_expression_nullable_origin_from_callee(c, expression) {
            expression_type = remove_nullish_from_type(c, expression_type);
            if expression_type.is_nil() {
                return;
            }
        }
        // `foo?.()?.bar` where one of the functions returns `undefined`.
        if callee_part_returns_nullish(c, expression) {
            return;
        }
    }

    if is_indeterminate_type(c, expression_type)
        || (is_union_type(c, expression_type)
            && c.ty(expression_type)
                .types()
                .iter()
                .any(|&part| is_indeterminate_type(c, part)))
    {
        return;
    }
    if is_nullish_type(c, expression_type) {
        return;
    }

    let type_name = label.unwrap_or_else(|| type_name_for_node(c, expression_type, expression));
    let report = typed_value_report(
        never_optional_chain_message(),
        ctx.trim_node_text_range(question_dot),
        ctx.trim_node_text_range(expression),
        type_name,
    );
    let replacement = if node.kind() == SyntaxKind::PropertyAccessExpression {
        "."
    } else {
        ""
    };
    ctx.report_diagnostic_with_suggestions(report, |ctx| {
        vec![RuleSuggestion {
            message: suggest_remove_optional_chain_message(),
            fixes: vec![ctx.fix_replace(question_dot, replacement)],
        }]
    });
}
