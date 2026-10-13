//! `no-unnecessary-type-assertion`: disallows type assertions and non-null
//! assertions that do not change the type of an expression.
//!
//! typescript-go keeps parentheses as nodes; lookups of expressions and
//! parents skip them to match ESTree.

mod fixes;
mod narrowing;

use std::collections::{HashMap, HashSet};

use goport_core::ast::{TextRange, source_file_text, walk_up_parenthesized_expressions};
use goport_core::ast::{
    get_enclosing_block_scope_container, is_access_expression, is_array_literal_expression,
    is_arrow_function, is_as_expression, is_assignment_expression, is_await_expression,
    is_binary_expression, is_binding_pattern, is_call_expression, is_class_expression,
    is_element_access_expression, is_function_expression, is_identifier, is_intersection_type_node,
    is_jsx_element, is_jsx_fragment, is_jsx_self_closing_element, is_logical_expression,
    is_logical_or_coalescing_assignment_operator, is_new_expression, is_object_literal_expression,
    is_parameter_declaration, is_parenthesized_expression, is_property_assignment,
    is_property_declaration, is_satisfies_expression, is_string_literal,
    is_tagged_template_expression, is_template_expression, is_type_assertion,
    is_type_reference_node, is_variable_declaration, is_variable_declaration_list,
    is_variable_statement, is_write_access, skip_parentheses, skip_type_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, TypeAliasExt};
use goport_core::core::{Node, SignatureId, SymbolId, TypeId};
use goport_core::flags::{
    CheckMode, ContextFlags, ModifierFlags, NodeFlags, ObjectFlags, SignatureKind, TypeFlags,
};
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    decode_options,
};

use crate::utils::{
    get_call_signatures, get_constrained_type_at_location, get_construct_signatures,
    get_contextual_type, get_declaration, get_number_index_type, includes_modifier,
    is_intersection_type, is_type_any_type, is_type_flag_set, is_type_parameter,
    is_type_unknown_type, is_union_type, union_type_parts,
};

use self::fixes::{assertion_fixes, assertion_range};
use self::narrowing::is_in_narrowing_assignment;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-type-assertion",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    check_literal_const_assertions: bool,
    types_to_ignore: Vec<String>,
}

struct State {
    options: Options,
    strict_null_checks: bool,
    exact_optional_property_types: bool,
    no_unchecked_indexed_access: bool,
}

/// Why an assertion is reported.
#[derive(Clone, Copy)]
enum Unnecessary {
    /// The assertion does not change the type.
    Assertion,
    /// The receiver accepts the type without the assertion.
    Contextually,
}

impl Unnecessary {
    fn message(self) -> RuleMessage {
        match self {
            Self::Assertion => RuleMessage::new(
                "unnecessaryAssertion",
                "This assertion is unnecessary since it does not change the type of the expression.",
            ),
            Self::Contextually => RuleMessage::new(
                "contextuallyUnnecessary",
                "This assertion is unnecessary since the receiver accepts the original type of the expression.",
            ),
        }
    }
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let compiler_options = ctx.compiler_options();
    let state = State {
        options,
        strict_null_checks: compiler_options
            .get_strict_option_value(compiler_options.strict_null_checks),
        exact_optional_property_types: compiler_options.exact_optional_property_types.is_true(),
        no_unchecked_indexed_access: compiler_options.no_unchecked_indexed_access.is_true(),
    };
    Listeners::new(state)
        .on(SyntaxKind::AsExpression, check_type_assertion)
        .on(SyntaxKind::TypeAssertionExpression, check_type_assertion)
        .on(SyntaxKind::NonNullExpression, check_non_null_assertion)
        .into()
}

fn report_with_assertion_fixes(ctx: &mut RuleContext<'_>, node: Node, kind: Unnecessary) {
    let report = Report::new(assertion_range(ctx.source_file, node), kind.message());
    ctx.report_diagnostic_with_fixes(report, |ctx| assertion_fixes(ctx.source_file, node));
}

// ---------------------------------------------------------------------------
// Syntax helpers

fn is_const_assertion(node: Node) -> bool {
    if !is_type_reference_node(node) {
        return false;
    }
    let type_name = node.type_name();
    is_identifier(type_name) && type_name.text() == "const"
}

/// A literal assertion in a `const` declaration or a `readonly` property,
/// where the literal type is inferred anyway.
fn is_implicitly_narrowed_literal_declaration(node: Node) -> bool {
    let expression = skip_parentheses(node.expression());
    let parent = walk_up_parenthesized_expressions(node.parent());
    // Template literals with expressions can be widened even in `const`
    // declarations (typescript-eslint#8737).
    if is_template_expression(expression) {
        return false;
    }
    (is_variable_declaration(parent)
        && is_variable_declaration_list(parent.parent())
        && parent.parent().flags().intersects(NodeFlags::CONST))
        || (is_property_declaration(parent)
            && parent.modifier_flags().intersects(ModifierFlags::READONLY))
}

