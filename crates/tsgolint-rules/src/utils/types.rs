//! Type predicates and type walkers (tsgolint `ts_api_utils.go`, `utils.go`,
//! `base_type_utils.go`). Most mirror ts-api-utils helpers of the same name.
//!
//! A nil `TypeId` is Go's nil `*checker.Type`: the flag predicates return
//! false for it, as tsgolint's do.

use goport_core::ast::TextRange;
use goport_core::checker::{Checker, LiteralValue, SharedList};
use goport_core::core::{Node, SignatureId, SymbolId, TypeId};
use goport_core::flags::{ObjectFlags, SignatureKind, SymbolFlags, TypeFlags};
use tsgolint_core::{RuleContext, RuleMessage};

/// ts-api-utils `isTypeFlagSet`. False for a nil type.
pub fn is_type_flag_set(c: &Checker, t: TypeId, flags: TypeFlags) -> bool {
    t.is_some() && c.ty(t).flags.intersects(flags)
}

/// ts-api-utils `isIntrinsicType` (any of `TypeFlags::INTRINSIC`).
pub fn is_intrinsic_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::INTRINSIC)
}

/// ts-api-utils `isIntrinsicErrorType`: the checker's `error` intrinsic.
pub fn is_intrinsic_error_type(c: &Checker, t: TypeId) -> bool {
    is_intrinsic_type(c, t) && c.ty(t).as_intrinsic_type().intrinsic_name() == "error"
}

/// The text of `t`, or `error` for the checker's error type.
pub fn type_to_string_or_error(c: &mut Checker, t: TypeId) -> String {
    if is_intrinsic_error_type(c, t) {
        "error".to_owned()
    } else {
        c.type_to_string(t)
    }
}

/// The value of a literal type (Go `LiteralType.Value()`). `t` must be a
/// literal type.
pub fn literal_type_value(c: &Checker, t: TypeId) -> Option<&LiteralValue> {
    c.ty(t).as_literal_type().value()
}

/// The value of a `true` or `false` literal type; None for other types.
pub fn boolean_literal_value(c: &Checker, t: TypeId) -> Option<bool> {
    if !is_type_flag_set(c, t, TypeFlags::BOOLEAN_LITERAL) {
        return None;
    }
    match literal_type_value(c, t) {
        Some(LiteralValue::Bool(value)) => Some(*value),
        _ => None,
    }
}

/// ts-api-utils `isIntrinsicVoidType` (tsgolint tests only `TypeFlags::VOID`).
pub fn is_intrinsic_void_type(c: &Checker, t: TypeId) -> bool {
    is_type_void_type(c, t)
}

/// ts-api-utils `isUnionType`.
pub fn is_union_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::UNION)
}

/// ts-api-utils `isIntersectionType`.
pub fn is_intersection_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::INTERSECTION)
}

/// typescript-eslint `isTypeAnyType`.
pub fn is_type_any_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::ANY)
}

/// typescript-eslint `isTypeUnknownType`.
pub fn is_type_unknown_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::UNKNOWN)
}

/// ts-api-utils `isObjectType`.
pub fn is_object_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::OBJECT)
}

/// ts-api-utils `isTypeParameter`.
pub fn is_type_parameter(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::TYPE_PARAMETER)
}

/// `TypeFlags::NULL` is set.
pub fn is_type_null_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::NULL)
}

/// `TypeFlags::UNDEFINED` is set.
pub fn is_type_undefined_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::UNDEFINED)
}

/// `TypeFlags::VOID` is set.
pub fn is_type_void_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::VOID)
}

/// ts-api-utils `isSymbolFlagSet`. False for a nil symbol.
pub fn is_symbol_flag_set(c: &Checker, symbol: SymbolId, flags: SymbolFlags) -> bool {
    symbol.is_some() && c.sym(symbol).flags.intersects(flags)
}

