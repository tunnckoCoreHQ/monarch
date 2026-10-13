//! AST predicates and walkers (tsgolint `ts_api_utils.go`, `utils.go`,
//! `ts_eslint.go`). A nil `Node` is Go's nil `*ast.Node`.

use goport_core::ast::{self, NodeList};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::OperatorPrecedenceFlags;

/// The `null` keyword. False for a nil node.
pub fn is_null_literal(node: Node) -> bool {
    node.is_some() && node.kind() == SyntaxKind::NullKeyword
}

/// The identifier `undefined`. False for a nil node.
pub fn is_undefined_identifier(node: Node) -> bool {
    node.is_some() && ast::is_identifier(node) && node.text() == "undefined"
}

/// `undefined` or a `void` expression.
pub fn is_undefined_literal(node: Node) -> bool {
    is_undefined_identifier(node) || (node.is_some() && ast::is_void_expression(node))
}

/// `null`, `undefined` or a `void` expression.
pub fn is_nullish_literal(node: Node) -> bool {
    is_null_literal(node) || is_undefined_literal(node)
}

/// `null` or the identifier `undefined` (not `void`).
pub fn is_null_literal_or_undefined_identifier(node: Node) -> bool {
    is_null_literal(node) || is_undefined_identifier(node)
}

/// A property access or an element access.
pub fn is_property_or_element_access(node: Node) -> bool {
    ast::is_property_access_expression(node) || ast::is_element_access_expression(node)
}

/// tsgolint's `IsAccessExpression`: a property access, an element access or
/// a call. Unlike `ast::is_access_expression`, this includes calls.
pub fn is_access_expression(node: Node) -> bool {
    is_property_or_element_access(node) || ast::is_call_expression(node)
}

/// The heritage clauses of a class or interface declaration, or a nil list.
pub fn get_heritage_clauses(node: Node) -> NodeList {
    match node.kind() {
        SyntaxKind::ClassDeclaration
        | SyntaxKind::ClassExpression
        | SyntaxKind::InterfaceDeclaration => node.heritage_clauses(),
        _ => NodeList::NIL,
    }
}

/// The first modifier of `node` with the given kind, or nil.
pub fn find_modifier(node: Node, modifier: SyntaxKind) -> Node {
    let modifiers = node.modifiers();
    if modifiers.is_nil() {
        return Node::NIL;
    }
    modifiers
        .nodes()
        .into_iter()
        .find(|m| m.kind() == modifier)
        .unwrap_or(Node::NIL)
}

/// Whether `node` has a modifier of the given kind.
pub fn includes_modifier(node: Node, modifier: SyntaxKind) -> bool {
    find_modifier(node, modifier).is_some()
}

/// A `...rest` parameter declaration.
pub fn is_rest_parameter_declaration(declaration: Node) -> bool {
    ast::is_parameter_declaration(declaration) && declaration.dot_dot_dot_token().is_some()
}

/// typescript-eslint `getThisExpression`: the `this` at the root of a chain
/// of calls, accesses and parentheses, or nil.
pub fn get_this_expression(mut node: Node) -> Node {
    loop {
        node = ast::skip_parentheses(node);
        if ast::is_call_expression(node) {
            node = node.expression();
        } else if node.kind() == SyntaxKind::ThisKeyword {
            return node;
        } else if ast::is_access_expression(node) {
            node = node.expression();
        } else {
            return Node::NIL;
        }
    }
}

/// typescript-eslint `getParentFunctionNode`: the nearest function-like
/// declaration above `node`, or nil.
pub fn get_parent_function_node(node: Node) -> Node {
    let mut current = node.parent();
    while current.is_some() {
        if ast::is_function_like_declaration(current) {
            return current;
        }
        current = current.parent();
    }
    Node::NIL
}

/// Whether `node` binds tighter than an `await` expression.
pub fn is_higher_precedence_than_await(node: Node) -> bool {
    let node_precedence = ast::get_expression_precedence(node);
    let await_precedence = ast::get_operator_precedence(
        SyntaxKind::AwaitExpression,
        SyntaxKind::Unknown,
        OperatorPrecedenceFlags::NONE,
    );
    node_precedence > await_precedence
}

/// The function-like kinds with a body, without `ArrowFunction`, which rules
/// often handle on its own.
pub const NON_ARROW_FUNCTION_KINDS: [SyntaxKind; 6] = [
    SyntaxKind::FunctionDeclaration,
    SyntaxKind::FunctionExpression,
    SyntaxKind::MethodDeclaration,
    SyntaxKind::Constructor,
    SyntaxKind::GetAccessor,
    SyntaxKind::SetAccessor,
];

/// typescript-eslint `isStrongPrecedenceNode`: a node that never needs
/// parentheses when it becomes an operand.
pub fn is_strong_precedence_node(inner: Node) -> bool {
    ast::is_literal_kind(inner.kind())
        || ast::is_boolean_literal(inner)
        || ast::is_parenthesized_expression(inner)
        || matches!(
            inner.kind(),
            SyntaxKind::Identifier
                | SyntaxKind::TypeReference
                | SyntaxKind::ArrayLiteralExpression
                | SyntaxKind::ObjectLiteralExpression
                | SyntaxKind::PropertyAccessExpression
                | SyntaxKind::ElementAccessExpression
                | SyntaxKind::CallExpression
                | SyntaxKind::NewExpression
                | SyntaxKind::TaggedTemplateExpression
                | SyntaxKind::ExpressionWithTypeArguments
        )
}

/// Whether `node` is the expression of a parenthesized expression.
pub fn is_parenthesized(node: Node) -> bool {
    let parent = node.parent();
    ast::is_parenthesized_expression(parent) && parent.expression() == node
}

/// Whether the parent of `node` binds tighter than an expression that
/// replaces `node` (a call chain, or `x satisfies T`), so that the
/// replacement needs parentheses.
pub fn is_weak_precedence_parent(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        SyntaxKind::PostfixUnaryExpression
        | SyntaxKind::PrefixUnaryExpression
        | SyntaxKind::BinaryExpression
        | SyntaxKind::ConditionalExpression
        | SyntaxKind::AwaitExpression => true,
        SyntaxKind::PropertyAccessExpression
        | SyntaxKind::ElementAccessExpression
        | SyntaxKind::CallExpression
        | SyntaxKind::NewExpression => parent.expression() == node,
        SyntaxKind::TaggedTemplateExpression => parent.tag() == node,
        _ => false,
    }
}

/// An arrow function whose single parameter has no parentheses (`x => x`).
pub fn is_parenless_arrow_function(node: Node) -> bool {
    ast::is_arrow_function(node)
        && node.parameter_list().end() == node.equals_greater_than_token().pos()
}
