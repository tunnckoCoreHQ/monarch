//! How `no-unnecessary-condition` resolves the type of an expression, and
//! where the nullishness of an access or a call comes from.

use goport_core::ast::{get_text_of_property_name, skip_parentheses};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{CheckMode, ObjectFlags, SymbolFlags, TypeFlags};

use super::State;
use super::types::{is_nullish_type, property_name_of_literal_type, remove_nullish_from_type};
use crate::utils::{
    get_constraint_info, get_type_name, is_access_expression, is_type_flag_set, is_union_type,
    union_type_parts,
};

pub(super) fn is_property_access(node: Node) -> bool {
    node.is_some() && node.kind() == SyntaxKind::PropertyAccessExpression
}

pub(super) fn is_element_access(node: Node) -> bool {
    node.is_some() && node.kind() == SyntaxKind::ElementAccessExpression
}

pub(super) fn is_call(node: Node) -> bool {
    node.is_some() && node.kind() == SyntaxKind::CallExpression
}

/// A property access, element access or call.
pub(super) fn is_chain_member(node: Node) -> bool {
    node.is_some() && is_access_expression(node)
}

/// `node` is an access or a call with its own `?.`.
pub(super) fn has_own_question_dot(node: Node) -> bool {
    is_chain_member(node) && node.question_dot_token().is_some()
}

/// Some access or call in the chain of `node` has a `?.`.
pub(super) fn has_optional_chain(node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    if !is_chain_member(node) {
        return false;
    }
    node.question_dot_token().is_some() || has_optional_chain(node.expression())
}

/// For `T[K]`, the type of the property, string index or number index that
/// the constraints of `T` and `K` select; else `t`.
pub(super) fn resolve_indexed_access_type(c: &mut Checker, t: TypeId) -> TypeId {
    if !is_type_flag_set(c, t, TypeFlags::INDEXED_ACCESS) {
        return t;
    }
    let access = c.ty(t).as_indexed_access_type();
    let (mut object_type, mut index_type) = (access.object_type, access.index_type);
    if object_type.is_nil() || index_type.is_nil() {
        return t;
    }
    let constraint = c.get_base_constraint_of_type(object_type);
    if constraint.is_some() {
        object_type = constraint;
    }
    let constraint = c.get_base_constraint_of_type(index_type);
    if constraint.is_some() {
        index_type = constraint;
    }

    if let Some(name) = property_name_of_literal_type(c, index_type) {
        let property_type = c.get_type_of_property_of_type(object_type, name.as_str());
        if property_type.is_some() {
            return property_type;
        }
    }

    let index_parts = union_type_parts(c, index_type);
    if index_parts
        .iter()
        .any(|&part| is_type_flag_set(c, part, TypeFlags::STRING_LIKE))
    {
        let string_index_type = c.get_string_index_type(object_type);
        if string_index_type.is_some() {
            return string_index_type;
        }
    }
    if index_parts
        .iter()
        .any(|&part| is_type_flag_set(c, part, TypeFlags::NUMBER_LIKE))
    {
        let number_index_type = c.get_number_index_type(object_type);
        if number_index_type.is_some() {
            return number_index_type;
        }
    }
    t
}

/// The type of `node`, through the constraint of a type parameter (nil when
/// it has none) and through resolvable indexed accesses.
pub(super) fn get_resolved_type(c: &mut Checker, node: Node) -> TypeId {
    let node_type = c.get_type_at_location(node);
    if node_type.is_nil() {
        return TypeId::NIL;
    }
    let Some(constraint) = get_constraint_info(c, node_type).constraint() else {
        return TypeId::NIL;
    };
    resolve_indexed_access_type(c, constraint)
}

/// `Some(t)` when `t` is not an indexed access or resolves to a type that is
/// not one; `None` when the caller should skip.
pub(super) fn constrain_indexed_access_type(c: &mut Checker, t: TypeId) -> Option<TypeId> {
    if !is_type_flag_set(c, t, TypeFlags::INDEXED_ACCESS) {
        return Some(t);
    }
    let resolved = resolve_indexed_access_type(c, t);
    if resolved.is_nil() || is_type_flag_set(c, resolved, TypeFlags::INDEXED_ACCESS) {
        None
    } else {
        Some(resolved)
    }
}

fn some_resolved_part(
    c: &mut Checker,
    node: Node,
    predicate: impl Fn(&Checker, TypeId) -> bool,
) -> bool {
    let t = get_resolved_type(c, node);
    t.is_some()
        && union_type_parts(c, t)
            .iter()
            .any(|&part| predicate(c, part))
}

