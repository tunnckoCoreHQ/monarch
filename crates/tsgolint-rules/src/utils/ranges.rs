//! Text ranges for reports and fixes (tsgolint `utils.go`, `await.go`,
//! `ts_eslint.go`). Positions are UTF-8 byte offsets into the source text.
//!
//! A node's `pos()` includes its leading trivia, as in Go. These helpers
//! trim it the way tsgolint does.

use goport_core::ast::{self, NodeFactory, TextRange, source_file_text};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::frontend::scanner::{get_leading_comment_ranges, get_trailing_comment_ranges};
use goport_core::printer::CommentRange;
use goport_core::scanner_util::{
    SkipTriviaOptions, get_token_pos_of_node, is_valid_identifier, skip_trivia_ex,
};
use tsgolint_core::RuleFix;
use tsgolint_core::text::node_text;

use super::nodes::is_higher_precedence_than_await;

pub use tsgolint_core::text::{token_range_at, trim_node_text_range};

/// The comments that start in `range`: first the trailing comment ranges at
/// `range.pos()`, then the leading ones at the same position.
///
/// Like tsgolint, this can list a comment twice (once as trailing and once
/// as leading). Callers that only test for a comment use
/// [`has_comments_in_range`].
pub fn get_comments_in_range(source_file: Node, range: TextRange) -> Vec<CommentRange> {
    let text = source_file_text(source_file);
    let factory = NodeFactory::new();
    let in_range = |comment: &CommentRange| comment.pos() < range.end();
    let mut comments: Vec<CommentRange> = get_trailing_comment_ranges(&factory, &text, range.pos())
        .into_iter()
        .take_while(in_range)
        .collect();
    comments.extend(
        get_leading_comment_ranges(&factory, &text, range.pos())
            .into_iter()
            .take_while(in_range),
    );
    comments
}

/// Whether a comment starts in `range`.
pub fn has_comments_in_range(source_file: Node, range: TextRange) -> bool {
    let text = source_file_text(source_file);
    let factory = NodeFactory::new();
    let starts_in_range = |comments: Vec<CommentRange>| {
        comments
            .first()
            .is_some_and(|comment| comment.pos() < range.end())
    };
    starts_in_range(get_trailing_comment_ranges(&factory, &text, range.pos()))
        || starts_in_range(get_leading_comment_ranges(&factory, &text, range.pos()))
}

/// The range of the token at `pos` (an `await` keyword) plus the whitespace
/// after it, but not the comments after it.
pub fn get_await_token_removal_range(source_file: Node, pos: i32) -> TextRange {
    let token = token_range_at(source_file, pos);
    let text = source_file_text(source_file);
    let end = skip_trivia_ex(
        &text,
        token.end(),
        Some(&SkipTriviaOptions {
            stop_at_comments: true,
            ..Default::default()
        }),
    );
    token.with_end(end)
}

/// The fixes that put `await` before `node`, with parentheses around `node`
/// unless it binds tighter than `await`.
pub fn insert_await_fixes(source_file: Node, node: Node) -> Vec<RuleFix> {
    if is_higher_precedence_than_await(node) {
        vec![RuleFix::insert_before(source_file, node, "await ")]
    } else {
        vec![
            RuleFix::insert_before(source_file, node, "await ("),
            RuleFix::insert_after(node, ")"),
        ]
    }
}

/// typescript-eslint `getForStatementHeadLoc`: a `for`, `for-in` or `for-of`
/// statement up to its body.
pub fn get_for_statement_head_loc(source_file: Node, node: Node) -> TextRange {
    trim_node_text_range(source_file, node).with_end(node.statement().pos())
}

/// typescript-eslint `getFunctionHeadLoc`.
///
/// For an arrow function, the `=>` token (its full range, as in tsgolint).
/// For other function-like nodes, from the first modifier that is not a
/// decorator (or the first token) to the `(` of the parameter list.
pub fn get_function_head_loc(source_file: Node, node: Node) -> TextRange {
    if ast::is_arrow_function(node) {
        let arrow = node.equals_greater_than_token();
        if arrow.is_some() {
            return arrow.loc();
        }
    }
    let params = node.parameter_list();
    if params.is_nil() {
        return trim_node_text_range(source_file, node);
    }
    // The parameter list starts right after `(`.
    let end = params.pos() - 1;

    let modifiers = node.modifiers();
    let first_modifier = if modifiers.is_nil() {
        None
    } else {
        modifiers
            .nodes()
            .into_iter()
            .find(|m| m.kind() != SyntaxKind::Decorator)
    };
    let start = get_token_pos_of_node(first_modifier.unwrap_or(node), source_file, false);
    if end < start {
        return trim_node_text_range(source_file, node);
    }
    TextRange::new(start, end)
}

/// How [`get_name_from_member`] spelled a member name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberNameType {
    Private,
    Quoted,
    Normal,
    Expression,
}

/// typescript-eslint `getNameFromMember`: the name of a member name node
/// (identifier, private identifier, computed name), with computed literal
/// names unwrapped and quoted when they are not identifiers.
pub fn get_name_from_member(source_file: Node, member: Node) -> (String, MemberNameType) {
    match member.kind() {
        SyntaxKind::Identifier => return (member.text().to_owned(), MemberNameType::Normal),
        SyntaxKind::PrivateIdentifier => {
            return (member.text().to_owned(), MemberNameType::Private);
        }
        SyntaxKind::ComputedPropertyName => {
            let expression = member.expression();
            if ast::is_literal_expression(expression) {
                let text = expression.text();
                if !is_valid_identifier(text) {
                    return (format!("\"{text}\""), MemberNameType::Quoted);
                }
                return (text.to_owned(), MemberNameType::Normal);
            }
        }
        _ => {}
    }
    (node_text(source_file, member), MemberNameType::Expression)
}
