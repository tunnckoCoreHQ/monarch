//! `no-unnecessary-type-arguments`: disallows type arguments that equal the
//! default of their type parameter.

use goport_core::ast::{
    NodeList, NodeSlice, is_class_like, is_function_like, is_heritage_clause, is_identifier,
    is_interface_declaration, is_new_expression, is_type_alias_declaration, is_type_reference_node,
    is_variable_declaration,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{CheckMode, ObjectFlags, SymbolFlags};
use goport_util::gostd::slices::sort_func;
use rustc_hash::FxHashSet;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage};

use crate::utils::get_construct_signatures;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-type-arguments",
    create,
};

fn unnecessary_type_parameter_message() -> RuleMessage {
    RuleMessage::new(
        "unnecessaryTypeParameter",
        "This is the default value for this type parameter, so it can be omitted.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::ExpressionWithTypeArguments, |_, ctx, node| {
            check_type_reference(ctx, node, node.expression());
        })
        .on(SyntaxKind::TypeReference, |_, ctx, node| {
            check_type_reference(ctx, node, node.type_name());
        })
        .on(SyntaxKind::CallExpression, check_call)
        .on(SyntaxKind::NewExpression, check_call)
        .on(SyntaxKind::TaggedTemplateExpression, check_call)
        .on(SyntaxKind::JsxOpeningElement, check_call)
        .on(SyntaxKind::JsxSelfClosingElement, check_call)
        .into()
}

fn check_type_reference(ctx: &mut RuleContext<'_>, node: Node, name: Node) {
    let arguments = node.type_argument_list();
    if arguments.nodes().is_empty() {
        return;
    }
    let parameters = type_parameters_of_type(ctx.checker, node, name);
    check_arguments(ctx, node, arguments, parameters);
}

fn check_call(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let arguments = node.type_argument_list();
    if arguments.nodes().is_empty() {
        return;
    }
    let parameters = type_parameters_of_call(ctx.checker, node);
    check_arguments(ctx, node, arguments, parameters);
}

fn is_type_context_declaration(declaration: Node) -> bool {
    is_type_alias_declaration(declaration) || is_interface_declaration(declaration)
}

fn is_in_type_context(node: Node) -> bool {
    let parent = node.parent();
    is_type_reference_node(node)
        || is_interface_declaration(parent)
        || is_type_reference_node(parent)
        || (is_heritage_clause(parent) && parent.token() == SyntaxKind::ImplementsKeyword)
}

/// The type parameters of the type or class that `name` refers to.
fn type_parameters_of_type(checker: &mut Checker, node: Node, name: Node) -> NodeSlice {
    let mut symbol = checker.get_symbol_at_location_exported(name);
    if symbol.is_nil() {
        return NodeSlice::default();
    }
    if checker.sym(symbol).flags.intersects(SymbolFlags::ALIAS) {
        let (resolved, found) = checker.resolve_alias_exported(symbol);
        if !found {
            return NodeSlice::default();
        }
        symbol = resolved;
    }

    let mut declarations: Vec<Node> = checker.sym(symbol).declarations.to_vec();
    // Type aliases and interfaces come first in a type context and last
    // elsewhere. tsgolint sorts with Go's unstable `slices.SortFunc`;
    // `sort_func` puts ties in the same order, which decides the declaration
    // used when a symbol has more than 12 of them.
    let in_type_context = is_in_type_context(node);
    sort_func(&mut declarations, |&a, &b| {
        let order = is_type_context_declaration(b) as i32 - is_type_context_declaration(a) as i32;
        if in_type_context { order } else { -order }
    });

    for declaration in declarations {
        if is_type_alias_declaration(declaration)
            || is_interface_declaration(declaration)
            || is_class_like(declaration)
        {
            return declaration.type_parameters();
        }
        if is_variable_declaration(declaration) {
            let t = checker.get_type_of_symbol(symbol);
            let signatures = get_construct_signatures(checker, t);
            let Some(&first) = signatures.first() else {
                continue;
            };
            let signature_declaration = checker.sig(first).declaration();
            if signature_declaration.is_some() {
                return signature_declaration.type_parameters();
            }
        }
    }
    NodeSlice::default()
}

