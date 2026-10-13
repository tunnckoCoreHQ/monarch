//! `prefer-optional-chain`: enforces optional chains over chained `&&`/`||`
//! checks and `(foo || {}).bar`.
//!
//! A logical chain is split into operands (`operand`), grouped into runs
//! that guard the same access chain (`chains`), filtered for patterns where
//! an optional chain changes the result (`validate`), and rewritten from
//! the parts of its access chain (`parts`, `fix`). Fixes that may change
//! the result type are suggestions unless
//! `allowPotentiallyUnsafeFixesThatModifyTheReturnTypeIKnowWhatImDoing` is on.

mod chains;
mod compare;
mod fix;
mod operand;
mod parts;
mod type_info;
mod validate;

use std::borrow::Cow;
use std::cell::RefCell;
use std::rc::Rc;

use goport_core::ast::{self, FileText};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::text_slice;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::is_property_or_element_access;
use parts::ChainPart;
use type_info::TypeInfo;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-optional-chain",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_potentially_unsafe_fixes_that_modify_the_return_type_i_know_what_im_doing: bool,
    check_any: bool,
    check_big_int: bool,
    check_boolean: bool,
    check_number: bool,
    check_string: bool,
    check_unknown: bool,
    require_nullish: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_potentially_unsafe_fixes_that_modify_the_return_type_i_know_what_im_doing: false,
            check_any: true,
            check_big_int: true,
            check_boolean: true,
            check_number: true,
            check_string: true,
            check_unknown: true,
            require_nullish: false,
        }
    }
}

fn prefer_optional_chain_message() -> RuleMessage {
    RuleMessage::new(
        "preferOptionalChain",
        "Prefer using an optional chain expression instead, as it's more concise and easier to read.",
    )
}

fn optional_chain_suggest_message() -> RuleMessage {
    RuleMessage::new("optionalChainSuggest", "Change to an optional chain.")
}

/// The flattened parts of an access chain. tsgolint caches the slice per
/// node and the fix builder edits it in place, so later reads of the same
/// node see the edits; the shared cell keeps that.
type Parts = Rc<RefCell<Vec<ChainPart>>>;

/// Per-file state: the options and the caches tsgolint keeps per file.
struct State {
    opts: Options,
    text: FileText,
    /// Trimmed ranges of the logical expressions already part of a chain.
    seen_ranges: FxHashSet<(i32, i32)>,
    type_cache: FxHashMap<Node, Rc<TypeInfo>>,
    flatten_cache: FxHashMap<Node, Parts>,
    call_signature_cache: FxHashMap<Node, Rc<FxHashMap<String, String>>>,
    optional_chain_cache: FxHashMap<Node, bool>,
}

/// The state and the context of one listener call.
struct Processor<'s, 'c, 'a> {
    state: &'s mut State,
    ctx: &'c mut RuleContext<'a>,
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let opts: Options = decode_options(options, RULE.name);
    Listeners::new(State {
        opts,
        text: ctx.source_text(),
        seen_ranges: FxHashSet::default(),
        type_cache: FxHashMap::default(),
        flatten_cache: FxHashMap::default(),
        call_signature_cache: FxHashMap::default(),
        optional_chain_cache: FxHashMap::default(),
    })
    .on(SyntaxKind::BinaryExpression, check_binary)
    .into()
}

fn check_binary(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let operator = node.operator_token().kind();
    if matches!(
        operator,
        SyntaxKind::AmpersandAmpersandToken
            | SyntaxKind::BarBarToken
            | SyntaxKind::QuestionQuestionToken
    ) {
        Processor { state, ctx }.process_chain(node, operator);
    }
}

