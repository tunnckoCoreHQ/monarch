//! `no-useless-default-assignment`: reports default values that can never
//! be used because the value is never `undefined`.

use goport_core::ast::{
    NodeSlice, TextRange, is_array_binding_pattern, is_arrow_function, is_binding_element,
    is_computed_property_name, is_conditional_expression, is_function_expression, is_function_like,
    is_identifier, is_literal_expression, is_object_binding_pattern, is_object_literal_expression,
    is_parameter_declaration, is_spread_assignment, is_variable_declaration, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ContextFlags, ElementFlags, SymbolFlags, TypeFlags, UnionReduction};
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::{
    get_call_signatures, get_number_index_type, is_intersection_type, is_symbol_flag_set,
    is_type_any_type, is_type_flag_set, is_type_parameter, is_type_undefined_type,
    is_type_unknown_type, is_undefined_identifier, is_union_type, require_strict_null_checks,
    union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-useless-default-assignment",
    create,
};
fn prefer_optional_syntax_message() -> RuleMessage {
    RuleMessage::new(
        "preferOptionalSyntax",
        "Using `= undefined` to make a parameter optional adds unnecessary runtime logic.",
    )
}

fn useless_default_assignment_message(assignment_type: &str) -> RuleMessage {
    RuleMessage::new(
        "uselessDefaultAssignment",
        format!(
            "Default value is useless because the {assignment_type} is not nullish. \
             This default assignment will never be used."
        ),
    )
    .with_help("Remove the default assignment")
}

fn useless_default_assignment_with_type_message(
    assignment_type: &str,
    type_text: &str,
) -> RuleMessage {
    RuleMessage::new(
        "uselessDefaultAssignment",
        format!(
            "Default value is useless because the {assignment_type} has type `{type_text}` \
             (not nullish). This default assignment will never be used."
        ),
    )
    .with_help("Remove the default assignment")
}

fn remove_default_assignment_message() -> RuleMessage {
    RuleMessage::new("removeDefaultAssignment", "Remove the default value.")
}

fn use_optional_syntax_message() -> RuleMessage {
    RuleMessage::new("useOptionalSyntax", "Use the `?` optional syntax instead.")
}

fn useless_undefined_message(plural_assignment_type: &str) -> RuleMessage {
    RuleMessage::new(
        "uselessUndefined",
        format!(
            "Default value is useless because it is undefined. \
             Optional {plural_assignment_type} are already undefined by default."
        ),
    )
    .with_help("Remove the default assignment")
}

/// What a default value belongs to, as the messages name it.
#[derive(Clone, Copy)]
enum AssignmentType {
    Parameter,
    Property,
}

impl AssignmentType {
    fn singular(self) -> &'static str {
        match self {
            AssignmentType::Parameter => "parameter",
            AssignmentType::Property => "property",
        }
    }

    fn plural(self) -> &'static str {
        match self {
            AssignmentType::Parameter => "parameters",
            AssignmentType::Property => "properties",
        }
    }
}

fn create(ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    require_strict_null_checks(ctx);
    Listeners::new(())
        .on(SyntaxKind::BindingElement, check_assignment_pattern)
        .on(SyntaxKind::Parameter, check_assignment_pattern)
        .into()
}

fn can_be_undefined(checker: &Checker, t: TypeId) -> bool {
    if t.is_nil() {
        return false;
    }
    if is_type_any_type(checker, t) || is_type_unknown_type(checker, t) {
        return true;
    }
    union_type_parts(checker, t)
        .into_iter()
        .any(|part| is_type_undefined_type(checker, part))
}

/// The static name of a property name node (identifier, string or number
/// literal, possibly computed).
fn get_property_name(node: Node) -> Option<&'static str> {
    if node.is_nil() {
        return None;
    }
    let node = if is_computed_property_name(node) {
        node.expression()
    } else {
        node
    };
    if is_identifier(node)
        || is_literal_expression(node)
        || node.kind() == SyntaxKind::NoSubstitutionTemplateLiteral
    {
        return Some(node.text());
    }
    None
}

fn find_node_index(nodes: NodeSlice, target: Node) -> Option<usize> {
    nodes.into_iter().position(|node| node == target)
}

