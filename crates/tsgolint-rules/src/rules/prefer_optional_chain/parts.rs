//! The access chain of an expression as parts: its root, `.name`, `[arg]`
//! and `(args)` links.

use std::cell::RefCell;
use std::rc::Rc;

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;

use super::{Parts, Processor};

/// One link of an access chain: the root, `.name`, `[arg]` or `(args)`.
#[derive(Clone, Debug)]
pub(super) struct ChainPart {
    pub text: String,
    pub optional: bool,
    pub requires_dot: bool,
    pub is_private: bool,
    pub has_non_null: bool,
    pub is_call: bool,
}

impl ChainPart {
    fn new(text: String) -> Self {
        Self {
            text,
            optional: false,
            requires_dot: false,
            is_private: false,
            has_non_null: false,
            is_call: false,
        }
    }

    /// The text without its `!`.
    pub(super) fn base_text(&self) -> &str {
        if self.has_non_null && self.text.ends_with('!') {
            &self.text[..self.text.len() - 1]
        } else {
            &self.text
        }
    }
}

impl Processor<'_, '_, '_> {
    /// The access chain of `node` as parts, cached per node.
    pub(super) fn flatten(&mut self, node: Node) -> Parts {
        if let Some(parts) = self.state.flatten_cache.get(&node) {
            return parts.clone();
        }
        let mut parts = Vec::new();
        self.flatten_into(node, false, &mut parts);
        let parts = Rc::new(RefCell::new(parts));
        self.state.flatten_cache.insert(node, parts.clone());
        parts
    }

    pub(super) fn flatten_len(&mut self, node: Node) -> usize {
        self.flatten(node).borrow().len()
    }

    fn flatten_into(&self, node: Node, parent_is_non_null: bool, parts: &mut Vec<ChainPart>) {
        match node.kind() {
            SyntaxKind::ParenthesizedExpression => {
                let inner = node.expression();
                if ast::is_await_expression(inner) || ast::is_yield_expression(inner) {
                    parts.push(ChainPart::new(self.node_text(node)));
                } else {
                    self.flatten_into(inner, parent_is_non_null, parts);
                }
            }
            SyntaxKind::NonNullExpression => self.flatten_into(node.expression(), true, parts),
            SyntaxKind::PropertyAccessExpression => {
                self.flatten_into(node.expression(), false, parts);
                let name = node.name();
                let mut text = self.node_text(name);
                if parent_is_non_null {
                    text.push('!');
                }
                parts.push(ChainPart {
                    optional: node.question_dot_token().is_some(),
                    requires_dot: true,
                    is_private: name.kind() == SyntaxKind::PrivateIdentifier,
                    has_non_null: parent_is_non_null,
                    ..ChainPart::new(text)
                });
            }
            SyntaxKind::ElementAccessExpression => {
                self.flatten_into(node.expression(), false, parts);
                let suffix = if parent_is_non_null { "!" } else { "" };
                let text = format!("[{}]{suffix}", self.node_text(node.argument_expression()));
                parts.push(ChainPart {
                    optional: node.question_dot_token().is_some(),
                    has_non_null: parent_is_non_null,
                    ..ChainPart::new(text)
                });
            }
            SyntaxKind::CallExpression => {
                self.flatten_into(node.expression(), false, parts);
                let type_arguments = node.type_argument_list();
                let mut text = String::new();
                if type_arguments.is_some() && !type_arguments.nodes().is_empty() {
                    text = format!(
                        "<{}>",
                        self.slice(type_arguments.pos(), type_arguments.end())
                    );
                }
                let arguments = node.argument_list();
                if arguments.is_some() && !arguments.nodes().is_empty() {
                    text.push('(');
                    text.push_str(&self.slice(arguments.pos(), node.end() - 1));
                    text.push(')');
                } else {
                    text.push_str("()");
                }
                parts.push(ChainPart {
                    optional: node.question_dot_token().is_some(),
                    is_call: true,
                    ..ChainPart::new(text)
                });
            }
            _ => {
                let mut text = self.node_text(node);
                if parent_is_non_null && ast::is_identifier(node) {
                    text.push('!');
                }
                if matches!(
                    node.kind(),
                    SyntaxKind::AsExpression | SyntaxKind::TypeAssertionExpression
                ) {
                    text = format!("({text})");
                }
                parts.push(ChainPart {
                    has_non_null: parent_is_non_null,
                    ..ChainPart::new(text)
                });
            }
        }
    }
}