/// `arr[i]` on an array, or `tuple[i]` with a non-literal index.
pub(super) fn is_array_index_expression(c: &mut Checker, node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    if !is_element_access(node) {
        return false;
    }
    let argument = node.argument_expression();
    if argument.is_nil() {
        return false;
    }
    let object = node.expression();
    some_resolved_part(c, object, |c, part| c.is_array_type(part))
        || (some_resolved_part(c, object, |c, part| c.is_tuple_type(part))
            && skip_parentheses(argument).kind() != SyntaxKind::NumericLiteral)
}

/// Whether reading `property_type` (a key type) from `object_type` can give
/// a nullish value.
pub(super) fn is_nullable_property_type(
    c: &mut Checker,
    object_type: TypeId,
    property_type: TypeId,
) -> bool {
    if object_type.is_nil() || property_type.is_nil() {
        return false;
    }
    if is_union_type(c, property_type) {
        return c
            .ty(property_type)
            .types_list()
            .iter()
            .any(|&part| is_nullable_property_type(c, object_type, part));
    }
    if let Some(name) = property_name_of_literal_type(c, property_type) {
        let t = c.get_type_of_property_of_type(object_type, name.as_str());
        if t.is_some() {
            return is_nullish_type(c, t);
        }
    }
    let property_type_name = get_type_name(c, property_type);
    for info in c.get_index_infos_of_type(object_type).iter() {
        let key_type = c.index_info(*info).key_type();
        if get_type_name(c, key_type) == property_type_name {
            return true;
        }
    }
    false
}

pub(super) fn is_nullable_element_access_expression(c: &mut Checker, node: Node) -> bool {
    let argument = node.argument_expression();
    if argument.is_nil() {
        return false;
    }
    let object_type = c.get_type_at_location(node.expression());
    let property_type = c.get_type_at_location(argument);
    is_nullable_property_type(c, object_type, property_type)
}

fn first_call_signature_return_type(c: &mut Checker, t: TypeId) -> TypeId {
    match c.get_call_signatures(t).first() {
        Some(&signature) => c.get_return_type_of_signature(signature),
        None => TypeId::NIL,
    }
}

/// The type a call returns, without the `undefined` that an earlier `?.` in
/// its chain adds.
pub(super) fn get_call_return_type(c: &mut Checker, call: Node) -> TypeId {
    if !is_call(call) {
        return TypeId::NIL;
    }
    if call.question_dot_token().is_nil() && !has_optional_chain(call.expression()) {
        let t = get_resolved_type(c, call);
        if t.is_some() {
            return t;
        }
    }
    let signature = c.get_resolved_signature(call, None, CheckMode::NORMAL);
    if signature.is_some() {
        let t = c.get_return_type_of_signature(signature);
        if t.is_some() {
            return t;
        }
    }

    let function_type = get_resolved_type(c, call.expression());
    if function_type.is_nil() {
        return TypeId::NIL;
    }
    // tsgolint then walks the parts of a union, but no union is left here:
    // this is one part of the original type.
    let function_type = remove_nullish_from_type(c, function_type);
    if function_type.is_nil() {
        return TypeId::NIL;
    }
    first_call_signature_return_type(c, function_type)
}

/// The type of the property that `property_access` reads on `base_type`.
pub(super) fn get_property_type_from_base(
    st: &State,
    c: &mut Checker,
    base_type: TypeId,
    property_access: Node,
) -> TypeId {
    if base_type.is_nil() || !is_property_access(property_access) {
        return TypeId::NIL;
    }
    let base = remove_nullish_from_type(c, base_type);
    if base.is_nil() {
        return TypeId::NIL;
    }
    let name = property_access.name();
    if name.is_nil() {
        return c.get_type_at_location(property_access);
    }
    let property_name = get_text_of_property_name(name);
    if property_name.is_empty() {
        return c.get_type_at_location(property_access);
    }

    let property = c.get_property_of_type(base, property_name.as_str());
    if property.is_some() {
        return c.get_type_of_symbol(property);
    }
    let apparent_type = c.get_apparent_type(base);
    if apparent_type.is_some() && apparent_type != base {
        let property = c.get_property_of_type(apparent_type, property_name.as_str());
        if property.is_some() {
            return c.get_type_of_symbol(property);
        }
    }

    let mut string_index_type = c.get_string_index_type(base);
    if string_index_type.is_nil() && apparent_type.is_some() {
        string_index_type = c.get_string_index_type(apparent_type);
    }
    // Mapped types with template literal keys (`Lowercase<string>`) have no
    // string index: look the property up by name.
    if string_index_type.is_nil() && c.ty(base).object_flags.intersects(ObjectFlags::MAPPED) {
        for property in c.get_properties_of_type(base).iter().copied() {
            let symbol = c.sym(property);
            if symbol.name.as_str() == property_name {
                if symbol.flags.intersects(SymbolFlags::OPTIONAL) {
                    return TypeId::NIL;
                }
                return c.get_type_of_symbol(property);
            }
        }
        return TypeId::NIL;
    }
    if string_index_type.is_some() {
        // With noUncheckedIndexedAccess the read adds `undefined`; let the
        // caller use the type at the location.
        if st.no_unchecked_indexed_access {
            return TypeId::NIL;
        }
        return string_index_type;
    }
    c.get_type_at_location(property_access)
}