fn get_array_element_type(checker: &mut Checker, array_type: TypeId, index: usize) -> TypeId {
    if checker.is_tuple_type(array_type) {
        let tuple_args = checker.get_type_arguments(array_type);
        if let Some(&t) = tuple_args.get(index) {
            return t;
        }
    }
    get_number_index_type(checker, array_type)
}

/// Where the ` = value` part starts: after the type annotation or the name.
fn get_default_assignment_start(node: Node) -> i32 {
    if is_parameter_declaration(node) {
        if node.type_().is_some() {
            return node.type_().end();
        }
        if node.name().is_some() {
            return node.name().end();
        }
    }
    if is_binding_element(node) && node.name().is_some() {
        return node.name().end();
    }
    node.pos()
}

fn is_simple_type_for_message(checker: &Checker, t: TypeId) -> bool {
    if t.is_nil() || is_union_type(checker, t) || is_intersection_type(checker, t) {
        return false;
    }
    if is_type_flag_set(
        checker,
        t,
        TypeFlags::STRING_LIKE
            | TypeFlags::NUMBER_LIKE
            | TypeFlags::BOOLEAN_LIKE
            | TypeFlags::BIG_INT_LIKE
            | TypeFlags::ES_SYMBOL_LIKE,
    ) {
        return true;
    }
    let symbol = checker.ty(t).symbol;
    symbol.is_some() && !checker.sym(symbol).name.as_str().is_empty()
}

fn get_assignment_target_node(node: Node) -> Node {
    if is_parameter_declaration(node) {
        if node.type_().is_some() {
            return node.type_();
        }
        return node.name();
    }
    if is_binding_element(node) {
        return node.name();
    }
    Node::NIL
}

/// Whether every branch of an object literal (through conditionals) sets
/// `property_name`.
fn has_property_in_all_branches(expression: Node, property_name: &str) -> bool {
    let expression = skip_parentheses(expression);
    if is_object_literal_expression(expression) {
        return expression.properties().into_iter().any(|property| {
            !is_spread_assignment(property)
                && get_property_name(property.name()) == Some(property_name)
        });
    }
    if is_conditional_expression(expression) {
        return has_property_in_all_branches(expression.when_true(), property_name)
            && has_property_in_all_branches(expression.when_false(), property_name);
    }
    false
}

/// The type of the value a binding element destructures, or nil.
fn get_type_of_binding_element(checker: &mut Checker, binding_element: Node) -> TypeId {
    if binding_element.is_nil() || !is_binding_element(binding_element) {
        return TypeId::NIL;
    }
    let parent_pattern = binding_element.parent();
    if parent_pattern.is_nil() {
        return TypeId::NIL;
    }

    if is_object_binding_pattern(parent_pattern) {
        let source_type = get_source_type_for_pattern(checker, parent_pattern);
        if source_type.is_nil() {
            return TypeId::NIL;
        }
        let mut property_name_node = binding_element.property_name();
        if property_name_node.is_nil() {
            property_name_node = binding_element.name();
        }
        let Some(property_name) = get_property_name(property_name_node) else {
            return TypeId::NIL;
        };
        let symbol = checker.get_property_of_type(source_type, property_name);
        if symbol.is_nil() {
            return TypeId::NIL;
        }
        if is_symbol_flag_set(checker, symbol, SymbolFlags::OPTIONAL) {
            // An optional property is defined only when the initializer sets
            // it in every branch.
            let declaration = parent_pattern.parent();
            if !is_variable_declaration(declaration)
                || declaration.initializer().is_nil()
                || !has_property_in_all_branches(declaration.initializer(), property_name)
            {
                return TypeId::NIL;
            }
        }
        return checker.get_type_of_symbol_at_location(symbol, binding_element);
    }

    if is_array_binding_pattern(parent_pattern) {
        let source_type = get_source_type_for_pattern(checker, parent_pattern);
        if source_type.is_nil() {
            return TypeId::NIL;
        }
        let Some(index) = find_node_index(parent_pattern.elements(), binding_element) else {
            return TypeId::NIL;
        };
        return get_array_element_type(checker, source_type, index);
    }

    TypeId::NIL
}

