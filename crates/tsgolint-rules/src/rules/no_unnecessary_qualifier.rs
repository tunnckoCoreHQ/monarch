//! `no-unnecessary-qualifier`: disallows a namespace or enum qualifier when
//! the qualified name is already in scope.

use goport_core::ast::TextRange;
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId};
use goport_core::flags::SymbolFlags;
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
};

use crate::utils::is_symbol_flag_set;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-qualifier",
    create,
};

fn unnecessary_qualifier_message(name: &str) -> RuleMessage {
    RuleMessage::new(
        "unnecessaryQualifier",
        format!("Qualifier is unnecessary since '{name}' is in scope."),
    )
}

#[derive(Default)]
struct State {
    /// The enum and namespace declarations around the current node.
    namespaces_in_scope: Vec<Node>,
    /// The reported access; nested accesses are skipped until it is left.
    current_failed_expression: Node,
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(State::default())
        .on(SyntaxKind::EnumDeclaration, |state, _, node| {
            state.namespaces_in_scope.push(node);
        })
        .on(
            Listener::exit(SyntaxKind::EnumDeclaration),
            |state, _, _| {
                state.namespaces_in_scope.pop();
            },
        )
        .on(SyntaxKind::ModuleBlock, |state, _, node| {
            if is_module_declaration_block(node) {
                state.namespaces_in_scope.push(node.parent());
            }
        })
        .on(Listener::exit(SyntaxKind::ModuleBlock), |state, _, node| {
            if is_module_declaration_block(node) {
                state.namespaces_in_scope.pop();
            }
        })
        .on(SyntaxKind::PropertyAccessExpression, |state, ctx, node| {
            let name = node.name();
            if name.is_some() && is_entity_name_expression(node.expression()) {
                visit_namespace_access(state, ctx, node, node.expression(), name);
            }
        })
        .on(
            Listener::exit(SyntaxKind::PropertyAccessExpression),
            reset_current_expression,
        )
        .on(SyntaxKind::QualifiedName, |state, ctx, node| {
            visit_namespace_access(state, ctx, node, node.left(), node.right());
        })
        .on(
            Listener::exit(SyntaxKind::QualifiedName),
            reset_current_expression,
        )
        .into()
}

fn is_module_declaration_block(node: Node) -> bool {
    let parent = node.parent();
    parent.is_some() && parent.kind() == SyntaxKind::ModuleDeclaration
}

fn reset_current_expression(state: &mut State, _: &mut RuleContext<'_>, node: Node) {
    if node == state.current_failed_expression {
        state.current_failed_expression = Node::NIL;
    }
}

fn is_entity_name_expression(node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    match node.kind() {
        SyntaxKind::Identifier => true,
        SyntaxKind::PropertyAccessExpression => is_entity_name_expression(node.expression()),
        _ => false,
    }
}

fn visit_namespace_access(
    state: &mut State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    qualifier: Node,
    name: Node,
) {
    if state.current_failed_expression.is_some() {
        return;
    }
    // Only enum and namespace bodies fill the scope, and most accesses are
    // outside them, so skip the symbol lookups there.
    if state.namespaces_in_scope.is_empty() {
        return;
    }
    if !qualifier_is_unnecessary(ctx.checker, &state.namespaces_in_scope, qualifier, name) {
        return;
    }

    state.current_failed_expression = node;
    ctx.report_node_with_fixes(
        qualifier,
        unnecessary_qualifier_message(name.text()),
        |ctx| {
            let qualifier_start = ctx.trim_node_text_range(qualifier).pos();
            let name_start = ctx.trim_node_text_range(name).pos();
            vec![RuleFix::remove_range(TextRange::new(
                qualifier_start,
                name_start,
            ))]
        },
    );
}

fn qualifier_is_unnecessary(
    checker: &mut Checker,
    namespaces_in_scope: &[Node],
    qualifier: Node,
    name: Node,
) -> bool {
    let namespace_symbol = checker.get_symbol_at_location_exported(qualifier);
    if !symbol_is_namespace_in_scope(checker, namespaces_in_scope, namespace_symbol) {
        return false;
    }
    let accessed = checker.get_symbol_at_location_exported(name);
    if accessed.is_nil() {
        return false;
    }
    let flags = checker.sym(accessed).flags;
    let name_text = name.text();
    let in_scope = checker
        .get_symbols_in_scope_exported(qualifier, flags)
        .into_iter()
        .find(|&s| checker.sym(s).name.as_str() == name_text);
    in_scope.is_some_and(|s| accessed == checker.get_export_symbol_of_symbol(s))
}

fn symbol_is_namespace_in_scope(
    checker: &mut Checker,
    namespaces_in_scope: &[Node],
    symbol: SymbolId,
) -> bool {
    if symbol.is_nil() {
        return false;
    }
    if checker
        .sym(symbol)
        .declarations
        .iter()
        .any(|declaration| namespaces_in_scope.contains(declaration))
    {
        return true;
    }
    if is_symbol_flag_set(checker, symbol, SymbolFlags::ALIAS) {
        let aliased = checker.get_aliased_symbol(symbol);
        return symbol_is_namespace_in_scope(checker, namespaces_in_scope, aliased);
    }
    false
}
