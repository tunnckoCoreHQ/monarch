//! Rewriting a chain as one optional chain, and reporting it.

use std::collections::BTreeSet;

use goport_core::ast::{self, TextRange};
use goport_core::core::Node;
use tsgolint_core::RuleFix;

use super::Processor;
use super::compare::NodeComparison;
use super::operand::{NullishCheckAnalysis, Operand, OperandType, is_nullish_check_operand};
use super::parts::ChainPart;

/// Joins `parts`, with `?.` before each part at a checked length.
fn build_optional_chain(
    parts: &[ChainPart],
    checked_lengths: &BTreeSet<usize>,
    call_should_be_optional: bool,
    strip_non_null_assertions: bool,
) -> String {
    let max_checked_length = checked_lengths.last().copied().unwrap_or(0);
    let mut optional_parts = vec![false; parts.len()];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            optional_parts[i] = checked_lengths.contains(&i)
                || part.optional
                || (part.is_call && i == parts.len() - 1 && call_should_be_optional);
        }
        // `foo?.#bar` is a syntax error.
        if optional_parts[i] && part.is_private {
            return String::new();
        }
    }

    let mut result = String::new();
    for (i, part) in parts.iter().enumerate() {
        let mut text = part.text.as_str();
        if strip_non_null_assertions
            && i < parts.len() - 1
            && optional_parts[i + 1]
            && part.has_non_null
            && i < max_checked_length
        {
            // tsgolint drops the last character whatever it is: the `!` of an
            // identifier, but the `)` of `(x as T)!` and the `s` of `this!`.
            let mut chars = text.chars();
            chars.next_back();
            text = chars.as_str();
        }
        if i > 0 {
            if optional_parts[i] || (part.optional && i > max_checked_length) {
                result.push_str("?.");
            } else if part.requires_dot {
                result.push('.');
            }
        }
        result.push_str(text);
    }
    result
}

