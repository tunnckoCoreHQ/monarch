//! Filters for chains whose optional chain form would change the result or
//! that are already as short as they get.

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;

use super::Processor;
use super::compare::{NodeComparison, are_nodes_structurally_equal, get_base_identifier};
use super::operand::{
    NullishCheckAnalysis, Operand, OperandType, is_nullish_comparison, is_strict_null_comparison,
    unwrap_binary,
};
use crate::utils::{
    is_access_expression, is_null_literal, is_undefined_identifier, is_undefined_literal,
};

impl Processor<'_, '_, '_> {
    pub(super) fn validate_chain_for_reporting(
        &mut self,
        chain: Vec<Operand>,
        is_and: bool,
    ) -> Option<Vec<Operand>> {
        if chain.len() < 2
            || !has_same_base_identifier(&chain)
            || !has_property_access_in_chain(&chain)
            || self.should_skip_for_require_nullish(&chain, is_and)
        {
            return None;
        }
        if is_and {
            self.validate_and_chain(chain)
        } else {
            self.validate_or_chain(chain)
        }
    }

    fn should_skip_for_require_nullish(&mut self, chain: &[Operand], is_and: bool) -> bool {
        if !self.state.opts.require_nullish {
            return false;
        }
        if !is_and && chain[0].kind == OperandType::Not {
            return true;
        }
        for (i, op) in chain.iter().enumerate() {
            if op.kind != OperandType::Plain {
                return false;
            }
            if is_and
                && i < chain.len() - 1
                && op.compared.is_some()
                && self.type_info(op.compared).has_explicit_nullish()
            {
                return false;
            }
        }
        true
    }

    fn validate_and_chain(&mut self, chain: Vec<Operand>) -> Option<Vec<Operand>> {
        let first = chain[0];
        if first.kind == OperandType::Plain && self.contains_optional_chain(first.compared) {
            return None;
        }
        if first.kind.is_strict_nullish_check()
            && self.contains_optional_chain(first.compared)
            && !is_split_strict_equals_pattern(&chain)
        {
            return None;
        }
        // `x !== undefined && x !== null` is already optimal.
        if self.all_operands_check_same_expression(&chain) {
            return None;
        }
        if self.should_skip_optimal_strict_checks(&chain) {
            return None;
        }

        if chain.len() == 2 && self.contains_optional_chain(chain[1].compared) {
            let second = chain[1];
            let first_parts = self.flatten(first.compared);
            let second_expr = if second.compared.is_some() {
                second.compared
            } else {
                second.node
            };
            let second_parts = self.flatten(second_expr);
            let first_parts = first_parts.borrow();
            let second_parts = second_parts.borrow();

            // `foo && foo?.bar`: the second operand checks the first again.
            let is_redundant_check = second_parts.len() == first_parts.len() + 1
                && first_parts
                    .iter()
                    .zip(second_parts.iter())
                    .all(|(a, b)| a.text == b.text && a.optional == b.optional)
                && second_parts.last().is_some_and(|part| part.optional);

            if !is_redundant_check
                && second_parts.len() > first_parts.len()
                && !first_parts.is_empty()
                && first_parts
                    .iter()
                    .zip(second_parts.iter())
                    .all(|(a, b)| a.text == b.text)
                && second_parts[first_parts.len()..].iter().any(|p| p.optional)
            {
                return None;
            }

            // `foo && foo?.id === null` to `foo?.id === null` changes the
            // result type from `foo | boolean` to `boolean`.
            if second.kind == OperandType::Comparison && is_redundant_check {
                return None;
            }
        }

        if first.kind == OperandType::Plain
            && first.compared.is_some()
            && self.has_void_type(first.compared)
        {
            return None;
        }

        if !self.unsafe_fixes_allowed() {
            if chain.iter().any(|op| ast::is_non_null_expression(op.node)) {
                return None;
            }
            if self.has_incomplete_nullish_check(&chain) {
                return None;
            }
        }

        for (i, op) in chain.iter().enumerate() {
            if op.kind == OperandType::Plain && i == 0 {
                if self.should_skip_by_type(op.compared) {
                    return None;
                }
                if self.would_change_return_type(op.compared) && !self.unsafe_fixes_allowed() {
                    return None;
                }
            }
            if op.kind == OperandType::TypeofCheck
                && op.compared.is_some()
                && !self.includes_nullish(op.compared)
                && chain.len() == 2
            {
                let last = chain[chain.len() - 1];
                if last.compared.is_some()
                    && ast::is_call_expression(ast::skip_parentheses(last.compared))
                {
                    return None;
                }
            }
        }

        let last = chain[chain.len() - 1];
        if self.is_unsafe_trailing_comparison(&chain, &last) {
            return None;
        }
        Some(chain)
    }

    /// An optional chain checks both null and undefined, so a chain that
    /// checks only one of them is not equivalent.
    fn has_incomplete_nullish_check(&mut self, chain: &[Operand]) -> bool {
        // A trailing comparison, or a trailing plain operand that reads
        // past the previous one, is not a guard.
        let guards = match chain {
            [.., prev, last]
                if last.kind.is_trailing_comparison()
                    || (last.kind == OperandType::Plain
                        && last.compared.is_some()
                        && prev.compared.is_some()
                        && self.flatten_len(last.compared) > self.flatten_len(prev.compared)) =>
            {
                &chain[..chain.len() - 1]
            }
            _ => chain,
        };

        let analysis = NullishCheckAnalysis::of(guards, false);
        let has_typeof_check = guards.iter().any(|op| op.kind == OperandType::TypeofCheck);
        let has_trailing = chain.len() >= 2 && guards.len() < chain.len();
        let last = chain[chain.len() - 1];
        let has_trailing_both_check = has_trailing && last.kind == OperandType::NotEqualBoth;
        let has_trailing_optional_chaining =
            has_trailing && last.compared.is_some() && self.contains_optional_chain(last.compared);

        let mut first_not_nullish = false;
        let mut strict_check_is_complete = false;
        if let Some(first) = guards.first().filter(|op| op.compared.is_some()) {
            first_not_nullish = !self.includes_nullish(first.compared);
            let info = self.type_info(first.compared);
            if !info.is_any_or_unknown() {
                let only_null = analysis.has_null_check && !analysis.has_undefined_check;
                let only_undefined = !analysis.has_null_check && analysis.has_undefined_check;
                strict_check_is_complete = (only_null && info.has_null && !info.has_undefined)
                    || (only_undefined && info.has_undefined && !info.has_null);
            }
        }

        !analysis.has_both_check
            && !has_typeof_check
            && !has_trailing_both_check
            && !has_trailing_optional_chaining
            && !first_not_nullish
            && !strict_check_is_complete
            && analysis.has_incomplete_check()
    }

    fn is_unsafe_trailing_comparison(&mut self, chain: &[Operand], last: &Operand) -> bool {
        let mut is_trailing_comparison = last.kind == OperandType::Comparison;
        if !is_trailing_comparison
            && chain.len() >= 2
            && matches!(
                last.kind,
                OperandType::NotStrictEqualNull
                    | OperandType::NotStrictEqualUndef
                    | OperandType::NotEqualBoth
            )
        {
            let prev = chain[chain.len() - 2];
            if last.compared.is_some()
                && prev.compared.is_some()
                && self.flatten_len(last.compared) > self.flatten_len(prev.compared)
            {
                is_trailing_comparison = true;
            }
        }
        if !is_trailing_comparison || last.node.is_nil() {
            return false;
        }

        let binary = ast::skip_parentheses(last.node);
        if !ast::is_binary_expression(binary) {
            return false;
        }
        let operator = binary.operator_token().kind();
        let left = ast::skip_parentheses(binary.left());
        let right = ast::skip_parentheses(binary.right());
        let value = if last.compared.is_some() && are_nodes_structurally_equal(last.compared, left)
        {
            right
        } else if last.compared.is_some() && are_nodes_structurally_equal(last.compared, right) {
            left
        } else if is_access_expression(left) {
            right
        } else if is_access_expression(right) {
            left
        } else {
            return false;
        };
        !self.is_safe_trailing_comparison_value(operator, value) && !self.unsafe_fixes_allowed()
    }

    /// The comparison gives the same result for `undefined` as the original
    /// chain gives for a nullish guard.
    fn is_safe_trailing_comparison_value(&mut self, operator: SyntaxKind, value: Node) -> bool {
        if value.is_nil() {
            return false;
        }
        let info = self.type_info(value);
        let checker = &*self.ctx.checker;
        match operator {
            SyntaxKind::EqualsEqualsToken => !info.can_be_nullish_like(),
            SyntaxKind::EqualsEqualsEqualsToken => !info.can_be_undefined_like(),
            SyntaxKind::ExclamationEqualsToken => info.is_always_nullish_like(checker),
            SyntaxKind::ExclamationEqualsEqualsToken => info.is_always_undefined_like(checker),
            SyntaxKind::LessThanToken
            | SyntaxKind::GreaterThanToken
            | SyntaxKind::LessThanEqualsToken
            | SyntaxKind::GreaterThanEqualsToken => false,
            _ => true,
        }
    }

    fn should_skip_by_type(&mut self, node: Node) -> bool {
        let info = self.type_info(get_base_identifier(node));
        let opts = &self.state.opts;
        if opts.require_nullish && info.has_explicit_nullish() {
            return false;
        }
        (info.has_any && !opts.check_any)
            || (info.has_big_int_like && !opts.check_big_int)
            || (info.has_boolean_like && !opts.check_boolean)
            || (info.has_number_like && !opts.check_number)
            || (info.has_string_like && !opts.check_string)
            || (info.has_unknown && !opts.check_unknown)
    }

    fn all_subsequent_have_optional_chaining(&mut self, chain: &[Operand]) -> bool {
        chain[1..]
            .iter()
            .all(|op| op.compared.is_nil() || self.contains_optional_chain(op.compared))
    }

    fn all_operands_check_same_expression(&mut self, chain: &[Operand]) -> bool {
        if chain.len() < 2 {
            return false;
        }
        let first = self.flatten(chain[0].compared);
        for op in &chain[1..] {
            let parts = self.flatten(op.compared);
            let first = first.borrow();
            let parts = parts.borrow();
            if parts.len() != first.len()
                || first
                    .iter()
                    .zip(parts.iter())
                    .any(|(a, b)| a.text != b.text)
            {
                return false;
            }
        }
        true
    }

    /// `foo?.bar !== undefined && foo?.bar !== null` style chains, already
    /// optional, that check only one of null and undefined on purpose.
    fn should_skip_optimal_strict_checks(&mut self, chain: &[Operand]) -> bool {
        if chain.len() < 2 || !self.all_subsequent_have_optional_chaining(chain) {
            return false;
        }
        let mut has_nullish_check = false;
        for op in chain {
            match op.kind {
                OperandType::Plain => continue,
                OperandType::Not | OperandType::NegatedAndOperand => return false,
                kind if kind.is_loose_nullish_check() => return false,
                kind if kind.is_strict_nullish_check() => has_nullish_check = true,
                _ => {}
            }
        }
        has_nullish_check
            && self
                .type_info(chain[0].compared)
                .has_both_null_and_undefined()
    }

    fn should_skip_or_chain_optimal_checks(&mut self, chain: &[Operand]) -> bool {
        if chain.len() < 2 || !self.all_subsequent_have_optional_chaining(chain) {
            return false;
        }
        let first = chain[0];
        if first.kind != OperandType::StrictEqualNull || first.compared.is_nil() {
            return false;
        }
        let info = self.type_info(first.compared);
        !info.has_undefined && !info.has_any && !info.has_unknown
    }

    fn validate_or_chain(&mut self, chain: Vec<Operand>) -> Option<Vec<Operand>> {
        let allow_unsafe = self.unsafe_fixes_allowed();
        if chain.iter().all(|op| op.kind == OperandType::Plain) {
            return None;
        }
        if self.should_skip_or_chain_optimal_checks(&chain) {
            return None;
        }
        // `foo.value === 'x' || foo.value === null` has no deeper access.
        if self.all_operands_check_same_expression(&chain) {
            return None;
        }

        let all_subsequent_optional = self.all_subsequent_have_optional_chaining(&chain);
        if all_subsequent_optional {
            let first = chain[0];
            let is_explicit_null_check = matches!(
                first.kind,
                OperandType::StrictEqualNull | OperandType::EqualNull
            ) || is_strict_null_comparison(&first);
            if is_explicit_null_check
                && !chain.iter().any(|op| {
                    op.compared.is_some() && self.type_info(op.compared).has_explicit_nullish()
                })
            {
                return None;
            }
        }

        let all_strict_checks = chain.iter().all(|op| {
            if op.kind.is_loose_nullish_check()
                || matches!(op.kind, OperandType::Plain | OperandType::Not)
            {
                return false;
            }
            if op.kind == OperandType::Comparison
                && ast::is_binary_expression(op.node)
                && op.node.operator_token().kind() == SyntaxKind::EqualsEqualsToken
            {
                let left = ast::skip_parentheses(op.node.left());
                let right = ast::skip_parentheses(op.node.right());
                let is_nullish = is_null_literal(left)
                    || is_null_literal(right)
                    || is_undefined_identifier(left)
                    || is_undefined_identifier(right);
                return !is_nullish;
            }
            true
        });
        if all_subsequent_optional && all_strict_checks {
            let (mut any_null, mut any_undefined) = (false, false);
            for op in &chain {
                if op.compared.is_some() {
                    let info = self.type_info(op.compared);
                    any_null |= info.has_null;
                    any_undefined |= info.has_undefined;
                }
            }
            if any_null == any_undefined {
                return None;
            }
        }

        if chain[0].kind == OperandType::Not && !allow_unsafe && chain[0].compared.is_some() {
            let first = ast::skip_parentheses(chain[0].compared);
            if !is_access_expression(first) {
                // `!foo || ...`: every later operand must be a negation, a safe
                // comparison or a nullish check.
                let mut has_intermediate_nullish_comparison = false;
                for (i, op) in chain.iter().enumerate().skip(1) {
                    let is_last = i == chain.len() - 1;
                    let is_comparison = op.kind == OperandType::Comparison;
                    let is_safe_comparison = is_comparison && is_or_chain_comparison_safe(op);
                    let is_intermediate_nullish_comparison =
                        is_comparison && is_nullish_comparison(op) && !is_last;
                    has_intermediate_nullish_comparison |= is_intermediate_nullish_comparison;
                    let is_allowed_plain_at_end = op.kind == OperandType::Plain
                        && is_last
                        && has_intermediate_nullish_comparison;
                    if op.kind != OperandType::Not
                        && !is_safe_comparison
                        && !is_intermediate_nullish_comparison
                        && !op.kind.is_nullish_check()
                        && !is_allowed_plain_at_end
                    {
                        return None;
                    }
                }
            } else if chain[1..]
                .iter()
                .any(|op| op.kind == OperandType::Comparison && !is_or_chain_comparison_safe(op))
            {
                return None;
            }
        }

        if !allow_unsafe
            && matches!(
                chain[0].kind,
                OperandType::NotEqualBoth
                    | OperandType::NotStrictEqualNull
                    | OperandType::NotStrictEqualUndef
            )
        {
            let first_info = self.type_info(chain[0].compared);
            for (i, op) in chain.iter().enumerate().skip(1) {
                if op.kind != OperandType::Comparison || is_or_chain_comparison_safe(op) {
                    continue;
                }
                let is_last = i == chain.len() - 1;
                if is_last && is_nullish_comparison(op) {
                    if first_info.has_both_null_and_undefined() || first_info.is_any_or_unknown() {
                        return None;
                    }
                } else if !is_nullish_comparison(op) {
                    return None;
                }
            }
        }

        if chain[0].kind == OperandType::Plain && chain[0].compared.is_some() {
            let first = ast::skip_parentheses(chain[0].compared);
            if first.kind() == SyntaxKind::MetaProperty {
                return None;
            }
            // `foo || foo.bar === x` compares a value that `foo` decides.
            if !allow_unsafe
                && !is_access_expression(first)
                && chain[1..]
                    .iter()
                    .any(|op| op.kind == OperandType::Comparison)
            {
                return None;
            }
        }

        let chain = self.validate_or_chain_nullish_checks(chain)?;

        if !allow_unsafe && self.has_unsafe_strict_nullish_guard_with_negated_access(&chain) {
            return None;
        }

        for op in &chain {
            if matches!(op.kind, OperandType::Plain | OperandType::Not)
                && self.would_change_return_type(op.compared)
                && !allow_unsafe
            {
                return None;
            }
        }

        // `!foo || foo()` calls what it negated.
        for i in 0..chain.len() - 1 {
            if chain[i].kind != OperandType::Not {
                continue;
            }
            let negated = chain[i].compared;
            for op in &chain[i + 1..] {
                if op.kind == OperandType::Not || op.compared.is_nil() {
                    continue;
                }
                let call = ast::skip_parentheses(op.compared);
                if ast::is_call_expression(call)
                    && self.compare_nodes(negated, call.expression()) == NodeComparison::Equal
                {
                    return None;
                }
            }
        }

        Some(chain)
    }

    fn validate_or_chain_nullish_checks(
        &mut self,
        mut chain: Vec<Operand>,
    ) -> Option<Vec<Operand>> {
        if self.unsafe_fixes_allowed() {
            return Some(chain);
        }

        let analysis = NullishCheckAnalysis::of(&chain, true);
        let first_not_nullish =
            chain[0].compared.is_some() && !self.includes_nullish(chain[0].compared);
        let last = chain[chain.len() - 1];
        let has_trailing_optional_chaining = chain.len() >= 2
            && last.compared.is_some()
            && self.contains_optional_chain(last.compared);
        let strict_check_is_complete = self.strict_checks_match_types(&chain, &analysis);

        if !analysis.has_both_check
            && !first_not_nullish
            && !has_trailing_optional_chaining
            && !strict_check_is_complete
            && analysis.has_incomplete_check()
        {
            return None;
        }

        // A strict check of a value that can be null and undefined ends the
        // chain after the first one.
        let mut truncate_at: Option<usize> = None;
        for (i, op) in chain.iter().enumerate() {
            if i == chain.len() - 1
                || op.compared.is_nil()
                || self.contains_optional_chain(op.compared)
            {
                continue;
            }
            if !self.type_info(op.compared).has_both_null_and_undefined() {
                continue;
            }
            let truncates = match op.kind {
                OperandType::NotStrictEqualNull
                | OperandType::NotStrictEqualUndef
                | OperandType::StrictEqualNull
                | OperandType::StrictEqualUndef => true,
                OperandType::Comparison => {
                    let binary = ast::skip_parentheses(op.node);
                    ast::is_binary_expression(binary)
                        && binary.operator_token().kind() == SyntaxKind::EqualsEqualsEqualsToken
                        && {
                            let (left, right) = (binary.left(), binary.right());
                            let is_null = is_null_literal(right) || is_null_literal(left);
                            let is_undefined =
                                is_undefined_literal(right) || is_undefined_literal(left);
                            is_null != is_undefined
                        }
                }
                _ => false,
            };
            if truncates {
                truncate_at = Some(i + 1);
                break;
            }
        }
        if let Some(at) = truncate_at.filter(|&at| at < chain.len()) {
            chain.truncate(at);
        }
        if chain.len() < 2 {
            return None;
        }

        // After a nullish guard (`typeof foo === 'undefined' || ...`), every
        // later operand must give the same result for undefined.
        let is_nullish_guard_start = matches!(
            chain[0].kind,
            OperandType::TypeofCheck
                | OperandType::StrictEqualNull
                | OperandType::StrictEqualUndef
                | OperandType::EqualNull
        );
        if is_nullish_guard_start
            && chain[1..].iter().any(|op| {
                (op.kind == OperandType::Comparison && !is_or_chain_comparison_safe(op))
                    || matches!(op.kind, OperandType::Plain | OperandType::Not)
            })
        {
            return None;
        }

        if analysis.has_null_check
            && !analysis.has_undefined_check
            && !analysis.has_both_check
            && !strict_check_is_complete
        {
            return None;
        }

        // `contract.bidFiles === null || contract.bidFiles.trim() === ''`
        // compares with a non-nullish value.
        if chain[0].kind == OperandType::Comparison
            && is_nullish_comparison(&chain[0])
            && chain[1..].iter().any(|op| {
                op.kind == OperandType::Comparison
                    && !is_or_chain_comparison_safe(op)
                    && !is_nullish_comparison(op)
            })
        {
            return None;
        }

        Some(chain)
    }

    /// Every nullable operand's type has exactly the nullish member that the
    /// strict checks of the chain test.
    pub(super) fn strict_checks_match_types(
        &mut self,
        chain: &[Operand],
        analysis: &NullishCheckAnalysis,
    ) -> bool {
        let mut has_nullable_operand = false;
        for op in chain {
            if op.compared.is_nil() {
                continue;
            }
            let info = self.type_info(op.compared);
            if info.has_no_nullable_types() {
                continue;
            }
            has_nullable_operand = true;
            if info.is_any_or_unknown() || info.has_both_null_and_undefined() {
                return false;
            }
            // Here the type has exactly one of null and undefined.
            let null_mismatch = !info.has_null && info.has_undefined;
            let undefined_mismatch = info.has_null && !info.has_undefined;
            if (analysis.has_only_null_check() && null_mismatch)
                || (analysis.has_only_undefined_check() && undefined_mismatch)
            {
                return false;
            }
        }
        has_nullable_operand
    }

    /// `foo !== null || !foo.bar` where foo can also be undefined.
    fn has_unsafe_strict_nullish_guard_with_negated_access(&mut self, chain: &[Operand]) -> bool {
        for (i, guard) in chain.iter().enumerate().take(chain.len() - 1) {
            if guard.compared.is_nil() || !guard.kind.is_strict_nullish_check() {
                continue;
            }
            let info = self.type_info(guard.compared);
            if !info.is_any_or_unknown() && !info.has_both_null_and_undefined() {
                continue;
            }
            for candidate in &chain[i + 1..] {
                if candidate.kind != OperandType::Not || candidate.compared.is_nil() {
                    continue;
                }
                let cmp = self.compare_nodes(guard.compared, candidate.compared);
                if !matches!(cmp, NodeComparison::Equal | NodeComparison::Subset) {
                    continue;
                }
                let negated = ast::skip_parentheses(candidate.compared);
                if matches!(
                    negated.kind(),
                    SyntaxKind::CallExpression
                        | SyntaxKind::PropertyAccessExpression
                        | SyntaxKind::ElementAccessExpression
                ) {
                    return true;
                }
            }
        }
        false
    }
}

