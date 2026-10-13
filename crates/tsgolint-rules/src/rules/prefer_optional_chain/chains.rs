//! Grouping the operands of a logical expression into chains that guard one
//! access chain.

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;

use super::Processor;
use super::compare::{NodeComparison, access_chain_root, is_node_prefix_of};
use super::operand::{
    Operand, OperandType, is_non_nullish_trailing_comparison, is_nullish_comparison,
    is_or_chain_nullish_check, unwrap_binary,
};
use crate::utils::is_nullish_literal;

/// A chain being built.
#[derive(Default)]
struct Builder {
    chains: Vec<Vec<Operand>>,
    current: Vec<Operand>,
    /// The kind of the chain's first operand, then of its last nullish
    /// check. None for a plain truthiness check.
    last_check: Option<OperandType>,
    complete: bool,
}

impl Builder {
    /// Keeps the current chain if it has two operands or more.
    fn flush(&mut self) {
        let current = std::mem::take(&mut self.current);
        if current.len() >= 2 {
            self.chains.push(current);
        }
    }

    /// Starts a new chain at `op`.
    fn restart(&mut self, op: Operand) {
        self.flush();
        self.current = vec![op];
        self.last_check = (op.kind != OperandType::Plain).then_some(op.kind);
        self.complete = false;
    }
}

impl Processor<'_, '_, '_> {
    pub(super) fn build_and_chains(&mut self, operands: &[Operand]) -> Vec<Vec<Operand>> {
        let mut b = Builder::default();
        let mut i = 0;
        while i < operands.len() {
            let op = operands[i];

            if matches!(
                op.kind,
                OperandType::Invalid
                    | OperandType::NegatedAndOperand
                    | OperandType::EqualNull
                    | OperandType::StrictEqualNull
                    | OperandType::StrictEqualUndef
            ) {
                b.flush();
                b.last_check = None;
                b.complete = false;
                i += 1;
                continue;
            }

            if b.current.is_empty() {
                if !is_non_nullish_trailing_comparison(&op) {
                    b.restart(op);
                }
                i += 1;
                continue;
            }

            if b.complete {
                b.restart(op);
                i += 1;
                continue;
            }

            let prev = *b.current.last().unwrap();
            let mut cmp = self.compare_nodes(prev.compared, op.compared);
            if self.should_stop_at_strict_nullish_check(&prev) {
                b.flush();
                break;
            }

            if cmp == NodeComparison::Invalid
                && self.should_allow_call_chain_extension(&prev, &op, true)
                && self.try_extend_through_call_expression(
                    prev.compared,
                    &op,
                    b.current[0].compared,
                    true,
                )
            {
                cmp = NodeComparison::Subset;
            }

            // `x !== null && x !== undefined` checks one expression twice.
            if cmp == NodeComparison::Equal
                && i + 1 < operands.len()
                && let Some(pair) = self.try_merge_complementary_pair(&op, &operands[i + 1])
            {
                b.current.extend(pair);
                i += 2;
                continue;
            }

            if op.kind.is_nullish_check()
                && let Some(last_check) = b.last_check
                && !are_nullish_checks_consistent(last_check, op.kind)
            {
                b.flush();
                break;
            }

            if matches!(cmp, NodeComparison::Subset | NodeComparison::Equal) {
                b.current.push(op);
                if op.kind.is_nullish_check() {
                    b.last_check = Some(op.kind);
                }
                if is_non_nullish_trailing_comparison(&op) {
                    b.complete = true;
                }
                i += 1;
                continue;
            }

            b.restart(op);
            i += 1;
        }
        b.flush();

        // `foo && foo.bar && foo.bar` checks the last access twice.
        let mut chains = b.chains;
        for chain in &mut chains {
            while chain.len() >= 2 {
                let last = chain[chain.len() - 1];
                let second_last = chain[chain.len() - 2];
                if last.kind == OperandType::Plain
                    && second_last.kind == OperandType::Plain
                    && self.compare_nodes(second_last.compared, last.compared)
                        == NodeComparison::Equal
                {
                    chain.pop();
                    continue;
                }
                break;
            }
        }
        chains
    }

    pub(super) fn build_or_chains(&mut self, operands: &[Operand]) -> Vec<Vec<Operand>> {
        let mut chain: Vec<Operand> = Vec::new();

        for &op in operands {
            if !is_valid_or_operand(&op) {
                if chain.len() >= 2 {
                    break;
                }
                chain.clear();
                continue;
            }

            if chain.is_empty() {
                if !is_invalid_or_chain_starting_operand(&op) {
                    chain.push(op);
                }
                continue;
            }

            let prev = *chain.last().unwrap();
            let mut cmp = self.compare_nodes(prev.compared, op.compared);
            if cmp == NodeComparison::Invalid
                && self.should_allow_call_chain_extension(&prev, &op, false)
                && self.try_extend_through_call_expression(prev.compared, &op, Node::NIL, false)
            {
                cmp = NodeComparison::Subset;
            }

            if matches!(cmp, NodeComparison::Subset | NodeComparison::Equal) {
                if cmp == NodeComparison::Equal
                    && op.kind == OperandType::Comparison
                    && !is_nullish_comparison(&op)
                {
                    // A non-nullish comparison of the same expression does not
                    // extend a chain that has no access to guard
                    // (`x === 'a' || x === 'b'`).
                    let last_is_non_nullish_comparison =
                        prev.kind == OperandType::Comparison && !is_nullish_comparison(&prev);
                    if matches!(
                        prev.kind,
                        OperandType::Not
                            | OperandType::NotStrictEqualNull
                            | OperandType::NotStrictEqualUndef
                            | OperandType::NotEqualBoth
                            | OperandType::Plain
                    ) || last_is_non_nullish_comparison
                    {
                        if chain.len() >= 2 {
                            break;
                        }
                        if last_is_non_nullish_comparison {
                            chain.clear();
                            continue;
                        }
                    }
                }
                chain.push(op);
                continue;
            }

            if chain.len() >= 2 {
                break;
            }
            chain = vec![op];
        }

        if chain.len() < 2 {
            Vec::new()
        } else {
            vec![chain]
        }
    }

    /// A strict check of a call or element access that does not cover the
    /// type's nullish members ends an AND chain.
    fn should_stop_at_strict_nullish_check(&mut self, prev: &Operand) -> bool {
        if !prev.kind.is_strict_nullish_check() || prev.compared.is_nil() {
            return false;
        }
        let unwrapped = ast::skip_parentheses(prev.compared);
        let is_call_or_new =
            ast::is_call_expression(unwrapped) || ast::is_new_expression(unwrapped);
        let is_element_access = ast::is_element_access_expression(unwrapped);
        if !is_call_or_new && !is_element_access {
            return false;
        }

        let is_any_or_unknown = self.type_is_any_or_unknown(prev.compared);
        let info = self.type_info(prev.compared);
        let has_null = info.has_null || info.is_any_or_unknown();
        let has_undefined = info.has_undefined || info.is_any_or_unknown();
        let is_incomplete = !is_any_or_unknown && has_null && has_undefined;
        let is_mismatched = !is_any_or_unknown && !has_undefined && !has_null;

        if is_call_or_new {
            is_incomplete || is_mismatched
        } else {
            is_mismatched || (is_incomplete && !self.unsafe_fixes_allowed())
        }
    }

    /// `x !== null && x !== undefined` on one expression.
    fn try_merge_complementary_pair(
        &mut self,
        first: &Operand,
        second: &Operand,
    ) -> Option<[Operand; 2]> {
        if first.compared.is_nil() || second.compared.is_nil() {
            return None;
        }
        if self.compare_nodes(first.compared, second.compared) != NodeComparison::Equal {
            return None;
        }
        let complementary = first.kind.complements(second.kind);
        complementary.then_some([*first, *second])
    }

    /// Lets a chain extend through a call when `compare_nodes` rejects it:
    /// AND chains of plain checks, OR chains of negations or of nullish
    /// comparisons.
    fn should_allow_call_chain_extension(
        &self,
        prev: &Operand,
        current: &Operand,
        is_and: bool,
    ) -> bool {
        if self.unsafe_fixes_allowed() {
            return true;
        }
        if is_and {
            return prev.kind == OperandType::Plain && current.kind == OperandType::Plain;
        }
        let is_negation_chain = prev.kind == OperandType::Not && current.kind == OperandType::Not;
        let is_nullish_comparison_chain =
            is_or_chain_nullish_check(prev) && is_or_chain_nullish_check(current);
        is_negation_chain || is_nullish_comparison_chain
    }

    /// The last expression is a call that `current` extends.
    fn try_extend_through_call_expression(
        &mut self,
        last_expr: Node,
        current: &Operand,
        first_expr: Node,
        is_and: bool,
    ) -> bool {
        if last_expr.is_nil() {
            return false;
        }
        let last = ast::skip_parentheses(last_expr);
        if !ast::is_call_expression(last) && !ast::is_new_expression(last) {
            return false;
        }
        // Each `new X()` is a new instance.
        if is_and && first_expr.is_some() {
            let root = access_chain_root(first_expr);
            if root.is_some() && ast::is_new_expression(ast::skip_parentheses(root)) {
                return false;
            }
        }
        is_node_prefix_of(last_expr, current.compared)
    }
}

