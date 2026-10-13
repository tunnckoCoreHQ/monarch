//! Ports of typescript-eslint's type utilities (tsgolint `ts_eslint.go`).

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ContextFlags, SymbolFlags, TypeFlags};
use rustc_hash::{FxHashMap, FxHashSet};

use super::nodes::get_this_expression;
use super::types::{
    is_intersection_type, is_symbol_flag_set, is_thenable_type, is_type_any_type, is_type_flag_set,
    is_type_parameter, is_type_unknown_type, is_union_type, type_recurser, union_type_parts,
};

/// What typescript-eslint's `getConstraintInfo` finds for a type.
#[derive(Clone, Copy)]
pub enum ConstraintInfo {
    /// Not a type parameter: the type itself.
    Type(TypeId),
    /// A type parameter with this base constraint.
    Constrained(TypeId),
    /// A type parameter without a constraint.
    Unconstrained,
}

impl ConstraintInfo {
    /// The type itself or the base constraint; None when unconstrained.
    pub fn constraint(self) -> Option<TypeId> {
        match self {
            Self::Type(t) | Self::Constrained(t) => Some(t),
            Self::Unconstrained => None,
        }
    }
}

/// typescript-eslint `getConstraintInfo`.
pub fn get_constraint_info(c: &mut Checker, t: TypeId) -> ConstraintInfo {
    if !c.ty(t).flags.intersects(TypeFlags::TYPE_PARAMETER) {
        return ConstraintInfo::Type(t);
    }
    let constraint = c.get_base_constraint_of_type(t);
    if constraint.is_nil() {
        ConstraintInfo::Unconstrained
    } else {
        ConstraintInfo::Constrained(constraint)
    }
}

/// Result of [`needs_to_be_awaited`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypeAwaitable {
    Always,
    Never,
    May,
}

/// typescript-eslint `needsToBeAwaited`.
pub fn needs_to_be_awaited(c: &mut Checker, node: Node, t: TypeId) -> TypeAwaitable {
    // An unconstrained type parameter is treated as unknown.
    let Some(constraint) = get_constraint_info(c, t).constraint() else {
        return TypeAwaitable::May;
    };
    if is_type_any_type(c, constraint) || is_type_unknown_type(c, constraint) {
        return TypeAwaitable::May;
    }
    // `is_thenable_type` reads a nil type as the type of `node`.
    if is_thenable_type(c, node, constraint) {
        return TypeAwaitable::Always;
    }
    TypeAwaitable::Never
}

/// typescript-eslint `getConstrainedTypeAtLocation`: the type of `node`, or
/// its base constraint when it has one.
pub fn get_constrained_type_at_location(c: &mut Checker, node: Node) -> TypeId {
    let node_type = c.get_type_at_location(node);
    let constraint = c.get_base_constraint_of_type(node_type);
    if constraint.is_some() {
        constraint
    } else {
        node_type
    }
}

/// The `this` at the root of `node` ([`get_this_expression`]) when its
/// constrained type is `any`, with that type (tsgolint's implicit-`this`
/// checks).
pub fn any_typed_this_expression(c: &mut Checker, node: Node) -> Option<(Node, TypeId)> {
    let this_expression = get_this_expression(node);
    if this_expression.is_nil() {
        return None;
    }
    let this_type = get_constrained_type_at_location(c, this_expression);
    is_type_any_type(c, this_type).then_some((this_expression, this_type))
}

/// typescript-eslint `getTypeName`: `"string"` for string-like types (and
/// type parameters, unions and intersections built from them), else the
/// type string.
pub fn get_type_name(c: &mut Checker, t: TypeId) -> String {
    if c.ty(t).flags.intersects(TypeFlags::STRING_LIKE) {
        return "string".to_owned();
    }

    // The constraint comes from the declaration, as in typescript-eslint.
    if is_type_parameter(c, t) {
        let symbol = c.ty(t).symbol;
        let declaration = if symbol.is_some() {
            c.sym(symbol).declarations.first().copied()
        } else {
            None
        };
        if let Some(declaration) = declaration
            && ast::is_type_parameter_declaration(declaration)
        {
            let constraint = declaration.constraint();
            if constraint.is_some() {
                let constraint_type = c.get_type_from_type_node(constraint);
                return get_type_name(c, constraint_type);
            }
        }
    }

    // `"a" | "b"` is a string; `string | string[]` is not.
    if is_union_type(c, t) {
        let parts = c.ty(t).types_list();
        if parts
            .into_iter()
            .all(|part| get_type_name(c, part) == "string")
        {
            return "string".to_owned();
        }
    }

    // `string & { __brand: void }` is a string.
    if is_intersection_type(c, t) {
        let parts = c.ty(t).types_list();
        if parts
            .into_iter()
            .any(|part| get_type_name(c, part) == "string")
        {
            return "string".to_owned();
        }
    }

    c.type_to_string_exported(t)
}

