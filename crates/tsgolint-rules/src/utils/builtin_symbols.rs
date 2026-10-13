//! "Is this type a built-in X, or a subtype of one?" (tsgolint
//! `builtin_symbol_likes.go`, a port of typescript-eslint's
//! `isBuiltinSymbolLike` family).
//!
//! These read the current program of the thread (`goport_core::program`),
//! which is the program of the checker on checker threads.

use goport_core::ast::{get_source_file_of_node, source_file_file_name, source_file_info};
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::SymbolFlags;
use goport_core::frontend::bundled;
use goport_core::frontend::tsoptions::{get_default_lib_file_name, get_lib_file_name};
use goport_core::frontend::tspath::{ComparePathsOptions, combine_paths, compare_paths};
use goport_core::program;

use super::types::{
    intersection_type_parts, is_intersection_type, is_type_parameter, is_union_type,
    union_type_parts,
};

/// Whether `file` is a default library file (`lib.*.d.ts`) of the program:
/// the program loaded it as one, or it is the lib file that the `target` or
/// `lib` options name.
pub fn is_source_file_default_library(file: Node) -> bool {
    let info = source_file_info(file);
    if !info.is_declaration_file {
        return false;
    }
    if program::is_source_file_default_library(&info.path) {
        return true;
    }

    let options = program::options();
    if options.no_lib.is_true() {
        return false;
    }

    let lib_path = bundled::lib_path();
    let libs: Vec<String> = match &options.lib {
        None => vec![combine_paths(
            &lib_path,
            &[&get_default_lib_file_name(options)],
        )],
        Some(lib) => lib
            .iter()
            .filter_map(|name| {
                let (file_name, ok) = get_lib_file_name(name);
                ok.then(|| combine_paths(&lib_path, &[&file_name]))
            })
            .collect(),
    };

    let compare_options = ComparePathsOptions {
        use_case_sensitive_file_names: program::use_case_sensitive_file_names(),
        current_directory: program::get_current_directory().to_owned(),
    };
    let file_name = source_file_file_name(file);
    libs.iter()
        .any(|lib| compare_paths(file_name, lib, &compare_options) == 0)
}

/// Whether a declaration of `symbol` is in a default library file. False for
/// a nil symbol.
fn is_symbol_from_default_library(c: &Checker, symbol: SymbolId) -> bool {
    symbol.is_some()
        && c.sym(symbol).declarations.iter().any(|&declaration| {
            is_source_file_default_library(get_source_file_of_node(declaration))
        })
}

/// `Promise`, or a class or interface that extends it.
pub fn is_promise_like(c: &mut Checker, t: TypeId) -> bool {
    is_builtin_symbol_like(c, t, &["Promise"])
}

/// `PromiseConstructor` (the type of the `Promise` value), or a subtype.
pub fn is_promise_constructor_like(c: &mut Checker, t: TypeId) -> bool {
    is_builtin_symbol_like(c, t, &["PromiseConstructor"])
}

/// `Error`, or a class or interface that extends it.
pub fn is_error_like(c: &mut Checker, t: TypeId) -> bool {
    is_builtin_symbol_like(c, t, &["Error"])
}

/// `Readonly<E>` where `E` is error-like (or itself a readonly error).
pub fn is_readonly_error_like(c: &mut Checker, t: TypeId) -> bool {
    is_readonly_type_like(c, t, |c, subtype| {
        let argument = c
            .ty(subtype)
            .alias
            .as_ref()
            .expect("alias checked")
            .type_arguments[0];
        is_error_like(c, argument) || is_readonly_error_like(c, argument)
    })
}

/// The lib's `Readonly<T>` alias for which `predicate` holds.
fn is_readonly_type_like(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    is_builtin_type_alias_like(c, t, |c, subtype| {
        let alias_symbol = c.ty(subtype).alias.as_ref().expect("alias checked").symbol;
        c.sym(alias_symbol).name.as_str() == "Readonly" && predicate(c, subtype)
    })
}

