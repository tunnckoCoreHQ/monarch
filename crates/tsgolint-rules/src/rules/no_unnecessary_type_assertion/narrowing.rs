//! Whether an assertion feeds an assignment that narrows its receiver for
//! later statements.
//!
//! tsgolint adds these checks to typescript-eslint's contextual fallback
//! (typescript-eslint issue #1122): a receiver that accepts the original
//! type does not mean that removing the assertion keeps the receiver's
//! narrowed type. It uses the checker's assignment reduction.

use goport_core::ast::{
    get_target_of_binding_or_assignment_element, is_array_literal_expression,
    is_assignment_expression, is_assignment_pattern, is_binary_expression,
    is_conditional_expression, is_logical_or_coalescing_binary_expression,
    is_object_literal_expression, is_parenthesized_expression, is_property_assignment,
    is_shorthand_property_assignment, is_spread_assignment, is_spread_element, skip_parentheses,
    try_get_text_of_property_name,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{
    CheckFlags, ContextFlags, ModifierFlags, SymbolFlags, TypeFacts, UnionReduction,
};

use crate::utils::{get_number_index_type, is_union_type};

/// Go `strconv.Atoi` succeeded.
fn parse_index(text: &str) -> Option<i64> {
    text.parse::<i64>().ok()
}

/// The default value that a destructuring target gives the element at
/// `property_path` (innermost last), when exactly one target reads it.
fn destructuring_default(mut target: Node, property_path: &[String]) -> Node {
    for i in (0..property_path.len()).rev() {
        target = skip_parentheses(target);
        let mut element = Node::NIL;
        if is_array_literal_expression(target) {
            let elements = target.elements();
            match parse_index(&property_path[i]) {
                Some(index) if index >= 0 && (index as usize) < elements.len() => {
                    element = elements.get(index as usize);
                }
                _ => return Node::NIL,
            }
        } else if is_object_literal_expression(target) {
            for property in target.properties() {
                if is_spread_assignment(property) || property.name().is_nil() {
                    continue;
                }
                let (name, known) = try_get_text_of_property_name(property.name());
                if !known {
                    return Node::NIL;
                }
                if name == property_path[i] {
                    // Every target that reads the property must keep the
                    // narrowing; a default on only one of them is not enough.
                    if element.is_some() {
                        return Node::NIL;
                    }
                    element = property;
                }
            }
        }
        if element.is_nil() {
            return Node::NIL;
        }
        if i == 0 {
            if is_shorthand_property_assignment(element) {
                return element.object_assignment_initializer();
            }
            if is_property_assignment(element) {
                element = element.initializer();
            }
            if is_assignment_expression(element, true) {
                return element.right();
            }
            return Node::NIL;
        }
        target = get_target_of_binding_or_assignment_element(element);
        if target.is_nil() {
            return Node::NIL;
        }
    }
    Node::NIL
}

/// The type of `left <operator> right` as seen from the right operand.
fn logical_result_type(
    c: &mut Checker,
    strict_null_checks: bool,
    operator: SyntaxKind,
    left: TypeId,
    right: TypeId,
) -> TypeId {
    match operator {
        SyntaxKind::AmpersandAmpersandToken if c.has_type_facts(left, TypeFacts::TRUTHY) => {
            let falsy_source = if strict_null_checks {
                left
            } else {
                c.get_base_type_of_literal_type(right)
            };
            let falsy = c.extract_definitely_falsy_types(falsy_source);
            c.get_union_type_ex(&[falsy, right], UnionReduction::LITERAL, None, TypeId::NIL)
        }
        SyntaxKind::BarBarToken if c.has_type_facts(left, TypeFacts::FALSY) => {
            let without_falsy = c.remove_definitely_falsy_types(left);
            let truthy = c.get_non_nullable_type(without_falsy);
            c.get_union_type_ex(&[truthy, right], UnionReduction::SUBTYPE, None, TypeId::NIL)
        }
        SyntaxKind::QuestionQuestionToken
            if c.has_type_facts(left, TypeFacts::EQ_UNDEFINED_OR_NULL) =>
        {
            let non_nullable = c.get_non_nullable_type(left);
            c.get_union_type_ex(
                &[non_nullable, right],
                UnionReduction::SUBTYPE,
                None,
                TypeId::NIL,
            )
        }
        _ => left,
    }
}

pub(super) fn is_in_narrowing_assignment(
    c: &mut Checker,
    strict_null_checks: bool,
    node: Node,
    mut uncast_type: TypeId,
    mut cast_type: TypeId,
) -> bool {
    let mut in_literal = false;
    // The property path from the assigned literal down to `node`, or None
    // when a step has no static name.
    let mut property_path: Option<Vec<String>> = Some(Vec::new());
    let mut current = node;
    while current.parent().is_some() {
        let parent = current.parent();
        let step = current;
        current = parent;

        if !in_literal
            && is_logical_or_coalescing_binary_expression(parent)
            && parent.right() == step
        {
            // The left operand can also be the value the receiver gets.
            let operator = parent.operator_token().kind();
            let left_type = c.get_type_at_location(parent.left());
            uncast_type =
                logical_result_type(c, strict_null_checks, operator, left_type, uncast_type);
            cast_type = logical_result_type(c, strict_null_checks, operator, left_type, cast_type);
        }
        if let Some(path) = &property_path
            && is_conditional_expression(parent)
            && parent.condition() != step
        {
            // Either branch can be the assigned value, so keep the other
            // branch's types when comparing with and without the assertion.
            let other = if parent.when_true() == step {
                parent.when_false()
            } else {
                parent.when_true()
            };
            let mut other_type = c.get_type_at_location(other);
            for name in path.iter().rev() {
                if other_type.is_nil() {
                    break;
                }
                let mut property_type = c.get_type_of_property_of_type(other_type, name.as_str());
                if property_type.is_nil() && parse_index(name).is_some() {
                    property_type = get_number_index_type(c, other_type);
                }
                other_type = property_type;
            }
            if other_type.is_some() {
                uncast_type = c.get_union_type_ex(
                    &[uncast_type, other_type],
                    UnionReduction::SUBTYPE,
                    None,
                    TypeId::NIL,
                );
                cast_type = c.get_union_type_ex(
                    &[cast_type, other_type],
                    UnionReduction::SUBTYPE,
                    None,
                    TypeId::NIL,
                );
            }
        }
        if !in_literal
            && is_binary_expression(parent)
            && parent.left() == step
            && matches!(
                parent.operator_token().kind(),
                SyntaxKind::BarBarToken | SyntaxKind::QuestionQuestionToken
            )
        {
            // These operators drop nullish values of their left operand, so
            // an assertion that only removes nullishness changes nothing.
            let uncast_non_nullable = c.get_non_nullable_type(uncast_type);
            let cast_non_nullable = c.get_non_nullable_type(cast_type);
            if c.is_type_identical_to(uncast_non_nullable, cast_non_nullable) {
                return false;
            }
        }
        if is_parenthesized_expression(parent)
            || is_logical_or_coalescing_binary_expression(parent)
            || (is_conditional_expression(parent) && parent.condition() != step)
            || (is_binary_expression(parent)
                && parent.operator_token().kind() == SyntaxKind::CommaToken
                && parent.right() == step)
        {
            continue;
        }
        if is_array_literal_expression(parent)
            || is_object_literal_expression(parent)
            || is_spread_assignment(parent)
            || (is_property_assignment(parent) && parent.initializer() == step)
        {
            in_literal = true;
            if is_property_assignment(parent) {
                let (name, known) = try_get_text_of_property_name(parent.name());
                push_path_step(&mut property_path, known.then_some(name));
            } else if is_array_literal_expression(parent) {
                let elements = parent.elements();
                // A spread before the element shifts its runtime index.
                let index = elements
                    .iter()
                    .position(|element| element == step)
                    .filter(|&index| !elements.iter().take(index).any(is_spread_element));
                push_path_step(&mut property_path, index.map(|index| index.to_string()));
            } else if is_object_literal_expression(parent)
                && let Some(name) = property_path.as_ref().and_then(|path| path.last())
            {
                // A later required property replaces this value, so the
                // assertion cannot narrow the target. This follows the
                // checker's rules for spread properties.
                let properties = parent.properties();
                let after = properties
                    .iter()
                    .position(|property| property == step)
                    .map_or(0, |i| i + 1);
                for property in properties.iter().skip(after) {
                    if is_spread_assignment(property) {
                        let spread_type = c.get_type_at_location(property.expression());
                        let overwriting = c.get_property_of_type(spread_type, name.as_str());
                        if overwriting.is_some() {
                            let symbol = c.sym(overwriting);
                            let (flags, check_flags) = (symbol.flags, symbol.check_flags);
                            if !flags.intersects(SymbolFlags::OPTIONAL)
                                && !check_flags.intersects(CheckFlags::PARTIAL)
                                && !c
                                    .get_declaration_modifier_flags_from_symbol(overwriting)
                                    .intersects(ModifierFlags::PRIVATE | ModifierFlags::PROTECTED)
                                && c.is_spreadable_property(overwriting)
                            {
                                return false;
                            }
                        }
                        continue;
                    }
                    if property.name().is_nil() {
                        continue;
                    }
                    let (property_name, known) = try_get_text_of_property_name(property.name());
                    if known && property_name == *name {
                        return false;
                    }
                }
            }
            continue;
        }
        if !is_assignment_expression(parent, true) || parent.right() != step {
            return false;
        }

        let left = skip_parentheses(parent.left());
        let receiver_type = if in_literal {
            if !is_assignment_pattern(left) {
                return false;
            }
            // The destructuring target gives the type of the matching element.
            let receiver = c.get_contextual_type(node, ContextFlags::NONE);
            if let Some(path) = &property_path {
                let initializer = destructuring_default(left, path);
                if initializer.is_some() {
                    uncast_type = c.get_type_with_default(uncast_type, initializer);
                    cast_type = c.get_type_with_default(cast_type, initializer);
                }
            }
            receiver
        } else {
            c.get_type_at_location(left)
        };
        if receiver_type.is_nil() {
            return false;
        }
        let constraint = c.get_base_constraint_of_type(receiver_type);
        let receiver_type = if constraint.is_some() {
            constraint
        } else {
            receiver_type
        };
        if !is_union_type(c, receiver_type) {
            return false;
        }

        // Assertions that leave the same union members reachable can still
        // be reported.
        let uncast_reduced = c.get_assignment_reduced_type(receiver_type, uncast_type);
        let cast_reduced = c.get_assignment_reduced_type(receiver_type, cast_type);
        return !c.is_type_identical_to(uncast_reduced, cast_reduced);
    }
    false
}

/// Appends a step to a known property path. A step without a static name
/// makes the path unknown.
fn push_path_step(path: &mut Option<Vec<String>>, step: Option<String>) {
    match (path.as_mut(), step) {
        (Some(steps), Some(step)) => steps.push(step),
        _ => *path = None,
    }
}