const ARRAY_PREDICATE_FUNCTIONS: [&str; 7] = [
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
];

/// typescript-eslint `isArrayMethodCallWithPredicate`: a call such as
/// `arr.filter(...)` on an array or tuple (or a union of them).
pub fn is_array_method_call_with_predicate(c: &mut Checker, call: Node) -> bool {
    let callee = call.expression();
    if !ast::is_access_expression(callee) {
        return false;
    }
    let (property_name, ok) = c.get_accessed_property_name(callee);
    if !ok || !ARRAY_PREDICATE_FUNCTIONS.contains(&property_name.as_str()) {
        return false;
    }
    let t = get_constrained_type_at_location(c, callee.expression());
    type_recurser(c, t, |c, t| c.is_array_or_tuple_type(t))
}

/// typescript-eslint `getDeclaration`: the first declaration of the symbol
/// at `node`, or nil.
pub fn get_declaration(c: &mut Checker, node: Node) -> Node {
    let symbol = c.get_symbol_at_location_exported(node);
    if symbol.is_nil() {
        return Node::NIL;
    }
    c.sym(symbol)
        .declarations
        .first()
        .copied()
        .unwrap_or(Node::NIL)
}

/// typescript-eslint `isTypeAnyArrayType`: `any[]` (or `readonly any[]`).
pub fn is_type_any_array_type(c: &mut Checker, t: TypeId) -> bool {
    c.is_array_type(t) && {
        let element = c.get_type_arguments(t)[0];
        is_type_any_type(c, element)
    }
}

/// typescript-eslint `isTypeUnknownArrayType`: `unknown[]` (or
/// `readonly unknown[]`).
pub fn is_type_unknown_array_type(c: &mut Checker, t: TypeId) -> bool {
    c.is_array_type(t) && {
        let element = c.get_type_arguments(t)[0];
        is_type_unknown_type(c, element)
    }
}

/// The two types of an unsafe assignment found by [`is_unsafe_assignment`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnsafeAssignment {
    pub receiver: TypeId,
    pub sender: TypeId,
}

/// typescript-eslint `isUnsafeAssignment`: an `any` assigned to a type that
/// is not `any` or `unknown`, also inside the type arguments of two
/// references to the same generic type. `None` when it is safe.
///
/// `sender_node` (may be nil) lets `new Map()` (typed `Map<any, any>`)
/// through.
pub fn is_unsafe_assignment(
    c: &mut Checker,
    t: TypeId,
    receiver: TypeId,
    sender_node: Node,
) -> Option<UnsafeAssignment> {
    let mut visited = FxHashMap::default();
    is_unsafe_assignment_worker(c, t, receiver, sender_node, &mut visited)
}

fn is_unsafe_assignment_worker(
    c: &mut Checker,
    t: TypeId,
    receiver: TypeId,
    sender_node: Node,
    visited: &mut FxHashMap<TypeId, FxHashSet<TypeId>>,
) -> Option<UnsafeAssignment> {
    if is_type_any_type(c, t) {
        // `any` to `unknown` is allowed.
        if is_type_unknown_type(c, receiver) {
            return None;
        }
        if !is_type_any_type(c, receiver) {
            return Some(UnsafeAssignment {
                receiver,
                sender: t,
            });
        }
    }

    if !visited.entry(t).or_default().insert(receiver) {
        return None;
    }

    // Go reads both types unchecked; a nil type cannot be a reference here.
    if t.is_nil()
        || receiver.is_nil()
        || !c.is_non_deferred_type_reference(t)
        || !c.is_non_deferred_type_reference(receiver)
    {
        return None;
    }

    // References to different generic types: their type arguments do not
    // correspond, so assume safe.
    if c.ty(t).target() != c.ty(receiver).target() {
        return None;
    }

    if sender_node.is_some()
        && ast::is_new_expression(sender_node)
        && ast::is_identifier(sender_node.expression())
        && sender_node.expression().text() == "Map"
        && sender_node.arguments().is_empty()
        && sender_node.type_argument_list().is_nil()
    {
        // `new Map()` is typed `Map<any, any>`.
        return None;
    }

    let type_arguments = c.get_type_arguments(t);
    let receiver_type_arguments = c.get_type_arguments(receiver);
    for (i, arg) in type_arguments.into_iter().enumerate() {
        let receiver_arg = receiver_type_arguments[i];
        if is_unsafe_assignment_worker(c, arg, receiver_arg, sender_node, visited).is_some() {
            return Some(UnsafeAssignment {
                receiver,
                sender: t,
            });
        }
    }
    None
}