fn is_valid_or_operand(op: &Operand) -> bool {
    !matches!(
        op.kind,
        OperandType::Invalid | OperandType::NegatedAndOperand
    )
}

/// `foo != null || foo.bar` has the opposite meaning of an optional chain,
/// and `foo.bar === false || ...` compares with a non-nullish value.
fn is_invalid_or_chain_starting_operand(op: &Operand) -> bool {
    if op.kind != OperandType::Comparison {
        return false;
    }
    let Some(bin) = unwrap_binary(op.node) else {
        return false;
    };
    let left_nullish = is_nullish_literal(bin.left);
    let right_nullish = is_nullish_literal(bin.right);
    if bin.operator == SyntaxKind::EqualsEqualsEqualsToken && !left_nullish && !right_nullish {
        return true;
    }
    if !matches!(
        bin.operator,
        SyntaxKind::ExclamationEqualsToken | SyntaxKind::ExclamationEqualsEqualsToken
    ) || (!left_nullish && !right_nullish)
    {
        return false;
    }
    let checked = if right_nullish { bin.left } else { bin.right };
    ast::is_identifier(checked) || checked.kind() == SyntaxKind::ThisKeyword
}

fn are_nullish_checks_consistent(first: OperandType, second: OperandType) -> bool {
    if first.is_loose_nullish_check() || second.is_loose_nullish_check() {
        return true;
    }
    let is_null = |kind| {
        matches!(
            kind,
            OperandType::NotStrictEqualNull | OperandType::StrictEqualNull
        )
    };
    let is_undefined = |kind| {
        matches!(
            kind,
            OperandType::NotStrictEqualUndef
                | OperandType::StrictEqualUndef
                | OperandType::TypeofCheck
        )
    };
    // A null check and an undefined check complement each other, and two
    // checks of the same kind agree.
    (is_null(first) || is_undefined(first)) && (is_null(second) || is_undefined(second))
}