fn is_conceptually_literal(node: Node) -> bool {
    let node = skip_parentheses(node);
    is_array_literal_expression(node)
        || is_object_literal_expression(node)
        || is_class_expression(node)
        || is_function_expression(node)
        || is_arrow_function(node)
        || is_jsx_element(node)
        || is_jsx_self_closing_element(node)
        || is_jsx_fragment(node)
        || is_string_literal(node)
        || matches!(
            node.kind(),
            SyntaxKind::NumericLiteral
                | SyntaxKind::BigIntLiteral
                | SyntaxKind::RegularExpressionLiteral
                | SyntaxKind::NoSubstitutionTemplateLiteral
                | SyntaxKind::TrueKeyword
                | SyntaxKind::FalseKeyword
                | SyntaxKind::NullKeyword
        )
        || is_template_expression(node)
}

/// The assertion is inside an access expression that is written to.
fn is_receiver_of_write_access(node: Node) -> bool {
    let mut current = walk_up_parenthesized_expressions(node.parent());
    while current.is_some() && is_access_expression(current) {
        if is_write_access(current) {
            return true;
        }
        current = walk_up_parenthesized_expressions(current.parent());
    }
    false
}

fn is_element_access_argument(node: Node) -> bool {
    let mut current = node;
    let mut parent = current.parent();
    while parent.is_some() && is_parenthesized_expression(parent) {
        current = parent;
        parent = parent.parent();
    }
    parent.is_some()
        && is_element_access_expression(parent)
        && parent.argument_expression() == current
}

fn is_iife(expression: Node) -> bool {
    let expression = skip_parentheses(expression);
    if !is_call_expression(expression) {
        return false;
    }
    let callee = skip_parentheses(expression.expression());
    is_arrow_function(callee) || is_function_expression(callee)
}

fn is_context_sensitive_call_like_expression(expression: Node) -> bool {
    if is_call_expression(expression)
        || is_new_expression(expression)
        || is_tagged_template_expression(expression)
    {
        return true;
    }
    is_await_expression(expression)
        && is_context_sensitive_call_like_expression(skip_parentheses(expression.expression()))
}

/// The expression under all nested assertions.
fn original_expression(node: Node) -> Node {
    let mut current = skip_parentheses(node.expression());
    while is_as_expression(current) || is_type_assertion(current) {
        current = skip_parentheses(current.expression());
    }
    current
}

/// The index of the assertion among the arguments of its parent call or
/// `new`.
fn argument_index_in_parent_call(node: Node) -> Option<usize> {
    let parent = walk_up_parenthesized_expressions(node.parent());
    if parent.is_nil() || (!is_call_expression(parent) && !is_new_expression(parent)) {
        return None;
    }
    parent
        .arguments()
        .iter()
        .position(|argument| argument == node || skip_parentheses(argument) == node)
}

fn is_in_destructuring_declaration(node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    is_variable_declaration(parent)
        && skip_parentheses(parent.initializer()) == node
        && parent.name().is_some()
        && is_binding_pattern(parent.name())
}

fn is_assignment_in_non_statement_context(node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    if parent.is_nil()
        || !is_assignment_expression(parent, false)
        || skip_parentheses(parent.right()) != node
    {
        return false;
    }
    let grandparent = walk_up_parenthesized_expressions(parent.parent());
    grandparent.is_nil() || grandparent.kind() != SyntaxKind::ExpressionStatement
}

fn is_right_hand_side_of_logical_assignment(node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    parent.is_some()
        && is_binary_expression(parent)
        && skip_parentheses(parent.right()) == node
        && is_logical_or_coalescing_assignment_operator(parent.operator_token().kind())
}

fn is_skip_parent_type(node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    parent.is_some()
        && (is_as_expression(parent)
            || is_type_assertion(parent)
            || parent.kind() == SyntaxKind::SpreadElement
            || parent.kind() == SyntaxKind::SpreadAssignment
            || is_satisfies_expression(parent))
}

fn is_spread_parameter(c: &Checker, parameter: SymbolId) -> bool {
    let declaration = c.sym(parameter).value_declaration;
    declaration.is_some()
        && is_parameter_declaration(declaration)
        && declaration.dot_dot_dot_token().is_some()
}

fn original_signature(c: &Checker, mut signature: SignatureId) -> SignatureId {
    while c.sig(signature).target.is_some() {
        signature = c.sig(signature).target;
    }
    signature
}

fn has_type_parameters(c: &Checker, signature: SignatureId) -> bool {
    !c.sig(signature).type_parameters().is_empty()
}

// ---------------------------------------------------------------------------
// Type helpers

fn is_type_literal(c: &Checker, t: TypeId) -> bool {
    is_type_flag_set(
        c,
        t,
        TypeFlags::STRING_LITERAL
            | TypeFlags::NUMBER_LITERAL
            | TypeFlags::BIG_INT_LITERAL
            | TypeFlags::BOOLEAN_LITERAL,
    )
}

/// The alias type arguments of `t`, else its reference type arguments.
fn type_arguments(c: &mut Checker, t: TypeId) -> Vec<TypeId> {
    let alias_arguments = c.ty(t).alias.type_arguments();
    if !alias_arguments.is_empty() {
        return alias_arguments.to_vec();
    }
    if !c.ty(t).object_flags.intersects(ObjectFlags::REFERENCE) {
        return Vec::new();
    }
    c.get_type_arguments(t).to_vec()
}

