//! Syntactic comparison of the expressions that operands check.

use std::rc::Rc;

use goport_core::ast::{self, NodeList};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use rustc_hash::FxHashMap;

use super::Processor;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum NodeComparison {
    Equal,
    /// The left expression is a prefix of the right one.
    Subset,
    Superset,
    Invalid,
}

/// Skips parentheses and non-null assertions.
pub(super) fn unwrap_for_comparison(mut node: Node) -> Node {
    while matches!(
        node.kind(),
        SyntaxKind::ParenthesizedExpression | SyntaxKind::NonNullExpression
    ) {
        node = node.expression();
    }
    node
}

fn lists_structurally_equal(a: NodeList, b: NodeList) -> bool {
    if a.is_nil() && b.is_nil() {
        return true;
    }
    if a.is_nil() || b.is_nil() || a.nodes().len() != b.nodes().len() {
        return false;
    }
    a.nodes()
        .into_iter()
        .zip(b.nodes())
        .all(|(a, b)| are_nodes_structurally_equal(a, b))
}

fn optional_texts_equal(a: Node, b: Node) -> bool {
    if a.is_nil() || b.is_nil() {
        a == b
    } else {
        a.text() == b.text()
    }
}

/// Structural equality that ignores parentheses and non-null assertions.
pub(super) fn are_nodes_structurally_equal(a: Node, b: Node) -> bool {
    if a.is_nil() || b.is_nil() {
        return a == b;
    }
    let a = unwrap_for_comparison(a);
    let b = unwrap_for_comparison(b);
    if a.kind() != b.kind() {
        return false;
    }

    match a.kind() {
        SyntaxKind::Identifier
        | SyntaxKind::StringLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral
        | SyntaxKind::NoSubstitutionTemplateLiteral => a.text() == b.text(),
        SyntaxKind::ThisKeyword
        | SyntaxKind::NullKeyword
        | SyntaxKind::SuperKeyword
        | SyntaxKind::TrueKeyword
        | SyntaxKind::FalseKeyword
        | SyntaxKind::StringKeyword
        | SyntaxKind::NumberKeyword
        | SyntaxKind::BooleanKeyword
        | SyntaxKind::AnyKeyword
        | SyntaxKind::UnknownKeyword
        | SyntaxKind::NeverKeyword
        | SyntaxKind::VoidKeyword
        | SyntaxKind::UndefinedKeyword
        | SyntaxKind::ObjectKeyword
        | SyntaxKind::SymbolKeyword
        | SyntaxKind::BigIntKeyword => true,
        SyntaxKind::PropertyAccessExpression => {
            let (a_name, b_name) = (a.name(), b.name());
            if a_name.is_nil() || b_name.is_nil() {
                return a_name == b_name;
            }
            a_name.text() == b_name.text()
                && are_nodes_structurally_equal(a.expression(), b.expression())
        }
        SyntaxKind::ElementAccessExpression => {
            are_nodes_structurally_equal(a.argument_expression(), b.argument_expression())
                && are_nodes_structurally_equal(a.expression(), b.expression())
        }
        SyntaxKind::CallExpression => {
            are_nodes_structurally_equal(a.expression(), b.expression())
                && lists_structurally_equal(a.argument_list(), b.argument_list())
                && lists_structurally_equal(a.type_argument_list(), b.type_argument_list())
        }
        SyntaxKind::AsExpression
        | SyntaxKind::TypeAssertionExpression
        | SyntaxKind::TypeOfExpression
        | SyntaxKind::AwaitExpression => {
            are_nodes_structurally_equal(a.expression(), b.expression())
        }
        SyntaxKind::TypeReference => are_nodes_structurally_equal(a.type_name(), b.type_name()),
        SyntaxKind::QualifiedName => {
            are_nodes_structurally_equal(a.left(), b.left())
                && are_nodes_structurally_equal(a.right(), b.right())
        }
        // `import.meta` and `new.target`.
        SyntaxKind::MetaProperty => {
            let (a_name, b_name) = (a.name(), b.name());
            if a_name.is_nil() || b_name.is_nil() {
                return a_name == b_name;
            }
            a.keyword_token() == b.keyword_token() && a_name.text() == b_name.text()
        }
        SyntaxKind::BinaryExpression => {
            a.operator_token().kind() == b.operator_token().kind()
                && are_nodes_structurally_equal(a.left(), b.left())
                && are_nodes_structurally_equal(a.right(), b.right())
        }
        SyntaxKind::PrefixUnaryExpression => {
            a.operator() == b.operator() && are_nodes_structurally_equal(a.operand(), b.operand())
        }
        SyntaxKind::TemplateExpression => {
            if !optional_texts_equal(a.head(), b.head()) {
                return false;
            }
            let (a_spans, b_spans) = (a.template_spans(), b.template_spans());
            if a_spans.is_nil() && b_spans.is_nil() {
                return true;
            }
            if a_spans.is_nil()
                || b_spans.is_nil()
                || a_spans.nodes().len() != b_spans.nodes().len()
            {
                return false;
            }
            a_spans
                .nodes()
                .into_iter()
                .zip(b_spans.nodes())
                .all(|(a, b)| {
                    are_nodes_structurally_equal(a.expression(), b.expression())
                        && optional_texts_equal(a.literal(), b.literal())
                })
        }
        _ => false,
    }
}