impl Processor<'_, '_, '_> {
    /// The leading comments of the operands after the first, which the
    /// replacement would drop.
    fn leading_trivia(&self, chain: &[Operand]) -> String {
        let mut trivia = String::new();
        for op in &chain[1..] {
            let full_pos = op.node.pos();
            let trimmed_pos = self.node_range(op.node).pos();
            if full_pos < trimmed_pos {
                trivia.push_str(&self.slice(full_pos, trimmed_pos));
            }
        }
        trivia
            .trim_start_matches([' ', '\t', '\n', '\r'])
            .to_owned()
    }

    /// The range that the fix of `chain` replaces: the whole expression
    /// when the chain covers all of it.
    fn chain_range(
        &self,
        node: Node,
        chain: &[Operand],
        start: usize,
        operand_count: usize,
    ) -> TextRange {
        if start == 0 && chain.len() == operand_count {
            self.node_range(node)
        } else {
            TextRange::new(
                self.node_range(chain[start].node).pos(),
                self.node_range(chain[chain.len() - 1].node).end(),
            )
        }
    }

    /// `node`'s trimmed text between the end of `before` and `node`.
    fn text_after(&self, before: Node, node: Node) -> String {
        let start = self.node_range(before).end();
        let end = self.node_range(node).pos();
        format!("{}{}", self.slice(start, end), self.node_text(node))
    }

    pub(super) fn report_and_chain(&mut self, node: Node, chain: &[Operand], operand_count: usize) {
        let n = chain.len();
        let last = chain[n - 1];
        let second_last = chain[n - 2];

        // The last operand when the chain ends at the second-to-last one and
        // the last one stays as is:
        // - `x.y !== null && x.y !== undefined` (a complementary pair);
        // - `foo && foo.bar != null && foo.bar.baz !== undefined && foo.bar.baz.buzz`,
        //   which becomes `foo?.bar?.baz !== undefined && foo.bar.baz.buzz`.
        let mut trailing_operand: Option<Node> = None;
        let mut last_property_access = Node::NIL;
        let mut has_trailing_comparison = false;
        let mut has_trailing_typeof = false;

        if last.compared.is_some()
            && second_last.compared.is_some()
            && self.compare_nodes(last.compared, second_last.compared) == NodeComparison::Equal
            && last.kind.complements(second_last.kind)
        {
            trailing_operand = Some(last.node);
            last_property_access = second_last.compared;
            has_trailing_comparison = true;
            has_trailing_typeof = second_last.kind == OperandType::TypeofCheck;
        }
        let has_complementary = trailing_operand.is_some();

        if !has_complementary
            && n >= 3
            && last.kind == OperandType::Plain
            && second_last.kind.is_strict_nullish_check()
            && second_last.compared.is_some()
            && !self.has_matching_strict_check(chain)
        {
            let closest_loose_check = chain[..n - 2]
                .iter()
                .rev()
                .find(|op| op.kind.is_loose_nullish_check())
                .map(|op| op.compared);
            if let Some(closest) = closest_loose_check.filter(|c| c.is_some())
                && self.compare_nodes(closest, second_last.compared) == NodeComparison::Subset
            {
                trailing_operand = Some(last.node);
                last_property_access = second_last.compared;
                has_trailing_comparison = true;
            }
        }

        // Every operand of a chain has a checked expression, so the chain ends
        // at the last one.
        if trailing_operand.is_none() {
            if last.kind == OperandType::Plain {
                last_property_access = last.node;
            } else {
                last_property_access = last.compared;
                has_trailing_comparison =
                    last.kind.is_trailing_comparison() || last.kind == OperandType::TypeofCheck;
                has_trailing_typeof = last.kind == OperandType::TypeofCheck;
            }
        }
        if last_property_access.is_nil() {
            return;
        }

        let parts_cell = self.flatten(last_property_access);

        if chain[0].kind == OperandType::Plain && !parts_cell.borrow().is_empty() {
            let first_parts = self.flatten(chain[0].node);
            let first_part = {
                let first_parts = first_parts.borrow();
                (first_parts.len() == 1).then(|| first_parts[0].clone())
            };
            if let Some(first_part) = first_part {
                let mut parts = parts_cell.borrow_mut();
                if first_part.text.len() > parts[0].text.len() {
                    parts[0] = first_part;
                }
            }
        }

        let checks_to_consider: Vec<Operand> = chain
            .iter()
            .enumerate()
            .filter(|&(i, op)| {
                let is_last = i == n - 1;
                let is_call_access = op.compared.is_some() && ast::is_call_expression(op.compared);
                !(is_last
                    && (op.kind == OperandType::Plain
                        || (op.kind == OperandType::Not && is_call_access)))
            })
            .map(|(_, &op)| op)
            .collect();

        // `typeof` checks existence, not nullability: with other checks, it
        // does not make the next part optional.
        let has_non_typeof_check = checks_to_consider
            .iter()
            .any(|op| op.kind != OperandType::TypeofCheck && op.compared.is_some());
        let mut checked_lengths = BTreeSet::new();
        for op in &checks_to_consider {
            if op.compared.is_some()
                && !(op.kind == OperandType::TypeofCheck && has_non_typeof_check)
            {
                checked_lengths.insert(self.flatten_len(op.compared));
            }
        }

        // One check of the root makes each part up to the last access
        // optional.
        if checked_lengths.len() == 1 && checked_lengths.first() == Some(&1) {
            let fill_up_to = if last.kind == OperandType::Plain {
                let last_parts = self.flatten(last.node);
                let last_parts = last_parts.borrow();
                let mut fill = last_parts.len() as isize - 1;
                if fill > 0 && last_parts.last().is_some_and(|p| p.is_call) {
                    fill -= 1;
                }
                fill
            } else {
                1
            };
            for i in 1..=fill_up_to.max(0) as usize {
                checked_lengths.insert(i);
            }
        }

        if !checks_to_consider.is_empty() && parts_cell.borrow().len() > 1 {
            let max_checked_len = checks_to_consider
                .iter()
                .filter(|op| op.compared.is_some())
                .map(|op| self.flatten_len(op.compared))
                .max()
                .unwrap_or(0);
            {
                let mut parts = parts_cell.borrow_mut();
                for part in parts.iter_mut().take(max_checked_len) {
                    if part.has_non_null {
                        part.text = part.base_text().to_owned();
                        part.has_non_null = false;
                    }
                }
            }

            // The parts of each check that is a prefix of the chain.
            let mut prefixes: Vec<Vec<ChainPart>> = Vec::new();
            for op in &checks_to_consider {
                if op.compared.is_nil() {
                    continue;
                }
                let expr = if op.kind == OperandType::Plain {
                    op.node
                } else {
                    op.compared
                };
                let op_parts = self.flatten(expr);
                let op_parts = op_parts.borrow();
                let parts = parts_cell.borrow();
                if op_parts.len() <= parts.len()
                    && op_parts
                        .iter()
                        .zip(parts.iter())
                        .all(|(a, b)| a.base_text() == b.base_text())
                {
                    prefixes.push(op_parts.clone());
                }
            }

            // Each part takes `?.` and `!` from the shortest check that has it.
            let mut parts = parts_cell.borrow_mut();
            for (i, part) in parts.iter_mut().enumerate() {
                // The first of equally short ones, as tsgolint keeps it.
                let shortest = prefixes
                    .iter()
                    .filter(|prefix| i < prefix.len())
                    .min_by_key(|prefix| prefix.len());
                if let Some(shortest) = shortest {
                    part.optional = shortest[i].optional;
                    if shortest[i].has_non_null {
                        if !part.has_non_null {
                            part.text.push('!');
                        }
                        part.has_non_null = true;
                    }
                }
            }
        }

        let (parts_len, last_is_call) = {
            let parts = parts_cell.borrow();
            (parts.len(), parts.last().is_some_and(|p| p.is_call))
        };
        let call_should_be_optional = last_is_call
            && chain[..n - 1]
                .iter()
                .any(|op| op.compared.is_some() && self.flatten_len(op.compared) == parts_len - 1);

        let mut new_code = build_optional_chain(
            &parts_cell.borrow(),
            &checked_lengths,
            call_should_be_optional,
            false,
        );
        if new_code.is_empty() {
            return;
        }

        let trivia = self.leading_trivia(chain);
        if !trivia.is_empty() {
            new_code = trivia + &new_code;
        }

        if has_trailing_comparison {
            let comparison = if trailing_operand.is_some() {
                second_last
            } else {
                last
            };
            if ast::is_binary_expression(comparison.node) {
                let left_range = self.node_range(comparison.node.left());
                let compared_range = self.node_range(comparison.compared);
                let binary_end = self.node_range(comparison.node).end();
                if has_trailing_typeof {
                    new_code = format!(
                        "{}{new_code}{}",
                        self.slice(left_range.pos(), compared_range.pos()),
                        self.slice(compared_range.end(), binary_end)
                    );
                } else if compared_range.pos() > left_range.pos() {
                    // Yoda: `null !== foo.bar`.
                    let binary_start = self.node_range(comparison.node).pos();
                    new_code = format!(
                        "{}{new_code}",
                        self.slice(binary_start, compared_range.pos())
                    );
                } else {
                    new_code.push_str(&self.slice(compared_range.end(), binary_end));
                }
            }
            if let Some(trailing_operand) = trailing_operand {
                new_code.push_str(&self.text_after(second_last.node, trailing_operand));
            }
        }

        // `typeof foo !== 'undefined' && foo.bar` keeps the `typeof` guard
        // when foo is undeclared, which would throw a ReferenceError.
        let mut start = 0;
        if chain[0].kind == OperandType::TypeofCheck
            && chain[1..]
                .iter()
                .any(|op| op.kind != OperandType::TypeofCheck)
            && chain[0].compared.is_some()
        {
            let symbol = self
                .ctx
                .checker
                .get_symbol_at_location_exported(chain[0].compared);
            if symbol.is_nil() || self.ctx.checker.sym(symbol).declarations.is_empty() {
                start = 1;
            }
        }
        let range = self.chain_range(node, chain, start, operand_count);
        let fixes = vec![RuleFix::replace_range(range, new_code)];

        let mut use_suggestion = !self.unsafe_fixes_allowed();
        if use_suggestion {
            use_suggestion = !matches!(
                last.kind,
                OperandType::EqualNull
                    | OperandType::NotEqualBoth
                    | OperandType::StrictEqualUndef
                    | OperandType::NotStrictEqualUndef
                    | OperandType::TypeofCheck
            ) && !has_trailing_comparison;
            if use_suggestion {
                use_suggestion = !chain.iter().any(|op| {
                    op.compared.is_some() && {
                        let info = self.type_info(op.compared);
                        info.has_undefined || info.is_any_or_unknown()
                    }
                });
            }
            // `foo != null && foo.bar` drops a guard that is not a plain
            // truthiness check.
            let first = chain[0];
            if !use_suggestion
                && matches!(
                    first.kind,
                    OperandType::NotEqualBoth
                        | OperandType::NotStrictEqualNull
                        | OperandType::NotStrictEqualUndef
                )
                && last.kind == OperandType::Plain
                && first.compared.is_some()
                && !self.type_info(first.compared).is_any_or_unknown()
            {
                use_suggestion = true;
            }
            if has_complementary
                && (last.kind == OperandType::TypeofCheck
                    || second_last.kind == OperandType::NotStrictEqualNull)
            {
                use_suggestion = true;
            }
        }
        self.report(node, fixes, use_suggestion);
    }

    /// The strict check before the trailing plain operand has a complementary
    /// strict check of the same expression earlier in the chain.
    fn has_matching_strict_check(&mut self, chain: &[Operand]) -> bool {
        let n = chain.len();
        let second_last = chain[n - 2];
        for other in chain[..n - 2].iter().rev() {
            if other.compared.is_nil()
                || self.compare_nodes(other.compared, second_last.compared) != NodeComparison::Equal
            {
                continue;
            }
            let other_is_null = other.kind == OperandType::NotStrictEqualNull;
            let other_is_undefined = other.kind.is_strict_not_undefined();
            if (second_last.kind == OperandType::NotStrictEqualNull && other_is_undefined)
                || (second_last.kind == OperandType::NotStrictEqualUndef && other_is_null)
            {
                return true;
            }
        }
        false
    }

    pub(super) fn report_or_chain(&mut self, node: Node, chain: &[Operand], operand_count: usize) {
        let allow_unsafe = self.unsafe_fixes_allowed();
        let n = chain.len();
        let has_trailing_comparison = chain[n - 1].kind.is_comparison_or_null_check();

        // `foo == null || foo.bar == null || foo.bar.baz`: the last operand
        // stays as is after the optional chain.
        let mut trailing_plain = None;
        let mut chain_for_optional = chain;
        if n >= 3 && chain[n - 1].kind == OperandType::Plain && !allow_unsafe {
            let last = chain[n - 1];
            let second_last = chain[n - 2];
            if is_nullish_check_operand(&second_last)
                && last.compared.is_some()
                && second_last.compared.is_some()
                && self.flatten_len(last.compared) > self.flatten_len(second_last.compared)
            {
                trailing_plain = Some(self.node_text(last.node));
                chain_for_optional = &chain[..n - 1];
            }
        }

        if n == 2 {
            let first = chain[0];
            if self.contains_optional_chain(first.compared)
                || self.contains_optional_chain(first.node)
            {
                return;
            }
        }

        let last = chain_for_optional[chain_for_optional.len() - 1];
        let last_property_access = if last.kind == OperandType::Plain {
            last.node
        } else {
            last.compared
        };
        let parts_cell = self.flatten(last_property_access);

        let checks = if last.kind == OperandType::Plain {
            &chain_for_optional[..chain_for_optional.len() - 1]
        } else {
            chain_for_optional
        };
        let mut checked_lengths = BTreeSet::new();
        for op in checks {
            if op.compared.is_some() {
                checked_lengths.insert(self.flatten_len(op.compared));
            }
        }

        let (parts_len, last_is_call) = {
            let parts = parts_cell.borrow();
            (parts.len(), parts.last().is_some_and(|p| p.is_call))
        };
        let call_should_be_optional = last_is_call
            && chain_for_optional[..chain_for_optional.len() - 1]
                .iter()
                .any(|op| self.flatten_len(op.node) == parts_len - 1);

        let optional_chain = build_optional_chain(
            &parts_cell.borrow(),
            &checked_lengths,
            call_should_be_optional,
            true,
        );
        if optional_chain.is_empty() {
            return;
        }

        let mut new_code = if last.kind.is_comparison_or_null_check() {
            if ast::is_binary_expression(last.node) {
                let binary = last.node;
                let compared_range = self.node_range(last.compared);
                let left_range = self.node_range(binary.left());
                if compared_range.pos() > left_range.pos() {
                    // Yoda: `null === foo.bar` becomes `foo?.bar === null`.
                    let operator = self.node_text(binary.operator_token());
                    let value = self.node_text(binary.left());
                    format!("{optional_chain} {operator} {}", value.trim())
                } else {
                    let operator_start = binary.operator_token().pos();
                    let right_end = binary.right().end();
                    format!("{optional_chain}{}", self.slice(operator_start, right_end))
                }
            } else {
                optional_chain
            }
        } else if last.kind == OperandType::Not {
            // `!a || !a.b` is `!(a && a.b)`, so `!a?.b`.
            format!("!{optional_chain}")
        } else {
            optional_chain
        };

        if let Some(trailing_plain) = trailing_plain {
            let chain_end = self.node_range(chain[n - 2].node).end();
            let trailing_start = self.node_range(chain[n - 1].node).pos();
            new_code.push_str(&self.slice(chain_end, trailing_start));
            new_code.push_str(&trailing_plain);
        }

        let range = self.chain_range(node, chain, 0, operand_count);
        let fixes = vec![RuleFix::replace_range(range, new_code)];

        let mut use_suggestion = !allow_unsafe
            && !matches!(
                chain[n - 1].kind,
                OperandType::Not
                    | OperandType::EqualNull
                    | OperandType::NotEqualBoth
                    | OperandType::StrictEqualUndef
                    | OperandType::NotStrictEqualUndef
                    | OperandType::TypeofCheck
            );

        // A strict check of a type that has only that nullish member: the
        // optional chain also lets the other one through.
        if use_suggestion && has_trailing_comparison {
            let analysis = NullishCheckAnalysis::of(chain, true);
            let requires_suggestion = (analysis.has_incomplete_check()
                && self.strict_checks_match_types(chain, &analysis))
                || self.has_shorter_undefined_check_before_strict_null_comparison(chain);
            if !requires_suggestion {
                use_suggestion = false;
            }
        }

        if use_suggestion {
            for op in chain {
                if op.compared.is_some() {
                    let info = self.type_info(op.compared);
                    if info.is_any_or_unknown() || info.has_both_null_and_undefined() {
                        use_suggestion = false;
                        break;
                    }
                }
            }
        }

        self.report(node, fixes, use_suggestion);
    }

    /// The last operand is a strict null comparison and an earlier operand
    /// checks a shorter chain for undefined.
    fn has_shorter_undefined_check_before_strict_null_comparison(
        &mut self,
        chain: &[Operand],
    ) -> bool {
        if chain.len() < 2 {
            return false;
        }
        let last = chain[chain.len() - 1];
        if !super::operand::is_strict_null_check_for_or_chain(&last) || last.compared.is_nil() {
            return false;
        }
        let last_len = self.flatten_len(last.compared);
        for op in &chain[..chain.len() - 1] {
            if op.compared.is_nil() || !super::operand::is_strict_undefined_check_for_or_chain(op) {
                continue;
            }
            if self.flatten_len(op.compared) < last_len {
                return true;
            }
        }
        false
    }
}