/// ts-api-utils `unionTypeParts`: the members of a union, or `[t]`.
///
/// The list is a cheap copy, so it can be iterated across `&mut Checker`
/// calls.
pub fn union_type_parts(c: &Checker, t: TypeId) -> SharedList<TypeId> {
    if is_union_type(c, t) {
        c.ty(t).types_list()
    } else {
        SharedList::from(&[t][..])
    }
}

/// ts-api-utils `intersectionTypeParts`: the members of an intersection, or
/// `[t]`.
pub fn intersection_type_parts(c: &Checker, t: TypeId) -> SharedList<TypeId> {
    if is_intersection_type(c, t) {
        c.ty(t).types_list()
    } else {
        SharedList::from(&[t][..])
    }
}

/// Calls `visit` on each union member, or on `t` when it is not a union.
/// Stops and returns false as soon as `visit` returns false.
pub fn visit_union_type_parts(
    c: &mut Checker,
    t: TypeId,
    mut visit: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .all(|part| visit(c, part))
}

/// Whether `predicate` holds for some union member, or for `t` when it is
/// not a union.
pub fn some_union_type_part(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    union_type_parts(c, t)
        .into_iter()
        .any(|part| predicate(c, part))
}

/// typescript-eslint `typeRecurser`-style walk: calls `predicate` on each
/// leaf of nested unions and intersections and stops at the first true.
pub fn type_recurser(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    type_recurser_worker(c, t, &mut predicate)
}

fn type_recurser_worker<F>(c: &mut Checker, t: TypeId, predicate: &mut F) -> bool
where
    F: FnMut(&mut Checker, TypeId) -> bool,
{
    if is_type_flag_set(c, t, TypeFlags::UNION_OR_INTERSECTION) {
        let parts = c.ty(t).types_list();
        parts
            .into_iter()
            .any(|part| type_recurser_worker(c, part, predicate))
    } else {
        predicate(c, t)
    }
}

/// typescript-eslint `matchesTypeOrBaseType`-style walk: `predicate` holds
/// for `t` or, recursively, for a base type of its class or interface.
pub fn matches_type_or_base_type(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    matches_type_or_base_type_worker(c, t, &mut predicate)
}

fn matches_type_or_base_type_worker<F>(c: &mut Checker, t: TypeId, predicate: &mut F) -> bool
where
    F: FnMut(&mut Checker, TypeId) -> bool,
{
    if predicate(c, t) {
        return true;
    }
    if !is_object_type(c, t) {
        return false;
    }
    let target = if c.ty(t).object_flags.intersects(ObjectFlags::REFERENCE) {
        c.ty(t).target()
    } else {
        t
    };
    if !c
        .ty(target)
        .object_flags
        .intersects(ObjectFlags::CLASS_OR_INTERFACE)
    {
        return false;
    }
    c.get_base_types(target)
        .into_iter()
        .any(|base| matches_type_or_base_type_worker(c, base, predicate))
}

/// The number index type of `t` (checker `getIndexTypeOfType(t, number)`),
/// nil when there is none.
pub fn get_number_index_type(c: &mut Checker, t: TypeId) -> TypeId {
    let number = c.number_type;
    c.get_index_type_of_type(t, number)
}

/// ts-api-utils `getCallSignaturesOfType` without the union handling: the
/// checker's `getSignaturesOfType(t, Call)`.
pub fn get_call_signatures(c: &mut Checker, t: TypeId) -> SharedList<SignatureId> {
    c.get_signatures_of_type(t, SignatureKind::CALL)
}

/// The checker's `getSignaturesOfType(t, Construct)`.
pub fn get_construct_signatures(c: &mut Checker, t: TypeId) -> SharedList<SignatureId> {
    c.get_signatures_of_type(t, SignatureKind::CONSTRUCT)
}