/// The type of the value a binding pattern destructures, or nil.
fn get_source_type_for_pattern(checker: &mut Checker, pattern: Node) -> TypeId {
    if pattern.is_nil() || pattern.parent().is_nil() {
        return TypeId::NIL;
    }
    let parent = pattern.parent();
    if is_variable_declaration(parent) && parent.initializer().is_some() {
        return checker.get_type_at_location(parent.initializer());
    }

    if is_parameter_declaration(parent) {
        let function = parent.parent();
        if function.is_nil() || !is_function_like(function) {
            return TypeId::NIL;
        }
        let signature = checker.get_signature_from_declaration_exported(function);
        if signature.is_nil() {
            return TypeId::NIL;
        }
        let parameters = function.parameters();
        let Some(mut index) = find_node_index(parameters, parent) else {
            return TypeId::NIL;
        };
        if checker.sig(signature).this_parameter().is_some()
            && let Some(first) = parameters.first()
            && is_identifier(first.name())
            && first.name().text() == "this"
        {
            let Some(shifted) = index.checked_sub(1) else {
                return TypeId::NIL;
            };
            index = shifted;
        }
        let Some(&parameter) = checker.sig(signature).parameters().get(index) else {
            return TypeId::NIL;
        };
        return checker.get_type_of_symbol(parameter);
    }

    if is_binding_element(parent) {
        return get_type_of_binding_element(checker, parent);
    }

    if is_array_binding_pattern(parent) {
        let array_type = get_source_type_for_pattern(checker, parent);
        if array_type.is_nil() {
            return TypeId::NIL;
        }
        let Some(index) = find_node_index(parent.elements(), pattern) else {
            return TypeId::NIL;
        };
        return get_array_element_type(checker, array_type, index);
    }

    TypeId::NIL
}

fn remove_default_fix(node: Node) -> RuleFix {
    RuleFix::remove_range(TextRange::new(
        get_default_assignment_start(node),
        node.end(),
    ))
}

fn report_useless_default_assignment(
    ctx: &mut RuleContext<'_>,
    node: Node,
    assignment_type: AssignmentType,
    value_type: TypeId,
) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    let assignment_type = assignment_type.singular();
    let type_text = if is_simple_type_for_message(ctx.checker, value_type) {
        Some(ctx.checker.type_to_string(value_type))
    } else {
        None
    };
    let range = ctx.trim_node_text_range(initializer);
    let message = match &type_text {
        Some(type_text) => useless_default_assignment_with_type_message(assignment_type, type_text),
        None => useless_default_assignment_message(assignment_type),
    };
    let mut report = Report::new(range, message).with_label("Default value", range);
    // tsgolint skips the label when the type prints as "".
    if let Some(type_text) = type_text.filter(|text| !text.is_empty()) {
        let target = get_assignment_target_node(node);
        if target.is_some() {
            report = report.with_label(
                format!("{assignment_type} type `{type_text}` is not nullish"),
                ctx.trim_node_text_range(target),
            );
        }
    }
    ctx.report_diagnostic_with_suggestions(report, |_| {
        vec![RuleSuggestion {
            message: remove_default_assignment_message(),
            fixes: vec![remove_default_fix(node)],
        }]
    });
}

fn report_useless_undefined(
    ctx: &mut RuleContext<'_>,
    node: Node,
    assignment_type: AssignmentType,
) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    ctx.report_node_with_suggestions(
        initializer,
        useless_undefined_message(assignment_type.plural()),
        |_| {
            vec![RuleSuggestion {
                message: remove_default_assignment_message(),
                fixes: vec![remove_default_fix(node)],
            }]
        },
    );
}

fn report_prefer_optional_syntax(ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    ctx.report_node_with_suggestions(initializer, prefer_optional_syntax_message(), |ctx| {
        let mut fixes = vec![remove_default_fix(node)];
        if is_parameter_declaration(node) && is_identifier(node.name()) {
            let end = ctx.trim_node_text_range(node.name()).end();
            fixes.push(RuleFix::replace_range(TextRange::new(end, end), "?"));
        }
        vec![RuleSuggestion {
            message: use_optional_syntax_message(),
            fixes,
        }]
    });
}