/// The type parameters of the signature that a call, `new`, tagged template
/// or JSX element resolves to.
fn type_parameters_of_call(checker: &mut Checker, node: Node) -> NodeSlice {
    let signature = checker.get_resolved_signature(node, None, CheckMode::NORMAL);
    if signature.is_some() {
        let declaration = checker.sig(signature).declaration();
        if declaration.is_some() {
            let parameters = declaration.type_parameters();
            if !parameters.is_empty() {
                return parameters;
            }
        }
    }
    if is_new_expression(node) {
        return type_parameters_of_type(checker, node, node.expression());
    }
    NodeSlice::default()
}

/// A type with its reference target and type arguments split out, so that
/// two instantiations of a generic type compare equal.
fn comparison_parts(checker: &mut Checker, t: TypeId) -> (TypeId, Vec<TypeId>) {
    if checker
        .ty(t)
        .object_flags
        .intersects(ObjectFlags::REFERENCE)
    {
        let target = checker.ty(t).target();
        (target, checker.get_type_arguments(t).to_vec())
    } else {
        (t, Vec::new())
    }
}

fn check_arguments(
    ctx: &mut RuleContext<'_>,
    node: Node,
    arguments: NodeList,
    parameters: NodeSlice,
) {
    let argument_nodes = arguments.nodes();
    if argument_nodes.is_empty() || parameters.is_empty() {
        return;
    }
    // Only the last argument can be omitted: the ones before it must stay.
    let last = argument_nodes.len() - 1;
    if last >= parameters.len() {
        return;
    }
    let type_argument = argument_nodes.get(last);
    let default_type_node = parameters.get(last).default_type();
    if default_type_node.is_nil() {
        return;
    }

    let default_type = ctx.checker.get_type_at_location(default_type_node);
    let argument_type = ctx.checker.get_type_at_location(type_argument);
    if default_type.is_nil() || argument_type.is_nil() {
        return;
    }
    // Generic object types are not always shared, so compare their targets
    // and type arguments too.
    let types_match = default_type == argument_type
        || comparison_parts(ctx.checker, default_type)
            == comparison_parts(ctx.checker, argument_type);
    if !types_match {
        return;
    }

    // Removing the whole type argument list from a `new` can let the
    // constructor arguments infer the class type parameters again.
    if last == 0 && constructor_arguments_can_infer(ctx.checker, node, parameters) {
        return;
    }

    ctx.report_node_with_fixes(type_argument, unnecessary_type_parameter_message(), |ctx| {
        let range = if last == 0 {
            token_range_at(ctx.source_file, arguments.end()).with_pos(arguments.pos() - 1)
        } else {
            type_argument
                .loc()
                .with_pos(argument_nodes.get(last - 1).end())
        };
        vec![RuleFix::remove_range(range)]
    });
}

fn constructor_arguments_can_infer(
    checker: &mut Checker,
    node: Node,
    parameters: NodeSlice,
) -> bool {
    if !is_new_expression(node) || node.arguments().is_empty() {
        return false;
    }
    let mut type_parameter_symbols: FxHashSet<SymbolId> = FxHashSet::default();
    for parameter in parameters {
        let name = parameter.name();
        if name.is_nil() {
            continue;
        }
        let symbol = checker.get_symbol_at_location_exported(name);
        if symbol.is_some() {
            type_parameter_symbols.insert(symbol);
        }
    }
    if type_parameter_symbols.is_empty() {
        return false;
    }

    let signature = checker.get_resolved_signature(node, None, CheckMode::NORMAL);
    if signature.is_nil() {
        return false;
    }
    let declaration = checker.sig(signature).declaration();
    if declaration.is_nil() || !is_function_like(declaration) {
        return false;
    }
    declaration.parameters().into_iter().any(|parameter| {
        let type_node = parameter.type_();
        type_node.is_some() && references_symbols(checker, type_node, &type_parameter_symbols)
    })
}

/// Whether an identifier under `node` resolves to one of `symbols`.
fn references_symbols(checker: &mut Checker, node: Node, symbols: &FxHashSet<SymbolId>) -> bool {
    if is_identifier(node) {
        let symbol = checker.get_symbol_at_location_exported(node);
        if symbol.is_some() && symbols.contains(&symbol) {
            return true;
        }
    }
    node.for_each_child(|child| references_symbols(checker, child, symbols))
}