/// typescript-eslint `getContextualType`: the type that `node` flows into
/// (a parameter, a declared variable type, an assignment target, ...), or
/// nil.
pub fn get_contextual_type(c: &mut Checker, node: Node) -> TypeId {
    let parent = node.parent();

    if ast::is_call_expression(parent) || ast::is_new_expression(parent) {
        if node == parent.expression() {
            // The callee has no contextual type.
            return TypeId::NIL;
        }
    } else if ast::is_variable_declaration(parent)
        || ast::is_property_declaration(parent)
        || ast::is_parameter_declaration(parent)
    {
        let type_node = parent.type_();
        if type_node.is_some() {
            return c.get_type_from_type_node(type_node);
        }
        return TypeId::NIL;
    } else if parent.kind() == SyntaxKind::JsxExpression {
        return c.get_contextual_type(parent, ContextFlags::NONE);
    } else if ast::is_identifier(node)
        && (ast::is_property_assignment(parent) || ast::is_shorthand_property_assignment(parent))
    {
        return c.get_contextual_type(node, ContextFlags::NONE);
    } else if ast::is_binary_expression(parent)
        && parent.operator_token().kind() == SyntaxKind::EqualsToken
        && parent.right() == node
    {
        // The right side of an assignment.
        return c.get_type_at_location(parent.left());
    } else if !ast::is_template_span(parent) {
        return TypeId::NIL;
    }

    c.get_contextual_type(node, ContextFlags::NONE)
}

/// For an enum member type, the type of its enum; else `t`.
fn get_base_enum_type(c: &mut Checker, t: TypeId) -> TypeId {
    let symbol = c.ty(t).symbol;
    if !is_symbol_flag_set(c, symbol, SymbolFlags::ENUM_MEMBER) {
        return t;
    }
    let enum_declaration = c.sym(symbol).value_declaration.parent();
    c.get_type_at_location(enum_declaration)
}

/// typescript-eslint `getEnumLiterals`: the enum literal members of `t`.
pub fn get_enum_literals(c: &Checker, t: TypeId) -> Vec<TypeId> {
    union_type_parts(c, t)
        .into_iter()
        .filter(|&part| is_type_flag_set(c, part, TypeFlags::ENUM_LITERAL))
        .collect()
}

/// typescript-eslint `getEnumTypes`: the enum of each enum literal member
/// of `t` (one entry per member, duplicates kept).
pub fn get_enum_types(c: &mut Checker, t: TypeId) -> Vec<TypeId> {
    get_enum_literals(c, t)
        .into_iter()
        .map(|literal| get_base_enum_type(c, literal))
        .collect()
}

/// Result of [`discriminate_any_type`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscriminatedAnyType {
    Any,
    PromiseAny,
    AnyArray,
    Safe,
}

/// typescript-eslint `discriminateAnyType`: `any`, `any[]`, a thenable of
/// `any` (also inside unions and intersections), or safe.
pub fn discriminate_any_type(c: &mut Checker, t: TypeId, node: Node) -> DiscriminatedAnyType {
    let mut visited = FxHashSet::default();
    discriminate_any_type_worker(c, t, node, &mut visited)
}

fn discriminate_any_type_worker(
    c: &mut Checker,
    t: TypeId,
    node: Node,
    visited: &mut FxHashSet<TypeId>,
) -> DiscriminatedAnyType {
    if !visited.insert(t) {
        return DiscriminatedAnyType::Safe;
    }
    if is_type_any_type(c, t) {
        return DiscriminatedAnyType::Any;
    }
    if is_type_any_array_type(c, t) {
        return DiscriminatedAnyType::AnyArray;
    }
    let found_promise_any = type_recurser(c, t, |c, part| {
        if !is_thenable_type(c, node, part) {
            return false;
        }
        let awaited = c.get_awaited_type(part);
        awaited.is_some()
            && discriminate_any_type_worker(c, awaited, node, visited) == DiscriminatedAnyType::Any
    });
    if found_promise_any {
        DiscriminatedAnyType::PromiseAny
    } else {
        DiscriminatedAnyType::Safe
    }
}