/// A parameter of a function expression whose contextual signature types
/// the parameter as never `undefined`.
fn check_function_expression_parameter(ctx: &mut RuleContext<'_>, node: Node) {
    let function = node.parent();
    if function.is_nil() || (!is_arrow_function(function) && !is_function_expression(function)) {
        return;
    }
    let Some(index) = find_node_index(function.parameters(), node) else {
        return;
    };
    let checker = &mut *ctx.checker;
    let contextual_type = checker.get_contextual_type(function, ContextFlags::NONE);
    if contextual_type.is_nil() {
        return;
    }
    let signatures = get_call_signatures(checker, contextual_type);
    let Some(&signature) = signatures.first() else {
        return;
    };
    if checker.sig(signature).declaration() == function {
        return;
    }
    let Some(&parameter) = checker.sig(signature).parameters().get(index) else {
        return;
    };
    if parameter.is_nil() {
        return;
    }
    let declaration = checker.sym(parameter).value_declaration;
    if declaration.is_some()
        && is_parameter_declaration(declaration)
        && declaration.dot_dot_dot_token().is_some()
    {
        return;
    }
    if is_symbol_flag_set(checker, parameter, SymbolFlags::OPTIONAL) {
        return;
    }
    let parameter_type = checker.get_type_of_symbol(parameter);
    if !is_type_parameter(checker, parameter_type) && !can_be_undefined(checker, parameter_type) {
        report_useless_default_assignment(ctx, node, AssignmentType::Parameter, parameter_type);
    }
}

fn check_assignment_pattern(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    if is_undefined_identifier(skip_parentheses(initializer)) {
        if is_parameter_declaration(node) {
            let type_node = node.type_();
            if type_node.is_some() {
                let declared = ctx.checker.get_type_from_type_node(type_node);
                if can_be_undefined(ctx.checker, declared) {
                    report_prefer_optional_syntax(ctx, node);
                    return;
                }
            }
            report_useless_undefined(ctx, node, AssignmentType::Parameter);
            return;
        }
        report_useless_undefined(ctx, node, AssignmentType::Property);
        return;
    }

    if is_parameter_declaration(node) {
        check_function_expression_parameter(ctx, node);
        return;
    }
    if !is_binding_element(node) || node.parent().is_nil() {
        return;
    }

    let parent = node.parent();
    if is_object_binding_pattern(parent) {
        let property_type = get_type_of_binding_element(ctx.checker, node);
        if property_type.is_some() && !can_be_undefined(ctx.checker, property_type) {
            report_useless_default_assignment(ctx, node, AssignmentType::Property, property_type);
        }
        return;
    }

    if is_array_binding_pattern(parent) {
        let checker = &mut *ctx.checker;
        let source_type = get_source_type_for_pattern(checker, parent);
        if source_type.is_nil() || !checker.is_tuple_type(source_type) {
            return;
        }
        let tuple_args = checker.get_type_arguments(source_type);
        let Some(index) = find_node_index(parent.elements(), node) else {
            return;
        };
        if index >= tuple_args.len() {
            return;
        }
        let tuple = checker.target_tuple_type(source_type);
        if index as i32 >= tuple.min_length {
            return;
        }
        let fixed_length = tuple.fixed_length() as usize;
        let element_types = if index >= fixed_length {
            // A trailing element cannot reach this position when too many
            // required elements precede it.
            let element_infos = tuple.element_infos();
            let mut end = fixed_length;
            let mut position = fixed_length;
            while end < tuple_args.len() && position <= index {
                if element_infos[end]
                    .tuple_element_flags()
                    .intersects(ElementFlags::REQUIRED)
                {
                    position += 1;
                }
                end += 1;
            }
            &tuple_args[fixed_length..end]
        } else {
            &tuple_args[index..=index]
        };
        if !element_types.iter().any(|&t| can_be_undefined(checker, t)) {
            let element_type = checker.get_union_type_ex(
                element_types,
                UnionReduction::LITERAL,
                None,
                TypeId::NIL,
            );
            report_useless_default_assignment(ctx, node, AssignmentType::Property, element_type);
        }
    }
}