/// `shorter` is `longer` or a prefix of its access chain (`foo.bar` of
/// `foo.bar.baz`).
pub(super) fn is_node_prefix_of(shorter: Node, longer: Node) -> bool {
    let shorter = unwrap_for_comparison(shorter);
    let longer = unwrap_for_comparison(longer);
    if are_nodes_structurally_equal(shorter, longer) {
        return true;
    }
    match longer.kind() {
        SyntaxKind::PropertyAccessExpression
        | SyntaxKind::ElementAccessExpression
        | SyntaxKind::CallExpression
        | SyntaxKind::NonNullExpression => is_node_prefix_of(shorter, longer.expression()),
        _ => false,
    }
}

/// The root of an access chain, through parentheses and `as` too.
pub(super) fn get_base_identifier(mut node: Node) -> Node {
    while matches!(
        node.kind(),
        SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::CallExpression
            | SyntaxKind::NonNullExpression
            | SyntaxKind::ParenthesizedExpression
            | SyntaxKind::AsExpression
    ) {
        node = node.expression();
    }
    node
}

/// The root of a member/call chain, through parentheses.
pub(super) fn access_chain_root(mut node: Node) -> Node {
    loop {
        let unwrapped = ast::skip_parentheses(node);
        if matches!(
            unwrapped.kind(),
            SyntaxKind::PropertyAccessExpression
                | SyntaxKind::ElementAccessExpression
                | SyntaxKind::CallExpression
        ) {
            node = unwrapped.expression();
        } else {
            return node;
        }
    }
}

/// tsgolint's side effect test. `await` is allowed: `(await foo).bar` can
/// chain, and `compare_nodes` rejects `(await foo) && (await foo).bar`.
fn has_side_effects(node: Node) -> bool {
    if node.is_nil() {
        return false;
    }
    match node.kind() {
        SyntaxKind::PrefixUnaryExpression => matches!(
            node.operator(),
            SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
        ),
        SyntaxKind::PostfixUnaryExpression | SyntaxKind::YieldExpression => true,
        SyntaxKind::BinaryExpression => matches!(
            node.operator_token().kind(),
            SyntaxKind::EqualsToken
                | SyntaxKind::PlusEqualsToken
                | SyntaxKind::MinusEqualsToken
                | SyntaxKind::AsteriskEqualsToken
                | SyntaxKind::SlashEqualsToken
        ),
        SyntaxKind::PropertyAccessExpression
        | SyntaxKind::CallExpression
        | SyntaxKind::ParenthesizedExpression => has_side_effects(node.expression()),
        SyntaxKind::ElementAccessExpression => {
            has_side_effects(node.expression()) || has_side_effects(node.argument_expression())
        }
        _ => false,
    }
}