fn has_property_access_in_chain(chain: &[Operand]) -> bool {
    chain
        .iter()
        .any(|op| op.compared.is_some() && is_access_expression(ast::skip_parentheses(op.compared)))
}

fn has_same_base_identifier(chain: &[Operand]) -> bool {
    let mut first_base = Node::NIL;
    for op in chain {
        if op.compared.is_nil() {
            continue;
        }
        let base = get_base_identifier(op.compared);
        if first_base.is_nil() {
            first_base = base;
        } else if !are_nodes_structurally_equal(first_base, base) {
            return false;
        }
    }
    true
}

fn is_split_strict_equals_pattern(chain: &[Operand]) -> bool {
    if chain.len() != 2 {
        return false;
    }
    let (first, last) = (chain[0].kind, chain[1].kind);
    first.complements(last)
}

/// In an OR chain, the comparison gives the same result when the guarded
/// value is undefined. `!= null` is unsafe: `undefined != null` is false.
fn is_or_chain_comparison_safe(op: &Operand) -> bool {
    if op.kind != OperandType::Comparison {
        return true;
    }
    let Some(bin) = unwrap_binary(op.node) else {
        return true;
    };
    let value = if is_access_expression(bin.left) {
        bin.right
    } else if is_access_expression(bin.right) {
        bin.left
    } else {
        return true;
    };
    let is_null = is_null_literal(value);
    let is_undefined = is_undefined_literal(value);
    let is_literal = matches!(
        value.kind(),
        SyntaxKind::NumericLiteral
            | SyntaxKind::StringLiteral
            | SyntaxKind::TrueKeyword
            | SyntaxKind::FalseKeyword
            | SyntaxKind::ObjectLiteralExpression
            | SyntaxKind::ArrayLiteralExpression
    );
    match bin.operator {
        // `undefined !== undefined` is false.
        SyntaxKind::ExclamationEqualsEqualsToken => is_literal || is_null,
        SyntaxKind::EqualsEqualsEqualsToken => is_undefined,
        SyntaxKind::ExclamationEqualsToken => !is_null && !is_undefined && is_literal,
        SyntaxKind::EqualsEqualsToken => is_null || is_undefined,
        // `undefined <= 100` is false.
        SyntaxKind::LessThanToken
        | SyntaxKind::GreaterThanToken
        | SyntaxKind::LessThanEqualsToken
        | SyntaxKind::GreaterThanEqualsToken => false,
        _ => true,
    }
}
