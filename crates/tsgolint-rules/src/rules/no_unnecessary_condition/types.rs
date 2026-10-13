//! Type-level predicates of `no-unnecessary-condition` that need no options.

use goport_core::checker::{Checker, LiteralValue};
use goport_core::core::TypeId;
use goport_core::flags::TypeFlags;

use crate::utils::{
    boolean_literal_value, is_intersection_type, is_type_flag_set, is_union_type,
    literal_type_value,
};

const NULLISH: TypeFlags = TypeFlags::NULL
    .union(TypeFlags::UNDEFINED)
    .union(TypeFlags::VOID);

/// `any`, `unknown`, a type parameter or `keyof T`: nothing can be said
/// about its truthiness or nullishness.
pub(super) fn is_indeterminate_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(
        c,
        t,
        TypeFlags::ANY_OR_UNKNOWN | TypeFlags::TYPE_PARAMETER | TypeFlags::INDEX,
    )
}

/// `null`, `undefined` or `void` itself (not a union that contains one).
pub(super) fn is_always_nullish_type(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, NULLISH)
}

/// `t` is or contains `null`, `undefined` or `void`.
pub(super) fn is_nullish_type(c: &Checker, t: TypeId) -> bool {
    if is_union_type(c, t) {
        return c.ty(t).types().iter().any(|&part| is_nullish_type(c, part));
    }
    is_type_flag_set(c, t, NULLISH)
}

/// `t` without its nullish parts, or nil when nothing is left.
///
/// tsgolint returns the first non-nullish part of a union, not a new union.
pub(super) fn remove_nullish_from_type(c: &Checker, t: TypeId) -> TypeId {
    if !is_union_type(c, t) {
        return if is_type_flag_set(c, t, NULLISH) {
            TypeId::NIL
        } else {
            t
        };
    }
    c.ty(t)
        .types()
        .iter()
        .copied()
        .find(|&part| !is_nullish_type(c, part))
        .unwrap_or(TypeId::NIL)
}

/// A union part of `t` is `any`, `unknown` or a type variable.
pub(super) fn is_conditional_always_necessary(c: &Checker, t: TypeId) -> bool {
    let check = |part: TypeId| {
        is_type_flag_set(
            c,
            part,
            TypeFlags::ANY_OR_UNKNOWN | TypeFlags::TYPE_VARIABLE,
        )
    };
    if is_union_type(c, t) {
        c.ty(t).types().iter().any(|&part| check(part))
    } else {
        check(t)
    }
}

/// The `true` literal type.
pub(super) fn is_true_literal_type(c: &Checker, t: TypeId) -> bool {
    boolean_literal_value(c, t) == Some(true)
}

/// A type with a single known value: a boolean, string, number or bigint
/// literal, `undefined` or `null`.
pub(super) fn is_static_value(c: &Checker, t: TypeId) -> bool {
    if t.is_nil() {
        return false;
    }
    let ty = c.ty(t);
    let flags = ty.flags;
    if flags.intersects(TypeFlags::BOOLEAN_LITERAL) {
        return boolean_literal_value(c, t).is_some();
    }
    if flags.intersects(TypeFlags::UNDEFINED | TypeFlags::NULL) {
        return true;
    }
    (flags.intersects(TypeFlags::STRING_LITERAL) && ty.is_string_literal())
        || (flags.intersects(TypeFlags::NUMBER_LITERAL) && ty.is_number_literal())
        || (flags.intersects(TypeFlags::BIG_INT_LITERAL) && ty.is_big_int_literal())
}

/// The string value of a string literal type.
pub(super) fn string_literal_value(c: &Checker, t: TypeId) -> Option<String> {
    if !c.ty(t).is_string_literal() {
        return None;
    }
    match literal_type_value(c, t) {
        Some(LiteralValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

/// The property name of a string or number literal type.
pub(super) fn property_name_of_literal_type(c: &Checker, t: TypeId) -> Option<String> {
    if t.is_nil() {
        return None;
    }
    if let Some(value) = string_literal_value(c, t) {
        return Some(value);
    }
    if c.ty(t).is_number_literal()
        && let Some(LiteralValue::Number(value)) = literal_type_value(c, t)
    {
        return Some(value.to_string());
    }
    None
}

/// Whether a type is always truthy, always falsy, or neither.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Truthiness {
    AlwaysTruthy,
    AlwaysFalsy,
    Either,
}

impl Truthiness {
    fn of_value(truthy: bool) -> Self {
        if truthy {
            Self::AlwaysTruthy
        } else {
            Self::AlwaysFalsy
        }
    }
}

/// Whether every value of `t` is truthy, or every value is falsy.
pub(super) fn check_type_condition(c: &Checker, t: TypeId) -> Truthiness {
    let ty = c.ty(t);
    let flags = ty.flags;
    if flags.intersects(TypeFlags::NEVER) {
        return Truthiness::AlwaysFalsy;
    }
    // tsgolint does not resolve `T[K]`.
    if flags.intersects(TypeFlags::INDEXED_ACCESS) {
        return Truthiness::Either;
    }
    if is_union_type(c, t) {
        let mut parts = ty.types().iter().map(|&part| check_type_condition(c, part));
        let first = parts.next().unwrap_or(Truthiness::Either);
        return if parts.all(|part| part == first) {
            first
        } else {
            Truthiness::Either
        };
    }
    if is_intersection_type(c, t) {
        let mut result = Truthiness::AlwaysTruthy;
        for &part in ty.types() {
            match check_type_condition(c, part) {
                Truthiness::AlwaysFalsy => return Truthiness::AlwaysFalsy,
                Truthiness::Either => result = Truthiness::Either,
                Truthiness::AlwaysTruthy => {}
            }
        }
        return result;
    }
    if flags.intersects(NULLISH) {
        return Truthiness::AlwaysFalsy;
    }
    if flags.intersects(
        TypeFlags::OBJECT
            | TypeFlags::NON_PRIMITIVE
            | TypeFlags::ES_SYMBOL
            | TypeFlags::UNIQUE_ES_SYMBOL,
    ) {
        return Truthiness::AlwaysTruthy;
    }
    if let Some(value) = boolean_literal_value(c, t) {
        return Truthiness::of_value(value);
    }
    let literal = |kind: TypeFlags, is_kind: bool| flags.intersects(kind) && is_kind;
    if literal(TypeFlags::STRING_LITERAL, ty.is_string_literal())
        || literal(TypeFlags::NUMBER_LITERAL, ty.is_number_literal())
        || literal(TypeFlags::BIG_INT_LITERAL, ty.is_big_int_literal())
    {
        let falsy = match literal_type_value(c, t) {
            Some(LiteralValue::String(value)) => value.is_empty(),
            // tsgolint compares the JS string of the number to "0" and "NaN".
            Some(LiteralValue::Number(value)) => value.0 == 0.0 || value.0.is_nan(),
            Some(LiteralValue::PseudoBigInt(value)) => value.to_string() == "0",
            _ => return Truthiness::Either,
        };
        return Truthiness::of_value(!falsy);
    }
    Truthiness::Either
}
/// Go `truncateTypeNameForDiagnostic`: at most 120 characters.
pub(super) fn truncate_type_name(type_name: String) -> String {
    const MAX_LENGTH: usize = 120;
    if type_name.chars().count() > MAX_LENGTH {
        let mut truncated: String = type_name.chars().take(MAX_LENGTH - 3).collect();
        truncated.push_str("...");
        truncated
    } else {
        type_name
    }
}