impl Processor<'_, '_, '_> {
    pub(super) fn compare_nodes(&mut self, left: Node, right: Node) -> NodeComparison {
        if has_side_effects(left) || has_side_effects(right) {
            return NodeComparison::Invalid;
        }

        // Standalone calls (`getFoo()`), `new` expressions and literals make
        // a new value each time. Method calls (`foo.bar()`) and expressions
        // that already have an optional chain are fine.
        let left_unwrapped = ast::skip_parentheses(left);
        if !self.contains_optional_chain(left) {
            let root = access_chain_root(left_unwrapped);
            let is_rooted_in_new =
                root.is_some() && ast::is_new_expression(ast::skip_parentheses(root));
            let is_standalone_call = match left_unwrapped.kind() {
                SyntaxKind::CallExpression => {
                    ast::is_identifier(ast::skip_parentheses(left_unwrapped.expression()))
                }
                SyntaxKind::NewExpression => true,
                _ => false,
            };
            let creates_value = matches!(
                left_unwrapped.kind(),
                SyntaxKind::ArrayLiteralExpression
                    | SyntaxKind::ObjectLiteralExpression
                    | SyntaxKind::FunctionExpression
                    | SyntaxKind::ArrowFunction
                    | SyntaxKind::ClassExpression
                    | SyntaxKind::JsxElement
                    | SyntaxKind::JsxSelfClosingElement
                    | SyntaxKind::JsxFragment
                    | SyntaxKind::TemplateExpression
                    | SyntaxKind::AwaitExpression
            );
            if is_standalone_call || is_rooted_in_new || creates_value {
                return NodeComparison::Invalid;
            }
        }

        // `foo.bar(a) && foo.bar(b).baz` calls with other arguments.
        let left_signatures = self.call_signatures(left);
        let right_signatures = self.call_signatures(right);
        let mismatched = left_signatures.iter().any(|(callee, call)| {
            right_signatures
                .get(callee)
                .is_some_and(|other| other != call)
        });
        if mismatched {
            return NodeComparison::Invalid;
        }

        if are_nodes_structurally_equal(left, right) {
            NodeComparison::Equal
        } else if is_node_prefix_of(left, right) {
            NodeComparison::Subset
        } else if is_node_prefix_of(right, left) {
            NodeComparison::Superset
        } else {
            NodeComparison::Invalid
        }
    }

    /// Callee text to call text for each call in the access chain of `node`.
    fn call_signatures(&mut self, node: Node) -> Rc<FxHashMap<String, String>> {
        if let Some(cached) = self.state.call_signature_cache.get(&node) {
            return cached.clone();
        }
        let mut signatures = FxHashMap::default();
        let mut current = node;
        while current.is_some() {
            match current.kind() {
                SyntaxKind::CallExpression => {
                    let callee = current.expression();
                    signatures.insert(self.node_text(callee), self.node_text(current));
                    current = callee;
                }
                SyntaxKind::PropertyAccessExpression
                | SyntaxKind::ElementAccessExpression
                | SyntaxKind::NonNullExpression => current = current.expression(),
                _ => break,
            }
        }
        let signatures = Rc::new(signatures);
        self.state
            .call_signature_cache
            .insert(node, signatures.clone());
        signatures
    }

    pub(super) fn contains_optional_chain(&mut self, node: Node) -> bool {
        if node.is_nil() {
            return false;
        }
        if let Some(&cached) = self.state.optional_chain_cache.get(&node) {
            return cached;
        }
        let unwrapped = ast::skip_parentheses(node);
        let result = match unwrapped.kind() {
            SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::CallExpression => {
                unwrapped.question_dot_token().is_some()
                    || self.contains_optional_chain(unwrapped.expression())
            }
            SyntaxKind::BinaryExpression => {
                self.contains_optional_chain(unwrapped.left())
                    || self.contains_optional_chain(unwrapped.right())
            }
            _ => false,
        };
        self.state.optional_chain_cache.insert(node, result);
        result
    }
}