/// ts-api-utils `getCallSignaturesOfType`: all call signatures of a union's
/// members; for an intersection, the signatures of its only member that has
/// some (none when two members have some).
pub fn collect_all_call_signatures(c: &mut Checker, t: TypeId) -> Vec<SignatureId> {
    if is_union_type(c, t) {
        let parts = c.ty(t).types_list();
        let mut signatures = Vec::new();
        for part in parts {
            signatures.extend(get_call_signatures(c, part));
        }
        return signatures;
    }
    if is_intersection_type(c, t) {
        let parts = c.ty(t).types_list();
        let mut found: Option<SharedList<SignatureId>> = None;
        for part in parts {
            let signatures = get_call_signatures(c, part);
            if !signatures.is_empty() {
                if found.is_some() {
                    return Vec::new();
                }
                found = Some(signatures);
            }
        }
        return found.map(|s| s.to_vec()).unwrap_or_default();
    }
    get_call_signatures(c, t).to_vec()
}

/// Whether the apparent type of `param` at `node` has a call signature (a
/// union through any member).
pub fn is_function_param(c: &mut Checker, param: SymbolId, node: Node) -> bool {
    let param_type = c.get_type_of_symbol_at_location(param, node);
    let t = c.get_apparent_type(param_type);
    if t.is_nil() {
        return false;
    }
    union_type_parts(c, t)
        .into_iter()
        .any(|part| !get_call_signatures(c, part).is_empty())
}

/// ts-api-utils `isCallback`: the type of `param` at `node` (its element
/// type for a rest parameter) has a member with a call signature.
pub fn is_callback(c: &mut Checker, param: SymbolId, node: Node) -> bool {
    let param_type = c.get_type_of_symbol_at_location(param, node);
    let mut t = c.get_apparent_type(param_type);
    let declaration = c.sym(param).value_declaration;
    if declaration.is_some() && super::nodes::is_rest_parameter_declaration(declaration) {
        let number = c.number_type;
        t = c.get_index_type_of_type(t, number);
        if t.is_nil() {
            return false;
        }
    }
    union_type_parts(c, t)
        .into_iter()
        .any(|part| !get_call_signatures(c, part).is_empty())
}

/// ts-api-utils `isThenableType`: some member of the apparent type has a
/// `then` method whose first parameter is a callback.
///
/// A nil `t` means the type of `node`.
pub fn is_thenable_type(c: &mut Checker, node: Node, t: TypeId) -> bool {
    let t = if t.is_nil() {
        c.get_type_at_location(node)
    } else {
        t
    };
    // tsgolint looks at union members only, not at intersection members.
    let apparent = c.get_apparent_type(t);
    for part in union_type_parts(c, apparent) {
        let then = c.get_property_of_type(part, "then");
        if then.is_nil() {
            continue;
        }
        let then_type = c.get_type_of_symbol_at_location(then, node);
        for then_part in union_type_parts(c, then_type) {
            for signature in c.get_signatures_of_type(then_part, SignatureKind::CALL) {
                let first_param = c.sig(signature).parameters().first().copied();
                if first_param.is_some_and(|param| is_callback(c, param, node)) {
                    return true;
                }
            }
        }
    }
    false
}

/// ts-api-utils `getWellKnownSymbolPropertyOfType`: the property for
/// `Symbol.<name>` (for example `asyncIterator`).
pub fn get_well_known_symbol_property_of_type(c: &mut Checker, t: TypeId, name: &str) -> SymbolId {
    let property_name = c.get_property_name_for_known_symbol_name(name);
    c.get_property_of_type(t, property_name.as_str())
}

/// Reports tsgolint's `noStrictNullCheck` diagnostic at the start of the
/// file when `strictNullChecks` is off. Returns whether it is on.
pub fn require_strict_null_checks(ctx: &mut RuleContext<'_>) -> bool {
    let options = ctx.compiler_options();
    let enabled = options.get_strict_option_value(options.strict_null_checks);
    if !enabled {
        let message = RuleMessage::new(
            "noStrictNullCheck",
            "This rule requires the `strictNullChecks` compiler option to be turned on to function correctly.",
        );
        ctx.report_range(TextRange::new(0, 0), message);
    }
    enabled
}