impl Processor<'_, '_, '_> {
    fn unsafe_fixes_allowed(&self) -> bool {
        self.state
            .opts
            .allow_potentially_unsafe_fixes_that_modify_the_return_type_i_know_what_im_doing
    }

    fn node_range(&self, node: Node) -> ast::TextRange {
        self.ctx.trim_node_text_range(node)
    }

    fn slice(&self, pos: i32, end: i32) -> Cow<'_, str> {
        text_slice(&self.state.text, ast::TextRange::new(pos, end))
    }

    fn node_text(&self, node: Node) -> String {
        let range = self.node_range(node);
        self.slice(range.pos(), range.end()).into_owned()
    }

    fn report(&mut self, node: Node, fixes: Vec<RuleFix>, use_suggestion: bool) {
        self.ctx.report_node_with_fixes_or_suggestions(
            node,
            !use_suggestion,
            prefer_optional_chain_message(),
            optional_chain_suggest_message(),
            fixes,
        );
    }

    fn process_chain(&mut self, node: Node, operator: SyntaxKind) {
        if matches!(
            operator,
            SyntaxKind::BarBarToken | SyntaxKind::QuestionQuestionToken
        ) {
            self.handle_empty_object_pattern(node);
        }
        if operator == SyntaxKind::QuestionQuestionToken {
            return;
        }
        if is_inside_jsx(node) {
            return;
        }
        let range = self.node_range(node);
        if self.state.seen_ranges.contains(&(range.pos(), range.end())) {
            return;
        }

        let operand_nodes = self.collect_operands(node, operator);
        if operand_nodes.len() < 2 {
            return;
        }

        let is_and = operator == SyntaxKind::AmpersandAmpersandToken;
        let mut operands = Vec::with_capacity(operand_nodes.len());
        for (i, &operand_node) in operand_nodes.iter().enumerate() {
            let mut op = operand::parse_operand(operand_node, operator);
            let more_operands = i < operand_nodes.len() - 1;
            let disallow_falsy_literal = (is_and && op.kind == operand::OperandType::Plain)
                || (!is_and && op.kind == operand::OperandType::Not);
            // Truthiness guards narrow out non-nullish falsy literals and an
            // optional chain does not. The last operand is the result, so it
            // stays.
            if more_operands && disallow_falsy_literal && self.has_falsy_literal_type(op.compared) {
                op = operand::Operand::invalid(operand_node);
            }
            operands.push(op);
        }

        let chains = if is_and {
            self.build_and_chains(&operands)
        } else {
            self.build_or_chains(&operands)
        };
        for chain in chains {
            let Some(chain) = self.validate_chain_for_reporting(chain, is_and) else {
                continue;
            };
            if is_and {
                self.report_and_chain(node, &chain, operand_nodes.len());
            } else {
                self.report_or_chain(node, &chain, operand_nodes.len());
            }
        }
    }

    /// The operands of the `operator` chain at `node`, marking each nested
    /// expression of the same operator as seen.
    fn collect_operands(&mut self, node: Node, operator: SyntaxKind) -> Vec<Node> {
        let mut operands = Vec::new();
        self.collect_operands_into(node, operator, &mut operands);
        operands
    }

    fn collect_operands_into(&mut self, node: Node, operator: SyntaxKind, out: &mut Vec<Node>) {
        let unwrapped = ast::skip_parentheses(node);
        if ast::is_binary_expression(unwrapped) && unwrapped.operator_token().kind() == operator {
            self.collect_operands_into(unwrapped.left(), operator, out);
            self.collect_operands_into(unwrapped.right(), operator, out);
            let range = self.node_range(unwrapped);
            self.state.seen_ranges.insert((range.pos(), range.end()));
        } else {
            out.push(node);
        }
    }

    /// `(foo || {}).bar` and `(foo ?? {})[bar]`.
    fn handle_empty_object_pattern(&mut self, node: Node) {
        let right = node.right();
        let object = if ast::is_object_literal_expression(right) {
            right
        } else if ast::is_parenthesized_expression(right)
            && ast::is_object_literal_expression(right.expression())
        {
            right.expression()
        } else {
            return;
        };
        if !object.properties().is_empty() {
            return;
        }

        let left = node.left();
        if self.state.opts.require_nullish && !self.type_info(left).has_explicit_nullish() {
            return;
        }

        let parent = node.parent();
        let access = if is_property_or_element_access(parent) {
            parent
        } else if ast::is_parenthesized_expression(parent)
            && parent.parent().is_some()
            && is_property_or_element_access(parent.parent())
        {
            parent.parent()
        } else {
            return;
        };
        if access.question_dot_token().is_some() {
            return;
        }
        let (is_computed, property) = if ast::is_property_access_expression(access) {
            (false, access.name())
        } else {
            (true, access.argument_expression())
        };

        let mut left_text = self.node_text(left);
        let needs_parens = matches!(
            left.kind(),
            SyntaxKind::AwaitExpression
                | SyntaxKind::BinaryExpression
                | SyntaxKind::ConditionalExpression
                | SyntaxKind::PrefixUnaryExpression
                | SyntaxKind::AsExpression
                | SyntaxKind::VoidExpression
                | SyntaxKind::TypeOfExpression
                | SyntaxKind::PostfixUnaryExpression
                | SyntaxKind::DeleteExpression
        );
        if needs_parens {
            left_text = format!("({left_text})");
        }
        let mut property_text = self.node_text(property);
        if is_computed {
            property_text = format!("[{property_text}]");
        }
        let fix = RuleFix::replace_range(
            self.node_range(access),
            format!("{left_text}?.{property_text}"),
        );

        // `(foo || {}).bar` is `{}.bar` when foo is falsy, `foo?.bar` is undefined.
        let use_suggestion = !self.unsafe_fixes_allowed();
        self.report(access, vec![fix], use_suggestion);
    }
}

/// In JSX, `foo && foo.bar` renders `false`/`null` where `foo?.bar` gives
/// undefined.
fn is_inside_jsx(node: Node) -> bool {
    let mut current = node;
    while current.is_some() {
        if matches!(
            current.kind(),
            SyntaxKind::JsxExpression
                | SyntaxKind::JsxAttribute
                | SyntaxKind::JsxAttributes
                | SyntaxKind::JsxElement
                | SyntaxKind::JsxSelfClosingElement
                | SyntaxKind::JsxOpeningElement
                | SyntaxKind::JsxClosingElement
                | SyntaxKind::JsxFragment
        ) {
            return true;
        }
        current = current.parent();
    }
    false
}
