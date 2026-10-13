//! The AST walk that drives the listeners (Go `linter.visitLintNodes`).

use goport_core::ast::is_assignment_expression;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;

use crate::rule::Listener;

/// Walks the children of `source_file` (the file node itself is not
/// visited) in `for_each_child` order and calls `run` for each event.
///
/// Only the left side of a plain `=` assignment is a pattern: there the walk
/// goes through array and object literals, spreads and property values (not
/// property names) with the allow-pattern events, and back to the normal
/// walk for anything else. Array and object literals outside a pattern get
/// the not-allow-pattern events.
pub fn visit_lint_nodes(source_file: Node, run: &mut dyn FnMut(Listener, Node)) {
    source_file.for_each_child(|child| {
        visit(child, run);
        false
    });
}

fn visit(node: Node, run: &mut dyn FnMut(Listener, Node)) {
    let kind = node.kind();
    run(Listener::enter(kind), node);
    match kind {
        SyntaxKind::ArrayLiteralExpression | SyntaxKind::ObjectLiteralExpression => {
            run(Listener::not_allow_pattern(kind), node);
            visit_children(node, run);
            run(Listener::exit_not_allow_pattern(kind), node);
        }
        // tsgolint visits only these three: `modifiers` and `type` of a
        // binary expression (JS-only) are skipped here.
        _ if is_assignment_expression(node, true) => {
            visit_pattern(node.left(), run);
            visit(node.operator_token(), run);
            visit(node.right(), run);
        }
        _ => visit_children(node, run),
    }
    run(Listener::exit(kind), node);
}

fn visit_children(node: Node, run: &mut dyn FnMut(Listener, Node)) {
    node.for_each_child(|child| {
        visit(child, run);
        false
    });
}

fn visit_pattern(node: Node, run: &mut dyn FnMut(Listener, Node)) {
    let kind = node.kind();
    run(Listener::enter(kind), node);
    run(Listener::allow_pattern(kind), node);
    match kind {
        SyntaxKind::ArrayLiteralExpression => {
            for element in node.elements() {
                visit_pattern(element, run);
            }
        }
        SyntaxKind::ObjectLiteralExpression => {
            for property in node.properties() {
                visit_pattern(property, run);
            }
        }
        SyntaxKind::SpreadElement | SyntaxKind::SpreadAssignment => {
            visit_pattern(node.expression(), run);
        }
        // The property name is not visited.
        SyntaxKind::PropertyAssignment => visit_pattern(node.initializer(), run),
        _ => visit_children(node, run),
    }
    run(Listener::exit_allow_pattern(kind), node);
    run(Listener::exit(kind), node);
}