/// The type of `access` (`.x` or `[k]`) on the result of `call`.
pub(super) fn get_type_from_call_property(
    st: &State,
    c: &mut Checker,
    call: Node,
    access: Node,
) -> TypeId {
    let mut return_type = get_call_return_type(c, call);
    if return_type.is_nil() {
        return_type = c.get_type_at_location(call);
        if return_type.is_nil() {
            return TypeId::NIL;
        }
    }
    let return_type = remove_nullish_from_type(c, return_type);
    if return_type.is_nil() {
        return TypeId::NIL;
    }
    if is_property_access(access) {
        return get_property_type_from_base(st, c, return_type, access);
    }
    c.get_type_at_location(access)
}

/// The callee is a union that is nullish while none of its signatures
/// returns a nullish type: the call result is nullish only because of the
/// callee.
pub(super) fn is_call_expression_nullable_origin_from_callee(c: &mut Checker, call: Node) -> bool {
    if call.is_nil() {
        return false;
    }
    let callee_type = get_resolved_type(c, call.expression());
    if callee_type.is_nil() || !is_union_type(c, callee_type) {
        return false;
    }
    let parts = c.ty(callee_type).types_list();
    let own_nullable = parts.iter().copied().any(|part| {
        c.get_call_signatures(part).into_iter().any(|signature| {
            let return_type = c.get_return_type_of_signature(signature);
            return_type.is_some() && is_nullish_type(c, return_type)
        })
    });
    !own_nullable && is_nullish_type(c, callee_type)
}

/// The member that an access expression reads.
enum Member {
    /// `x[key]`, with the type of `key` (nil when it has none).
    Computed(TypeId),
    /// `x.name`.
    Named(String),
}

/// The object of an access is a nullish union, while the accessed member of
/// each non-nullish part is not nullish: the access result is nullish only
/// because of the object.
fn is_member_expression_nullable_origin_from_object(
    st: &State,
    c: &mut Checker,
    node: Node,
) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    let member = match node.kind() {
        SyntaxKind::PropertyAccessExpression => {
            let name = node.name();
            if name.is_nil() {
                return false;
            }
            Member::Named(get_text_of_property_name(name))
        }
        SyntaxKind::ElementAccessExpression => {
            let argument = node.argument_expression();
            if argument.is_nil() {
                return false;
            }
            Member::Computed(get_resolved_type(c, argument))
        }
        _ => return false,
    };

    let object_type = get_resolved_type(c, node.expression());
    if object_type.is_nil() || !is_union_type(c, object_type) {
        return false;
    }
    let parts = c.ty(object_type).types_list();
    let own_nullable = parts
        .iter()
        .copied()
        .any(|part| !is_nullish_type(c, part) && is_member_nullish_in(st, c, part, &member));
    !own_nullable && is_nullish_type(c, object_type)
}

/// Whether `member` is nullish in `part`, a non-nullish part of the object.
fn is_member_nullish_in(st: &State, c: &mut Checker, part: TypeId, member: &Member) -> bool {
    let name = match member {
        Member::Computed(key_type) => {
            return key_type.is_some() && is_nullable_property_type(c, part, *key_type);
        }
        Member::Named(name) if name.is_empty() => return false,
        Member::Named(name) => name.as_str(),
    };
    let t = c.get_type_of_property_of_type(part, name);
    if t.is_some() {
        return is_nullish_type(c, t);
    }
    c.get_index_infos_of_type(part).iter().copied().any(|info| {
        let (key_type, value_type) = {
            let info = c.index_info(info);
            (info.key_type(), info.value_type())
        };
        get_type_name(c, key_type) == "string"
            && (st.no_unchecked_indexed_access || is_nullish_type(c, value_type))
    })
}

/// The expression can be nullish by itself, so a `?.` after it is needed.
pub(super) fn is_optionable_expression(st: &State, c: &mut Checker, node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    let node = skip_parentheses(node);
    let t = get_resolved_type(c, node);
    if t.is_nil() {
        return false;
    }
    if super::types::is_conditional_always_necessary(c, t) {
        return true;
    }
    let own_nullable = match node.kind() {
        SyntaxKind::PropertyAccessExpression | SyntaxKind::ElementAccessExpression => {
            !is_member_expression_nullable_origin_from_object(st, c, node)
        }
        SyntaxKind::CallExpression => !is_call_expression_nullable_origin_from_callee(c, node),
        _ => true,
    };
    own_nullable && is_nullish_type(c, t)
}
