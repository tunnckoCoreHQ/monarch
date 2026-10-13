//! What the type of a checked expression can be.

use std::rc::Rc;

use goport_core::checker::Checker;
use goport_core::checker::types::LiteralValue;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;

use super::Processor;
use crate::utils::{
    boolean_literal_value, intersection_type_parts, is_type_any_type, is_type_flag_set,
    is_type_null_type, is_type_undefined_type, is_type_unknown_type, is_type_void_type,
    literal_type_value, union_type_parts,
};

#[derive(Default)]
pub(super) struct TypeInfo {
    pub parts: Vec<TypeId>,
    pub has_null: bool,
    pub has_undefined: bool,
    pub has_void: bool,
    pub has_any: bool,
    pub has_unknown: bool,
    pub has_bool_literal: bool,
    pub has_num_literal: bool,
    pub has_str_literal: bool,
    pub has_big_int_literal: bool,
    pub has_big_int_like: bool,
    pub has_boolean_like: bool,
    pub has_number_like: bool,
    pub has_string_like: bool,
}

impl TypeInfo {
    fn of(checker: &Checker, t: TypeId) -> Self {
        let parts = union_type_parts(checker, t).to_vec();
        let mut info = Self::default();
        for &part in &parts {
            let has = |flags| is_type_flag_set(checker, part, flags);
            info.has_null |= is_type_null_type(checker, part);
            info.has_undefined |= is_type_undefined_type(checker, part);
            info.has_void |= is_type_void_type(checker, part);
            info.has_any |= is_type_any_type(checker, part);
            info.has_unknown |= is_type_unknown_type(checker, part);
            info.has_bool_literal |= has(TypeFlags::BOOLEAN_LITERAL);
            info.has_num_literal |= has(TypeFlags::NUMBER_LITERAL);
            info.has_str_literal |= has(TypeFlags::STRING_LITERAL);
            info.has_big_int_literal |= has(TypeFlags::BIG_INT_LITERAL);
            info.has_big_int_like |= has(TypeFlags::BIG_INT_LIKE);
            info.has_boolean_like |= has(TypeFlags::BOOLEAN_LIKE);
            info.has_number_like |= has(TypeFlags::NUMBER_LIKE);
            info.has_string_like |= has(TypeFlags::STRING_LIKE);
        }
        info.parts = parts;
        info
    }

    pub(super) fn is_nullish(&self) -> bool {
        self.has_null || self.has_undefined || self.has_any || self.has_unknown
    }

    /// Null or undefined, not counting any and unknown.
    pub(super) fn has_explicit_nullish(&self) -> bool {
        self.has_null || self.has_undefined
    }

    pub(super) fn is_any_or_unknown(&self) -> bool {
        self.has_any || self.has_unknown
    }

    pub(super) fn has_both_null_and_undefined(&self) -> bool {
        self.has_null && self.has_undefined
    }

    pub(super) fn has_no_nullable_types(&self) -> bool {
        !self.is_nullish()
    }

    pub(super) fn can_be_undefined_like(&self) -> bool {
        self.parts.is_empty()
            || self.has_undefined
            || self.has_void
            || self.has_any
            || self.has_unknown
    }

    pub(super) fn can_be_nullish_like(&self) -> bool {
        self.can_be_undefined_like() || self.has_null
    }

    fn all_parts(&self, checker: &Checker, predicate: impl Fn(&Checker, TypeId) -> bool) -> bool {
        !self.parts.is_empty()
            && !self.is_any_or_unknown()
            && self.parts.iter().all(|&part| predicate(checker, part))
    }

    pub(super) fn is_always_undefined_like(&self, checker: &Checker) -> bool {
        self.all_parts(checker, |c, part| {
            is_type_undefined_type(c, part) || is_type_void_type(c, part)
        })
    }

    pub(super) fn is_always_nullish_like(&self, checker: &Checker) -> bool {
        self.all_parts(checker, |c, part| {
            is_type_null_type(c, part)
                || is_type_undefined_type(c, part)
                || is_type_void_type(c, part)
        })
    }
}

impl Processor<'_, '_, '_> {
    pub(super) fn type_info(&mut self, node: Node) -> Rc<TypeInfo> {
        if let Some(info) = self.state.type_cache.get(&node) {
            return info.clone();
        }
        let t = self.ctx.checker.get_type_at_location(node);
        let info = Rc::new(TypeInfo::of(self.ctx.checker, t));
        self.state.type_cache.insert(node, info.clone());
        info
    }

    pub(super) fn includes_nullish(&mut self, node: Node) -> bool {
        self.type_info(node).is_nullish()
    }

    pub(super) fn type_is_any_or_unknown(&mut self, node: Node) -> bool {
        let info = self.type_info(node);
        !info.parts.is_empty()
            && info
                .parts
                .iter()
                .all(|&part| is_type_flag_set(self.ctx.checker, part, TypeFlags::ANY_OR_UNKNOWN))
    }

    /// Any boolean, number, string or bigint literal type, with no null or
    /// undefined: one of them can be falsy, which the `&&` returns and an
    /// optional chain would not.
    pub(super) fn would_change_return_type(&mut self, node: Node) -> bool {
        let info = self.type_info(node);
        let has_literal = info.has_bool_literal
            || info.has_num_literal
            || info.has_str_literal
            || info.has_big_int_literal;
        has_literal && !info.has_explicit_nullish()
    }

    /// `false`, `""`, `0` or `0n` among the (intersected) union members.
    pub(super) fn has_falsy_literal_type(&mut self, node: Node) -> bool {
        let info = self.type_info(node);
        let checker = &*self.ctx.checker;
        info.parts.iter().any(|&union_part| {
            intersection_type_parts(checker, union_part)
                .iter()
                .any(|&part| is_falsy_literal(checker, part))
        })
    }

    /// `void` is falsy but not nullish: `x?.()` on void throws.
    pub(super) fn has_void_type(&mut self, node: Node) -> bool {
        self.type_info(node).has_void
    }
}

fn is_falsy_literal(checker: &Checker, part: TypeId) -> bool {
    let flags = checker.ty(part).flags;
    if flags.intersects(TypeFlags::BOOLEAN_LITERAL) {
        boolean_literal_value(checker, part) == Some(false)
    } else if flags.intersects(TypeFlags::STRING_LITERAL) {
        matches!(
            literal_type_value(checker, part),
            Some(LiteralValue::String(s)) if s.is_empty()
        )
    } else if flags.intersects(TypeFlags::NUMBER_LITERAL | TypeFlags::BIG_INT_LITERAL) {
        let value = checker.ty(part).as_literal_type().string();
        value == "0" || value == "0n"
    } else {
        false
    }
}