/// The answer of a [`is_builtin_symbol_like_recurser`] predicate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinPredicateMatches {
    /// Not decided: try the base types.
    Unknown,
    False,
    True,
}

/// A generic type alias from the default library, with type arguments, for
/// which `predicate` holds.
fn is_builtin_type_alias_like(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> bool,
) -> bool {
    is_builtin_symbol_like_recurser(c, t, |c, subtype| {
        let alias_symbol = match &c.ty(subtype).alias {
            Some(alias) if !alias.type_arguments.is_empty() => alias.symbol,
            _ => return BuiltinPredicateMatches::False,
        };
        if is_symbol_from_default_library(c, alias_symbol) && predicate(c, subtype) {
            BuiltinPredicateMatches::True
        } else {
            BuiltinPredicateMatches::Unknown
        }
    })
}

/// typescript-eslint `isBuiltinSymbolLike`: a type whose symbol has one of
/// `symbol_names` and comes from the default library, or a subtype of one.
pub fn is_builtin_symbol_like(c: &mut Checker, t: TypeId, symbol_names: &[&str]) -> bool {
    is_builtin_symbol_like_recurser(c, t, |c, subtype| {
        let symbol = c.ty(subtype).symbol;
        if symbol.is_nil() {
            return BuiltinPredicateMatches::False;
        }
        let name = c.sym(symbol).name.as_str();
        if symbol_names.contains(&name) && is_symbol_from_default_library(c, symbol) {
            BuiltinPredicateMatches::True
        } else {
            BuiltinPredicateMatches::Unknown
        }
    })
}

/// A type whose symbol comes from the default library, or a subtype of one.
pub fn is_any_builtin_symbol_like(c: &mut Checker, t: TypeId) -> bool {
    is_builtin_symbol_like_recurser(c, t, |c, subtype| {
        let symbol = c.ty(subtype).symbol;
        if symbol.is_nil() {
            BuiltinPredicateMatches::False
        } else if is_symbol_from_default_library(c, symbol) {
            BuiltinPredicateMatches::True
        } else {
            BuiltinPredicateMatches::Unknown
        }
    })
}

/// typescript-eslint `isBuiltinSymbolLikeRecurser`: some member of an
/// intersection, every member of a union, the base constraint of a type
/// parameter, else `predicate`, and on `Unknown` the base types of the
/// type's class or interface.
fn is_builtin_symbol_like_recurser(
    c: &mut Checker,
    t: TypeId,
    mut predicate: impl FnMut(&mut Checker, TypeId) -> BuiltinPredicateMatches,
) -> bool {
    recurser_worker(c, t, &mut predicate)
}

fn recurser_worker<F>(c: &mut Checker, t: TypeId, predicate: &mut F) -> bool
where
    F: FnMut(&mut Checker, TypeId) -> BuiltinPredicateMatches,
{
    if is_intersection_type(c, t) {
        return intersection_type_parts(c, t)
            .into_iter()
            .any(|part| recurser_worker(c, part, predicate));
    }
    if is_union_type(c, t) {
        return union_type_parts(c, t)
            .into_iter()
            .all(|part| recurser_worker(c, part, predicate));
    }
    if is_type_parameter(c, t) {
        let constraint = c.get_base_constraint_of_type(t);
        return constraint.is_some() && recurser_worker(c, constraint, predicate);
    }

    match predicate(c, t) {
        BuiltinPredicateMatches::True => return true,
        BuiltinPredicateMatches::False => return false,
        BuiltinPredicateMatches::Unknown => {}
    }

    let symbol = c.ty(t).symbol;
    if symbol.is_nil()
        || !c
            .sym(symbol)
            .flags
            .intersects(SymbolFlags::CLASS | SymbolFlags::INTERFACE)
    {
        return false;
    }
    let declared_type = c.get_declared_type_of_symbol(symbol);
    c.get_base_types(declared_type)
        .into_iter()
        .any(|base| recurser_worker(c, base, predicate))
}