fn has_direct_any(c: &Checker, t: TypeId, arguments: &[TypeId]) -> bool {
    is_type_any_type(c, t)
        || arguments
            .iter()
            .any(|&argument| is_type_any_type(c, argument))
}

fn type_contains(
    c: &mut Checker,
    t: TypeId,
    predicate: fn(&Checker, TypeId) -> bool,
    seen: &mut HashSet<TypeId>,
    active_signatures: &mut HashSet<SignatureId>,
) -> bool {
    if t.is_nil() || !seen.insert(t) {
        return false;
    }
    if predicate(c, t) {
        return true;
    }
    if is_union_type(c, t) || is_intersection_type(c, t) {
        let parts = c.ty(t).types_list();
        return parts
            .iter()
            .any(|&part| type_contains(c, part, predicate, seen, active_signatures));
    }
    for argument in type_arguments(c, t) {
        if type_contains(c, argument, predicate, seen, active_signatures) {
            return true;
        }
    }
    for signature in get_call_signatures(c, t).iter().copied() {
        // Generic instantiations can make fresh recursive return types. When
        // their original target is already being walked, assume the
        // predicate holds somewhere in the cycle rather than risk a fix.
        let identity = original_signature(c, signature);
        if !active_signatures.insert(identity) {
            return true;
        }
        let parameters = c.sig(signature).parameters().to_vec();
        for parameter in parameters {
            let parameter_type = c.get_type_of_symbol(parameter);
            if type_contains(c, parameter_type, predicate, seen, active_signatures) {
                return true;
            }
        }
        let return_type = c.get_return_type_of_signature(signature);
        if type_contains(c, return_type, predicate, seen, active_signatures) {
            return true;
        }
        active_signatures.remove(&identity);
    }
    false
}

fn contains_any(c: &mut Checker, t: TypeId) -> bool {
    type_contains(
        c,
        t,
        |c, part| is_type_flag_set(c, part, TypeFlags::ANY),
        &mut HashSet::new(),
        &mut HashSet::new(),
    )
}

fn contains_type_variable(c: &mut Checker, t: TypeId) -> bool {
    type_contains(
        c,
        t,
        |c, part| is_type_flag_set(c, part, TypeFlags::TYPE_VARIABLE | TypeFlags::INDEX),
        &mut HashSet::new(),
        &mut HashSet::new(),
    )
}

fn has_index_signature(c: &mut Checker, t: TypeId) -> bool {
    union_type_parts(c, t)
        .iter()
        .any(|&part| !c.get_index_infos_of_type(part).is_empty())
}

fn has_same_properties(c: &mut Checker, uncast: TypeId, cast: TypeId) -> bool {
    let uncast_properties = c.get_properties_of_type(uncast);
    let cast_properties = c.get_properties_of_type(cast);
    if uncast_properties.len() != cast_properties.len() {
        return false;
    }
    let cast_by_name: HashMap<&str, SymbolId> = cast_properties
        .iter()
        .map(|&property| (c.sym(property).name.as_str(), property))
        .collect();
    let pairs: Option<Vec<(SymbolId, SymbolId)>> = uncast_properties
        .iter()
        .map(|&property| {
            cast_by_name
                .get(c.sym(property).name.as_str())
                .map(|&cast_property| (property, cast_property))
        })
        .collect();
    let Some(pairs) = pairs else {
        return false;
    };
    pairs.into_iter().all(|(property, cast_property)| {
        c.is_readonly_symbol(property) == c.is_readonly_symbol(cast_property)
    })
}

fn are_mutually_assignable(c: &mut Checker, a: TypeId, b: TypeId) -> bool {
    c.is_type_assignable_to(a, b) && c.is_type_assignable_to(b, a)
}

fn are_union_parts_equivalent_ignoring_undefined(
    c: &Checker,
    uncast: TypeId,
    cast: TypeId,
) -> bool {
    let uncast_parts: HashSet<TypeId> = union_type_parts(c, uncast)
        .iter()
        .copied()
        .filter(|&part| !is_type_flag_set(c, part, TypeFlags::UNDEFINED))
        .collect();
    let mut cast_parts_count = 0;
    for &part in union_type_parts(c, cast).iter() {
        if is_type_flag_set(c, part, TypeFlags::UNDEFINED) {
            continue;
        }
        if !uncast_parts.contains(&part) {
            return false;
        }
        cast_parts_count += 1;
    }
    uncast_parts.len() == cast_parts_count
}

fn is_empty_object_type(c: &mut Checker, t: TypeId) -> bool {
    is_type_flag_set(c, t, TypeFlags::NON_PRIMITIVE)
        || (c.get_properties_of_type(t).is_empty()
            && get_call_signatures(c, t).is_empty()
            && get_construct_signatures(c, t).is_empty()
            && c.get_index_infos_of_type(t).is_empty())
}

fn has_phantom_type_arguments(c: &mut Checker, t: TypeId) -> bool {
    is_empty_object_type(c, t) && !type_arguments(c, t).is_empty()
}

fn has_enum_type(c: &Checker, t: TypeId) -> bool {
    if is_type_flag_set(c, t, TypeFlags::ENUM_LIKE) {
        return true;
    }
    (is_union_type(c, t) || is_intersection_type(c, t))
        && c.ty(t).types().iter().any(|&part| has_enum_type(c, part))
}

