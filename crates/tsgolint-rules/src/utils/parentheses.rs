//! When a replacement expression needs parentheses because of the token it
//! starts with (tsgolint `expression_parentheses.go`).

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::frontend::scanner::Scanner;

use super::ranges::trim_node_text_range;

/// Whether `node` starts an expression statement, so that a replacement
/// that starts with `{`, `class` or `function` would be parsed as a
/// statement. Walks up only through ancestors that start at the same token.
pub fn is_start_of_expression_statement_needing_parentheses(
    source_file: Node,
    node: Node,
    first_token: SyntaxKind,
) -> bool {
    if !matches!(
        first_token,
        SyntaxKind::OpenBraceToken | SyntaxKind::ClassKeyword | SyntaxKind::FunctionKeyword
    ) {
        return false;
    }
    let start = trim_node_text_range(source_file, node).pos();
    let mut ancestor = node.parent();
    while ancestor.is_some() && trim_node_text_range(source_file, ancestor).pos() == start {
        if ast::is_expression_statement(ancestor) {
            return true;
        }
        ancestor = ancestor.parent();
    }
    false
}

/// Whether `node` starts the concise body of an arrow function, so that a
/// replacement that starts with `{` would be parsed as a block.
pub fn is_start_of_arrow_function_body_needing_parentheses(
    source_file: Node,
    node: Node,
    first_token: SyntaxKind,
) -> bool {
    if first_token != SyntaxKind::OpenBraceToken {
        return false;
    }
    let mut current = node;
    while current.parent().is_some() {
        let parent = current.parent();
        if ast::is_parenthesized_expression(parent) {
            return false;
        }
        if ast::is_arrow_function(parent) && parent.body() == current {
            return true;
        }
        if trim_node_text_range(source_file, parent).pos()
            != trim_node_text_range(source_file, current).pos()
        {
            return false;
        }
        current = parent;
    }
    false
}

/// Whether the operand of `node` needs parentheses once the prefix of `node`
/// (an `await`, a `<T>` assertion) is removed: at the start of an arrow
/// function body or of an expression statement. `scanner` is at the first
/// token of the operand.
pub fn operand_needs_parentheses(source_file: Node, node: Node, scanner: &mut Scanner<'_>) -> bool {
    let first_token = scanner.token();
    // `async function` on one line starts a function declaration.
    let statement_start_token = if first_token == SyntaxKind::AsyncKeyword
        && scanner.scan() == SyntaxKind::FunctionKeyword
        && !scanner.has_preceding_line_break()
    {
        SyntaxKind::FunctionKeyword
    } else {
        first_token
    };
    is_start_of_arrow_function_body_needing_parentheses(source_file, node, first_token)
        || is_start_of_expression_statement_needing_parentheses(
            source_file,
            node,
            statement_start_token,
        )
}
