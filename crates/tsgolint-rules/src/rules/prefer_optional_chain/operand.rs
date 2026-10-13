//! Operands of a logical chain: what each one checks, and on which
//! expression.

use goport_core::ast;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;

use super::compare::unwrap_for_comparison;
use crate::utils::{
    is_access_expression, is_null_literal, is_nullish_literal, is_undefined_identifier,
    is_undefined_literal,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum OperandType {
    Invalid,
    Plain,
    NotStrictEqualNull,
    NotStrictEqualUndef,
    /// `!= null` or `!= undefined`, which checks both.
    NotEqualBoth,
    Not,
    NegatedAndOperand,
    TypeofCheck,
    Comparison,
    /// `== null` or `== undefined`, which checks both.
    EqualNull,
    StrictEqualNull,
    StrictEqualUndef,
}

impl OperandType {
    pub(super) fn is_nullish_check(self) -> bool {
        matches!(
            self,
            Self::NotStrictEqualNull
                | Self::NotStrictEqualUndef
                | Self::NotEqualBoth
                | Self::StrictEqualNull
                | Self::EqualNull
                | Self::StrictEqualUndef
                | Self::TypeofCheck
        )
    }

    pub(super) fn is_strict_nullish_check(self) -> bool {
        matches!(self, Self::NotStrictEqualNull | Self::NotStrictEqualUndef)
    }

    pub(super) fn is_loose_nullish_check(self) -> bool {
        matches!(self, Self::NotEqualBoth | Self::EqualNull)
    }

    pub(super) fn is_trailing_comparison(self) -> bool {
        matches!(
            self,
            Self::NotStrictEqualNull
                | Self::NotStrictEqualUndef
                | Self::NotEqualBoth
                | Self::Comparison
        )
    }

    pub(super) fn is_comparison_or_null_check(self) -> bool {
        self == Self::Comparison || self.is_nullish_check()
    }

    /// `!== null` style checks for null (the null half of a split pair).
    pub(super) fn is_strict_not_null(self) -> bool {
        self == Self::NotStrictEqualNull
    }

    /// `!== undefined` or `typeof x !== 'undefined'` (the undefined half of a
    /// split pair).
    pub(super) fn is_strict_not_undefined(self) -> bool {
        matches!(self, Self::NotStrictEqualUndef | Self::TypeofCheck)
    }

    /// Whether `self` and `other` are the null and the undefined half of a
    /// split strict check, in either order.
    pub(super) fn complements(self, other: Self) -> bool {
        (self.is_strict_not_null() && other.is_strict_not_undefined())
            || (self.is_strict_not_undefined() && other.is_strict_not_null())
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Operand {
    pub kind: OperandType,
    pub node: Node,
    /// The checked expression; nil for invalid operands.
    pub compared: Node,
}

impl Operand {
    pub(super) fn invalid(node: Node) -> Self {
        Self {
            kind: OperandType::Invalid,
            node,
            compared: Node::NIL,
        }
    }

    fn new(kind: OperandType, node: Node, compared: Node) -> Self {
        Self {
            kind,
            node,
            compared,
        }
    }
}

/// A binary expression with its operands' parentheses skipped.
pub(super) struct BinaryParts {
    pub operator: SyntaxKind,
    pub left: Node,
    pub right: Node,
}

pub(super) fn unwrap_binary(node: Node) -> Option<BinaryParts> {
    if node.is_nil() {
        return None;
    }
    let unwrapped = ast::skip_parentheses(node);
    if !ast::is_binary_expression(unwrapped) {
        return None;
    }
    Some(BinaryParts {
        operator: unwrapped.operator_token().kind(),
        left: ast::skip_parentheses(unwrapped.left()),
        right: ast::skip_parentheses(unwrapped.right()),
    })
}

/// A `==`/`===` comparison with a side that matches `predicate`.
fn is_comparison_against(op: &Operand, predicate: fn(Node) -> bool) -> bool {
    if op.kind != OperandType::Comparison {
        return false;
    }
    let Some(bin) = unwrap_binary(op.node) else {
        return false;
    };
    matches!(
        bin.operator,
        SyntaxKind::EqualsEqualsToken | SyntaxKind::EqualsEqualsEqualsToken
    ) && (predicate(bin.left) || predicate(bin.right))
}

pub(super) fn is_nullish_comparison(op: &Operand) -> bool {
    is_comparison_against(op, is_nullish_literal)
}

pub(super) fn is_strict_null_comparison(op: &Operand) -> bool {
    is_comparison_against(op, is_null_literal)
}

fn is_strict_comparison_against(op: &Operand, predicate: fn(Node) -> bool) -> bool {
    unwrap_binary(op.node).is_some_and(|bin| {
        bin.operator == SyntaxKind::EqualsEqualsEqualsToken
            && (predicate(bin.left) || predicate(bin.right))
    })
}

pub(super) fn is_strict_null_check_for_or_chain(op: &Operand) -> bool {
    match op.kind {
        OperandType::StrictEqualNull | OperandType::NotStrictEqualNull => true,
        OperandType::Comparison => is_strict_comparison_against(op, is_null_literal),
        _ => false,
    }
}

pub(super) fn is_strict_undefined_check_for_or_chain(op: &Operand) -> bool {
    match op.kind {
        OperandType::StrictEqualUndef
        | OperandType::NotStrictEqualUndef
        | OperandType::TypeofCheck => true,
        OperandType::Comparison => is_strict_comparison_against(op, is_undefined_literal),
        _ => false,
    }
}

pub(super) fn is_or_chain_nullish_check(op: &Operand) -> bool {
    match op.kind {
        OperandType::StrictEqualNull | OperandType::StrictEqualUndef | OperandType::EqualNull => {
            true
        }
        OperandType::Comparison => is_nullish_comparison(op),
        _ => false,
    }
}

/// A nullish check other than `typeof`.
pub(super) fn is_nullish_check_operand(op: &Operand) -> bool {
    match op.kind {
        OperandType::NotStrictEqualNull
        | OperandType::NotStrictEqualUndef
        | OperandType::NotEqualBoth
        | OperandType::StrictEqualNull
        | OperandType::StrictEqualUndef
        | OperandType::EqualNull => true,
        OperandType::Comparison => unwrap_binary(op.node).is_some_and(|bin| {
            is_null_literal(bin.right)
                || is_undefined_identifier(bin.right)
                || is_null_literal(bin.left)
                || is_undefined_identifier(bin.left)
        }),
        _ => false,
    }
}

pub(super) fn is_non_nullish_trailing_comparison(op: &Operand) -> bool {
    op.kind == OperandType::Comparison && !is_nullish_comparison(op)
}

/// Which of null and undefined the checks of a chain cover. An optional
/// chain checks both, so a chain that checks only one is not equivalent.
#[derive(Default)]
pub(super) struct NullishCheckAnalysis {
    pub has_null_check: bool,
    pub has_undefined_check: bool,
    pub has_both_check: bool,
}

impl NullishCheckAnalysis {
    /// `or_chain`: `=== null` style checks (true) or `!== null` (false).
    pub(super) fn of(chain: &[Operand], or_chain: bool) -> Self {
        let mut analysis = Self::default();
        for op in chain {
            match op.kind {
                OperandType::NotStrictEqualNull | OperandType::StrictEqualNull => {
                    analysis.has_null_check = true;
                }
                OperandType::NotStrictEqualUndef
                | OperandType::StrictEqualUndef
                | OperandType::TypeofCheck => analysis.has_undefined_check = true,
                OperandType::NotEqualBoth | OperandType::EqualNull => {
                    analysis.has_both_check = true;
                }
                OperandType::Not if or_chain => analysis.has_both_check = true,
                OperandType::Plain if !or_chain => analysis.has_both_check = true,
                OperandType::Comparison => {
                    if let Some(bin) = unwrap_binary(op.node) {
                        let is_null = is_null_literal(bin.left) || is_null_literal(bin.right);
                        let is_undefined =
                            is_undefined_literal(bin.left) || is_undefined_literal(bin.right);
                        if bin.operator == SyntaxKind::EqualsEqualsToken
                            && (is_null || is_undefined)
                        {
                            analysis.has_both_check = true;
                        } else if bin.operator == SyntaxKind::EqualsEqualsEqualsToken {
                            analysis.has_null_check |= is_null;
                            analysis.has_undefined_check |= is_undefined;
                        }
                    }
                }
                _ => {}
            }
        }
        analysis
    }

    pub(super) fn has_only_null_check(&self) -> bool {
        self.has_null_check && !self.has_undefined_check && !self.has_both_check
    }

    pub(super) fn has_only_undefined_check(&self) -> bool {
        !self.has_null_check && self.has_undefined_check && !self.has_both_check
    }

    pub(super) fn has_incomplete_check(&self) -> bool {
        self.has_only_null_check() || self.has_only_undefined_check()
    }
}

fn is_identifier_or_this(node: Node) -> bool {
    ast::is_identifier(node) || node.kind() == SyntaxKind::ThisKeyword
}

/// Classifies one operand of an `operator` chain.
pub(super) fn parse_operand(node: Node, operator: SyntaxKind) -> Operand {
    let is_and = operator == SyntaxKind::AmpersandAmpersandToken;
    let unwrapped = unwrap_for_comparison(node);

    // Bare `this` is never nullish; `this.foo` can be.
    if unwrapped.kind() == SyntaxKind::ThisKeyword {
        return Operand::invalid(node);
    }

    let mut base = unwrapped;
    while matches!(
        base.kind(),
        SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::CallExpression
            | SyntaxKind::NonNullExpression
            | SyntaxKind::ParenthesizedExpression
            | SyntaxKind::AsExpression
            | SyntaxKind::TypeAssertionExpression
    ) {
        base = base.expression();
    }
    if ast::is_binary_expression(base)
        && matches!(
            base.operator_token().kind(),
            SyntaxKind::AmpersandAmpersandToken | SyntaxKind::BarBarToken
        )
    {
        return Operand::invalid(node);
    }

    if ast::is_binary_expression(unwrapped)
        && let Some(op) = parse_nullish_check(node, unwrapped, is_and)
    {
        return op;
    }

    if ast::is_prefix_unary_expression(unwrapped)
        && unwrapped.operator() == SyntaxKind::ExclamationToken
    {
        let operand = unwrapped.operand();
        if operand.kind() == SyntaxKind::ThisKeyword {
            return Operand::invalid(node);
        }
        let kind = if is_and {
            OperandType::NegatedAndOperand
        } else {
            OperandType::Not
        };
        return Operand::new(kind, node, operand);
    }

    if ast::is_binary_expression(unwrapped) {
        if matches!(
            unwrapped.operator_token().kind(),
            SyntaxKind::LessThanToken
                | SyntaxKind::GreaterThanToken
                | SyntaxKind::LessThanEqualsToken
                | SyntaxKind::GreaterThanEqualsToken
                | SyntaxKind::InKeyword
                | SyntaxKind::InstanceOfKeyword
        ) {
            return Operand::invalid(node);
        }
        let left = ast::skip_parentheses(unwrapped.left());
        let right = ast::skip_parentheses(unwrapped.right());
        let left_is_access = is_access_expression(left);
        let right_is_access = is_access_expression(right);
        // `x && y && x.a === y.a` must keep both guards.
        if left_is_access && right_is_access {
            return Operand::invalid(node);
        }
        // Only comparisons that inspect an access can extend a chain.
        if !left_is_access && !right_is_access {
            return Operand::invalid(node);
        }
        let compared = if right_is_access { right } else { left };
        return Operand::new(OperandType::Comparison, node, compared);
    }

    Operand::new(OperandType::Plain, node, unwrapped)
}

/// A comparison against `null`, `undefined` or `typeof x` against a string.
fn parse_nullish_check(node: Node, binary: Node, is_and: bool) -> Option<Operand> {
    let op = binary.operator_token().kind();
    let (left, right) = (binary.left(), binary.right());
    let (expr, value) = if is_nullish_literal(right) || ast::is_string_literal(right) {
        (left, right)
    } else if is_nullish_literal(left) || ast::is_string_literal(left) {
        (right, left)
    } else {
        return None;
    };
    let expr = ast::skip_parentheses(expr);

    if ast::is_type_of_expression(expr)
        && ast::is_string_literal(value)
        && value.text() == "undefined"
    {
        let typeof_check = Operand::new(OperandType::TypeofCheck, node, expr.expression());
        let is_not_equal = matches!(
            op,
            SyntaxKind::ExclamationEqualsEqualsToken | SyntaxKind::ExclamationEqualsToken
        );
        let is_equal = matches!(
            op,
            SyntaxKind::EqualsEqualsEqualsToken | SyntaxKind::EqualsEqualsToken
        );
        if (is_not_equal && is_and) || (is_equal && !is_and) {
            return Some(typeof_check);
        }
    }

    let is_null = is_null_literal(value);
    let is_undefined = is_undefined_literal(value);
    let check = |kind| Some(Operand::new(kind, node, expr));

    if is_and {
        match op {
            SyntaxKind::ExclamationEqualsEqualsToken if is_null => {
                check(OperandType::NotStrictEqualNull)
            }
            SyntaxKind::ExclamationEqualsEqualsToken if is_undefined => {
                check(OperandType::NotStrictEqualUndef)
            }
            SyntaxKind::ExclamationEqualsToken if is_null || is_undefined => {
                check(OperandType::NotEqualBoth)
            }
            SyntaxKind::EqualsEqualsEqualsToken if is_identifier_or_this(expr) && is_null => {
                check(OperandType::StrictEqualNull)
            }
            SyntaxKind::EqualsEqualsEqualsToken if is_identifier_or_this(expr) && is_undefined => {
                check(OperandType::StrictEqualUndef)
            }
            SyntaxKind::EqualsEqualsToken
                if (is_null || is_undefined) && is_identifier_or_this(expr) =>
            {
                check(OperandType::EqualNull)
            }
            _ => None,
        }
    } else {
        // In an OR chain, `x === null` guards like `x !== null` does in an
        // AND chain, so tsgolint gives them the AND chain kinds.
        let is_access = is_access_expression(expr);
        if is_access {
            return if is_null || is_undefined {
                check(OperandType::Comparison)
            } else {
                None
            };
        }
        match op {
            SyntaxKind::EqualsEqualsEqualsToken if is_null => {
                check(OperandType::NotStrictEqualNull)
            }
            SyntaxKind::EqualsEqualsEqualsToken if is_undefined => {
                check(OperandType::NotStrictEqualUndef)
            }
            SyntaxKind::EqualsEqualsToken if is_null || is_undefined => {
                check(OperandType::NotEqualBoth)
            }
            _ => None,
        }
    }
}