fn is_nullable_for_non_null_assertion(c: &mut Checker, t: TypeId) -> bool {
    c.is_nullable_type(t)
        || union_type_parts(c, t)
            .iter()
            .any(|&part| is_type_flag_set(c, part, TypeFlags::ANY_OR_UNKNOWN | TypeFlags::VOID))
}

fn has_generic_call_signature(c: &mut Checker, t: TypeId) -> bool {
    get_call_signatures(c, t)
        .iter()
        .any(|&signature| has_type_parameters(c, signature))
}

/// Some property of `contextual` has a generic call signature that the
/// same property of `uncast` lacks.
fn generics_mismatch(c: &mut Checker, uncast: TypeId, contextual: TypeId) -> bool {
    let properties = c.get_properties_of_type(contextual);
    for &property in properties.iter() {
        let property_type = c.get_type_of_symbol(property);
        let contextual_signatures = c.get_signatures_of_type(property_type, SignatureKind::CALL);
        if !contextual_signatures
            .iter()
            .any(|&signature| has_type_parameters(c, signature))
        {
            continue;
        }
        let name = c.sym(property).name.clone();
        let uncast_property = c.get_property_of_type(uncast, &name);
        if uncast_property.is_nil() {
            return true;
        }
        let uncast_property_type = c.get_type_of_symbol(uncast_property);
        let uncast_signatures = c.get_signatures_of_type(uncast_property_type, SignatureKind::CALL);
        if !uncast_signatures
            .iter()
            .any(|&signature| has_type_parameters(c, signature))
        {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// The rule

impl State {
    /// Returns true if the variable may be used before it gets a value.
    fn is_possibly_used_before_assigned(&self, c: &mut Checker, node: Node) -> bool {
        let declaration = get_declaration(c, node);
        if declaration.is_nil() {
            // Unknown declaration: assume the worst.
            return true;
        }
        // Without strict null checks there are no used-before-assigned errors.
        if !self.strict_null_checks {
            return false;
        }
        // Class properties are guarded at compile time and parameters cannot
        // be used before they are defined.
        if !is_variable_declaration(declaration) {
            return false;
        }

        // A `var` may be used outside the block that declares it:
        // `if (a) { var x: number = 2; } else { x!.toFixed(); }`.
        let list = declaration.parent();
        if is_variable_declaration_list(list) && list.flags() == NodeFlags::NONE {
            let declarator_scope = get_enclosing_block_scope_container(declaration);
            let scope = get_enclosing_block_scope_container(node);
            let mut parent_scope = declarator_scope;
            loop {
                parent_scope = get_enclosing_block_scope_container(parent_scope);
                if parent_scope.is_nil() {
                    break;
                }
                if parent_scope == scope {
                    return true;
                }
            }
        }

        // `let x: number` without initializer or `!`.
        if declaration.initializer().is_nil()
            && declaration.exclamation_token().is_nil()
            && declaration.type_().is_some()
        {
            // The type has not changed since the declaration, so the
            // variable may be unassigned (microsoft/TypeScript#31124). A
            // `declare` is never narrowed, so it does not count.
            let declaration_type = c.get_type_from_type_node(declaration.type_());
            let t = get_constrained_type_at_location(c, node);
            let statement = list.parent();
            let is_declare = is_variable_declaration_list(list)
                && is_variable_statement(statement)
                && includes_modifier(statement, SyntaxKind::DeclareKeyword);
            if declaration_type == t && !is_declare {
                return true;
            }
        }
        false
    }

    fn is_type_unchanged(
        &self,
        c: &mut Checker,
        node: Node,
        expression: Node,
        uncast: TypeId,
        cast: TypeId,
    ) -> bool {
        let expression = skip_parentheses(expression);
        if uncast == cast {
            return true;
        }
        // Numeric enums and numbers are mutually assignable, but assertions
        // between them change the type, also inside unions and intersections.
        if (has_enum_type(c, uncast) || has_enum_type(c, cast))
            && !c.is_type_identical_to(uncast, cast)
        {
            return false;
        }
        if is_type_parameter(c, uncast) && is_receiver_of_write_access(node) {
            // Widening a generic write receiver can make the write legal.
            return false;
        }
        if self.no_unchecked_indexed_access && is_element_access_argument(node) {
            // The asserted key type can change the nullability of the access.
            return false;
        }

        let type_node = skip_type_parentheses(node.type_());
        if is_intersection_type_node(type_node) && contains_type_variable(c, cast) {
            return false;
        }

        if self.exact_optional_property_types
            && is_type_flag_set(c, uncast, TypeFlags::UNDEFINED)
            && is_type_flag_set(c, cast, TypeFlags::UNDEFINED)
        {
            return are_union_parts_equivalent_ignoring_undefined(c, uncast, cast);
        }

        if (is_type_flag_set(c, uncast, TypeFlags::NON_PRIMITIVE)
            && !is_type_flag_set(c, cast, TypeFlags::NON_PRIMITIVE))
            || has_index_signature(c, uncast) != has_index_signature(c, cast)
        {
            return false;
        }

        if is_conceptually_literal(expression)
            && (!is_object_literal_expression(expression)
                || expression.properties().is_empty()
                || c.get_properties_of_type(cast).iter().any(|&property| {
                    let property_type = c.get_type_of_symbol(property);
                    is_type_literal(c, property_type)
                }))
        {
            return false;
        }

        let uncast_arguments = type_arguments(c, uncast);
        let cast_arguments = type_arguments(c, cast);
        // Direct `any` is never reported and needs no recursive walk.
        if has_direct_any(c, uncast, &uncast_arguments) || has_direct_any(c, cast, &cast_arguments)
        {
            return false;
        }

        if is_intersection_type(c, cast) && !is_intersection_type(c, uncast) {
            if contains_any(c, uncast)
                || contains_any(c, cast)
                || (contains_type_variable(c, cast) && !contains_type_variable(c, uncast))
            {
                return false;
            }
            let cast_parts = c.ty(cast).types_list();
            let other_part = cast_parts.iter().copied().find(|&part| part != uncast);
            if is_type_parameter(c, uncast)
                && cast_parts.len() == 2
                && cast_parts.contains(&uncast)
                && let Some(other_part) = other_part
                && is_empty_object_type(c, other_part)
                && !contains_type_variable(c, other_part)
            {
                let constraint = c.get_base_constraint_of_type(uncast);
                return constraint.is_some() && !c.is_nullable_type(constraint);
            }
            return false;
        }

        // Compare shapes and assignability before the recursive walks:
        // incompatible callable types can have huge generic graphs.
        if !has_same_properties(c, uncast, cast)
            || uncast_arguments != cast_arguments
            || !are_mutually_assignable(c, uncast, cast)
        {
            return false;
        }

        !contains_any(c, uncast)
            && !contains_any(c, cast)
            && (!contains_type_variable(c, cast) || contains_type_variable(c, uncast))
    }
}

fn uncast_type(c: &mut Checker, node: Node) -> TypeId {
    let expression = skip_parentheses(node.expression());

    if is_iife(expression) {
        let callee = skip_parentheses(expression.expression());
        let function_type = c.get_type_at_location(callee);
        let signatures = c.get_call_signatures(function_type);
        if let Some(&first) = signatures.first() {
            let return_type = c.get_return_type_of_signature_exported(first);
            if callee.type_().is_nil() && is_type_flag_set(c, return_type, TypeFlags::UNDEFINED) {
                return c.get_void_type();
            }
            return return_type;
        }
    }

    // Use the context-free type of call-like expressions, so that the
    // assertion's own contextual type does not leak into generic inference.
    if is_context_sensitive_call_like_expression(expression) {
        let t = c.get_context_free_type_of_expression(expression);
        if t.is_some() {
            return t;
        }
    }

    c.get_type_at_location(expression)
}

fn has_generic_inference_parameter_at_argument(
    c: &mut Checker,
    call_or_new: Node,
    argument_index: usize,
    element_path: &[usize],
) -> bool {
    let signature = c.get_resolved_signature(call_or_new, None, CheckMode::NORMAL);
    if signature.is_nil() {
        return false;
    }
    let signature = original_signature(c, signature);
    if !has_type_parameters(c, signature) {
        return false;
    }
    let parameters = c.sig(signature).parameters().to_vec();
    if parameters.is_empty() {
        return false;
    }
    let parameter_index = argument_index.min(parameters.len() - 1);
    let parameter = parameters[parameter_index];
    let mut parameter_type = c.get_type_of_symbol(parameter);
    if is_spread_parameter(c, parameter) {
        let arguments = type_arguments(c, parameter_type);
        if !arguments.is_empty() {
            let index = if arguments.len() > 1 {
                (argument_index - parameter_index).min(arguments.len() - 1)
            } else {
                0
            };
            parameter_type = arguments[index];
        }
    }
    for &element_index in element_path {
        let element_type = if c.is_tuple_type(parameter_type) {
            let arguments = c.get_type_arguments(parameter_type);
            if arguments.is_empty() {
                TypeId::NIL
            } else {
                arguments[element_index.min(arguments.len() - 1)]
            }
        } else {
            get_number_index_type(c, parameter_type)
        };
        if element_type.is_nil() {
            break;
        }
        parameter_type = element_type;
    }
    contains_type_variable(c, parameter_type)
}

fn is_argument_to_overloaded_function(c: &mut Checker, node: Node) -> bool {
    let Some(argument_index) = argument_index_in_parent_call(node) else {
        return false;
    };
    let parent = walk_up_parenthesized_expressions(node.parent());
    let callee_type = c.get_type_at_location(parent.expression());
    let callee_type = c.get_non_nullable_type(callee_type);
    let signatures = c.get_call_signatures(callee_type);
    if signatures.len() <= 1 {
        return false;
    }

    let mut parameter_types = Vec::with_capacity(signatures.len());
    for signature in signatures {
        let parameters = c.sig(signature).parameters().to_vec();
        let Some(&parameter) = parameters.get(argument_index) else {
            return true;
        };
        let mut parameter_type = c.get_type_of_symbol(parameter);
        if is_spread_parameter(c, parameter) {
            let arguments = type_arguments(c, parameter_type);
            if let Some(&first) = arguments.first() {
                parameter_type = first;
            }
        }
        if parameter_type.is_nil() {
            return true;
        }
        parameter_types.push(parameter_type);
    }

    let first = parameter_types[0];
    if parameter_types.iter().any(|&t| t != first) {
        let uncast = c.get_type_at_location(node.expression());
        return parameter_types
            .into_iter()
            .any(|t| !c.is_type_assignable_to(uncast, t));
    }
    false
}

fn is_property_in_problematic_context(c: &mut Checker, node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    if parent.is_nil()
        || !is_property_assignment(parent)
        || skip_parentheses(parent.initializer()) != node
    {
        return false;
    }
    let object = parent.parent();
    if object.is_nil() || !is_object_literal_expression(object) {
        return false;
    }
    let object_contextual_type = c.get_contextual_type(object, ContextFlags::NONE);
    if object_contextual_type.is_some() && is_union_type(c, object_contextual_type) {
        let property_contextual_type = c.get_contextual_type(node, ContextFlags::NONE);
        if property_contextual_type.is_nil() {
            return true;
        }
        let non_nullable = c.get_non_nullable_type(property_contextual_type);
        if is_union_type(c, non_nullable) {
            return true;
        }
        let uncast = c.get_type_at_location(node.expression());
        return !c.is_type_assignable_to(uncast, non_nullable);
    }
    // Also keep assertions whose property context comes from another
    // assertion: typescript-go uses that context during inference.
    let object_parent = walk_up_parenthesized_expressions(object.parent());
    object_parent.is_some()
        && (is_as_expression(object_parent)
            || is_type_assertion(object_parent)
            || is_satisfies_expression(object_parent)
            || (is_call_expression(object_parent)
                && object_parent.parent().is_some()
                && is_satisfies_expression(object_parent.parent())))
}

/// Contextual acceptance does not keep inference for a generic parameter
/// inferred from an array element.
fn is_nested_in_array_literal_argument_to_generic_call(c: &mut Checker, node: Node) -> bool {
    let mut element_path: Vec<usize> = Vec::new();
    let mut child = node;
    let mut current = node.parent();
    while current.is_some() {
        let next = (current, current.parent());
        let result = 'step: {
            if is_function_expression(current) || is_arrow_function(current) {
                return false;
            }
            if !is_array_literal_expression(current) {
                break 'step None;
            }
            let Some(element_index) = current.elements().iter().position(|element| {
                element == child || skip_parentheses(element) == skip_parentheses(child)
            }) else {
                break 'step None;
            };
            element_path.insert(0, element_index);

            let mut call_argument = current;
            let mut parent = walk_up_parenthesized_expressions(call_argument.parent());
            let mut spread_offset = 0;
            if parent.is_some() && parent.kind() == SyntaxKind::SpreadElement {
                spread_offset = element_index;
                call_argument = parent;
                parent = walk_up_parenthesized_expressions(call_argument.parent());
            }
            if parent.is_nil() || (!is_call_expression(parent) && !is_new_expression(parent)) {
                break 'step None;
            }
            if parent.type_argument_list().is_some() {
                return false;
            }
            let Some(argument_index) = parent.arguments().iter().position(|candidate| {
                candidate == call_argument || skip_parentheses(candidate) == call_argument
            }) else {
                break 'step None;
            };
            let parameter_path = if call_argument.kind() == SyntaxKind::SpreadElement {
                &element_path[1..]
            } else {
                &element_path[..]
            };
            Some(has_generic_inference_parameter_at_argument(
                c,
                parent,
                argument_index + spread_offset,
                parameter_path,
            ))
        };
        if let Some(result) = result {
            return result;
        }
        (child, current) = next;
    }
    false
}

fn is_in_generic_context(c: &mut Checker, node: Node) -> bool {
    let mut seen_function = false;
    let mut current = node.parent();
    while current.is_some() {
        if current.kind() == SyntaxKind::FunctionDeclaration {
            return false;
        }
        if is_function_expression(current) || is_arrow_function(current) {
            let body = current.body();
            if body.is_some() && body.kind() == SyntaxKind::Block {
                return false;
            }
            if seen_function {
                return false;
            }
            seen_function = true;
        }
        if (is_call_expression(current) || is_new_expression(current))
            && current.type_argument_list().is_nil()
        {
            let is_argument_of_method_call = is_call_expression(current)
                && is_access_expression(current.expression())
                && current
                    .arguments()
                    .iter()
                    .any(|argument| skip_parentheses(argument) == node);
            if !is_argument_of_method_call {
                let callee_type = c.get_type_at_location(current.expression());
                if has_generic_call_signature(c, callee_type) {
                    return true;
                }
            }
        }
        current = current.parent();
    }
    false
}

/// The same inference dependency in the object returned by a callback.
fn is_property_in_inferred_callback_return(c: &mut Checker, node: Node) -> bool {
    let parent = walk_up_parenthesized_expressions(node.parent());
    if parent.is_nil()
        || !is_property_assignment(parent)
        || skip_parentheses(parent.initializer()) != node
    {
        return false;
    }
    let object = parent.parent();
    if object.is_nil() || !is_object_literal_expression(object) {
        return false;
    }
    let callback = walk_up_parenthesized_expressions(object.parent());
    callback.is_some()
        && is_arrow_function(callback)
        && skip_parentheses(callback.body()) == object
        && is_in_generic_context(c, node)
}

impl State {
    fn should_skip_contextual_type_fallback(
        &self,
        c: &mut Checker,
        node: Node,
        cast_is_any: bool,
        uncast: TypeId,
        cast: TypeId,
    ) -> bool {
        let parent = walk_up_parenthesized_expressions(node.parent());
        // An assignment can narrow the receiver for later statements, which
        // the original type being accepted does not make unnecessary.
        if is_in_narrowing_assignment(c, self.strict_null_checks, node, uncast, cast) {
            return true;
        }
        if cast_is_any {
            return (parent.is_some() && is_logical_expression(parent))
                || is_in_generic_context(c, node)
                || is_property_in_problematic_context(c, node);
        }

        // Interpolated templates can widen to string even when the context
        // accepts them (typescript-eslint#12276).
        let expression = skip_parentheses(node.expression());
        if is_template_expression(expression) {
            return true;
        }

        if is_skip_parent_type(node)
            || is_array_literal_expression(expression)
            || is_nested_in_array_literal_argument_to_generic_call(c, node)
            || is_in_destructuring_declaration(node)
            || is_property_in_problematic_context(c, node)
            || is_property_in_inferred_callback_return(c, node)
            || is_assignment_in_non_statement_context(node)
            || is_right_hand_side_of_logical_assignment(node)
            || is_argument_to_overloaded_function(c, node)
        {
            return true;
        }

        if is_in_generic_context(c, node) {
            return !is_conceptually_literal(original_expression(node))
                && (parent.is_nil() || !is_property_assignment(parent));
        }
        false
    }

    /// Why the outer assertion of `x as A as B` is unnecessary, if it is.
    fn double_assertion_kind(
        &self,
        c: &mut Checker,
        node: Node,
        contextual: TypeId,
    ) -> Option<Unnecessary> {
        let inner = skip_parentheses(node.expression());
        if !is_as_expression(inner) && !is_type_assertion(inner) {
            return None;
        }
        let original = original_expression(node);
        let original_type = c.get_type_at_location(original);
        let cast = c.get_type_at_location(node);

        let different_unrelated_type_parameters = original_type != cast
            && is_type_parameter(c, original_type)
            && is_type_parameter(c, cast)
            && !is_constrained_to(c, original_type, cast, &mut HashSet::new());

        if self.is_type_unchanged(c, node, inner, original_type, cast) && !is_type_any_type(c, cast)
        {
            return Some(Unnecessary::Assertion);
        }
        if contextual.is_some() && !different_unrelated_type_parameters {
            // Keep bridges between unrelated type parameters: typescript-go
            // can accept their contextual constraints but not a direct cast.
            let intermediate = c.get_type_at_location(inner);
            if (is_type_any_type(c, intermediate) || is_type_unknown_type(c, intermediate))
                && c.is_type_assignable_to(original_type, contextual)
            {
                return Some(Unnecessary::Contextually);
            }
        }
        None
    }
}

fn is_constrained_to(
    c: &mut Checker,
    source: TypeId,
    target: TypeId,
    seen: &mut HashSet<TypeId>,
) -> bool {
    if source == target {
        return true;
    }
    if source.is_nil() || !seen.insert(source) {
        return false;
    }
    if is_type_parameter(c, source) {
        let constraint = c.get_constraint_of_type_parameter_exported(source);
        return is_constrained_to(c, constraint, target, seen);
    }
    if is_intersection_type(c, source) {
        let parts = c.ty(source).types_list();
        return parts
            .iter()
            .any(|&part| is_constrained_to(c, part, target, seen));
    }
    false
}

fn report_double_assertion(ctx: &mut RuleContext<'_>, node: Node, kind: Unnecessary) {
    let report = Report::new(assertion_range(ctx.source_file, node), kind.message());
    ctx.report_diagnostic_with_fixes(report, |ctx| {
        let original = original_expression(node);
        let mut replacement = ctx.node_text(original);
        let parent = node.parent();
        if is_object_literal_expression(original)
            && parent.is_some()
            && is_arrow_function(parent)
            && parent.body() == node
        {
            replacement = format!("({replacement})");
        }
        vec![ctx.fix_replace(node, replacement)]
    });
}

fn check_type_assertion(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let type_node = skip_type_parentheses(node.type_());
    let type_text = ctx.node_text(type_node);
    if state.options.types_to_ignore.contains(&type_text) {
        return;
    }

    let c = &mut *ctx.checker;
    let cast = c.get_type_at_location(node);
    let cast_is_literal = is_type_literal(c, cast);
    let is_const = is_const_assertion(type_node);
    if !state.options.check_literal_const_assertions && cast_is_literal && is_const {
        return;
    }

    let expression = node.expression();
    let mut uncast = uncast_type(c, node);

    let bare_expression = skip_parentheses(expression);
    if uncast == cast && is_identifier(bare_expression) {
        // typescript-go may resolve a conditional type at the assertion;
        // compare against the declared form instead.
        let symbol = c.get_symbol_at_location_exported(bare_expression);
        if symbol.is_some() {
            let symbol_type = c.get_type_of_symbol(symbol);
            if is_type_flag_set(c, symbol_type, TypeFlags::CONDITIONAL) {
                uncast = symbol_type;
            }
        }
    }

    let type_is_unchanged = state.is_type_unchanged(c, node, expression, uncast, cast);
    let would_same_type_be_inferred = if cast_is_literal {
        is_implicitly_narrowed_literal_declaration(node)
    } else {
        !is_const
    };
    if type_is_unchanged && would_same_type_be_inferred {
        report_with_assertion_fixes(ctx, node, Unnecessary::Assertion);
        return;
    }

    let cast_is_any = is_type_any_type(c, cast) && !is_skip_parent_type(node);
    let contextual =
        if state.should_skip_contextual_type_fallback(c, node, cast_is_any, uncast, cast) {
            TypeId::NIL
        } else {
            c.get_contextual_type(node, ContextFlags::NONE)
        };

    if contextual.is_some() {
        let contextual_is_any = is_type_any_type(c, contextual);
        let is_call_argument = argument_index_in_parent_call(node).is_some();
        let any_involved_in_contextual_check = (!contextual_is_any && !contains_any(c, contextual))
            || (contextual_is_any && is_call_argument && !contains_any(c, cast));

        let is_contextually_unnecessary = !is_const
            && !contains_any(c, uncast)
            && any_involved_in_contextual_check
            && !has_phantom_type_argument_mismatch(c, node, uncast, contextual)
            && (cast_is_any || !generics_mismatch(c, uncast, contextual))
            && (contextual_is_any || c.is_type_assignable_to(uncast, contextual))
            && !is_nullish_literal_to_union(c, node, cast);
        if is_contextually_unnecessary {
            report_with_assertion_fixes(ctx, node, Unnecessary::Contextually);
            return;
        }
    }

    if let Some(kind) = state.double_assertion_kind(c, node, contextual) {
        report_double_assertion(ctx, node, kind);
    }
}

fn has_phantom_type_argument_mismatch(
    c: &mut Checker,
    node: Node,
    uncast: TypeId,
    contextual: TypeId,
) -> bool {
    is_in_generic_context(c, node)
        && (has_phantom_type_arguments(c, uncast) || has_phantom_type_arguments(c, contextual))
        && type_arguments(c, uncast) != type_arguments(c, contextual)
}

fn is_nullish_literal_to_union(c: &Checker, node: Node, cast: TypeId) -> bool {
    let expression = skip_parentheses(node.expression());
    is_union_type(c, cast)
        && (expression.kind() == SyntaxKind::NullKeyword
            || (is_identifier(expression) && expression.text() == "undefined"))
}

fn check_non_null_assertion(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let expression = skip_parentheses(node.expression());
    let report_removing_exclamation = |ctx: &mut RuleContext<'_>, kind: Unnecessary| {
        let exclamation = exclamation_token_range(ctx.source_file, node);
        let report = Report::new(assertion_range(ctx.source_file, node), kind.message());
        ctx.report_diagnostic_with_fixes(report, |_| vec![RuleFix::remove_range(exclamation)]);
    };

    let parent = walk_up_parenthesized_expressions(node.parent());
    if is_assignment_expression(parent, true) {
        if skip_parentheses(parent.left()) == node {
            report_removing_exclamation(ctx, Unnecessary::Contextually);
        }
        // Other `=` assignments are skipped: a non-null assertion can change
        // the type flow of the code after the assignment.
        return;
    }

    let c = &mut *ctx.checker;
    let constrained = get_constrained_type_at_location(c, expression);
    let actual = c.get_type_at_location(expression);
    let constrained_is_nullable = is_nullable_for_non_null_assertion(c, constrained);
    let actual_is_nullable = is_nullable_for_non_null_assertion(c, actual);

    if !constrained_is_nullable && !actual_is_nullable {
        if is_identifier(expression) && state.is_possibly_used_before_assigned(c, expression) {
            return;
        }
        report_removing_exclamation(ctx, Unnecessary::Assertion);
        return;
    }

    // The type is nullable: report only when the receiver accepts the same
    // nullish types.
    if constrained != actual {
        return;
    }
    let type_flags = union_flags(c, constrained);
    let contextual = get_contextual_type(c, node);
    if contextual.is_nil() {
        return;
    }
    let contextual_flags = union_flags(c, contextual);
    if type_flags.intersects(TypeFlags::UNKNOWN) && !contextual_flags.intersects(TypeFlags::UNKNOWN)
    {
        return;
    }
    // In strict mode `null` is not assignable to `undefined`, so both must
    // share each nullish type.
    let accepts =
        |flag: TypeFlags| !type_flags.intersects(flag) || contextual_flags.intersects(flag);
    if accepts(TypeFlags::UNDEFINED) && accepts(TypeFlags::NULL) && accepts(TypeFlags::VOID) {
        report_removing_exclamation(ctx, Unnecessary::Contextually);
    }
}

fn union_flags(c: &Checker, t: TypeId) -> TypeFlags {
    union_type_parts(c, t)
        .iter()
        .fold(TypeFlags::NONE, |flags, &part| flags | c.ty(part).flags)
}

/// The `!` token after the expression of a non-null assertion.
fn exclamation_token_range(source_file: Node, node: Node) -> TextRange {
    let text = source_file_text(source_file);
    get_scanner_for_source_file(source_file, &text, node.expression().end()).token_range()
}
