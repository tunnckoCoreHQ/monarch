//! `prefer-nullish-coalescing`: prefers `??` and `??=` over `||`, `||=`,
//! ternaries and `if` assignments that test for nullishness.

use goport_core::ast::{
    get_source_file_of_node, is_assignment_expression, is_binary_expression, is_block,
    is_call_expression, is_conditional_expression, is_element_access_expression,
    is_expression_statement, is_identifier, is_if_statement, is_logical_expression,
    is_optional_chain, is_parenthesized_expression, is_prefix_unary_expression,
    is_property_access_expression, skip_parentheses, source_file_info,
    walk_up_parenthesized_expressions,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    BoolOr, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion, decode_options,
};

use crate::utils::{
    intersection_type_parts, is_null_literal, is_null_literal_or_undefined_identifier,
    is_property_or_element_access, is_strong_precedence_node, is_type_flag_set,
    is_undefined_identifier, require_strict_null_checks, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-nullish-coalescing",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default)]
struct IgnorePrimitivesOptions {
    bigint: bool,
    boolean: bool,
    number: bool,
    string: bool,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    ignore_boolean_coercion: bool,
    ignore_conditional_tests: bool,
    ignore_if_statements: bool,
    ignore_mixed_logical_expressions: bool,
    ignore_primitives: BoolOr<IgnorePrimitivesOptions>,
    ignore_ternary_tests: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ignore_boolean_coercion: false,
            ignore_conditional_tests: true,
            ignore_if_statements: false,
            ignore_mixed_logical_expressions: false,
            ignore_primitives: BoolOr::Unset,
            ignore_ternary_tests: false,
        }
    }
}

struct State {
    options: Options,
    /// The primitive flags that `ignorePrimitives` excludes.
    ignorable_flags: TypeFlags,
}
fn prefer_nullish_over_or_message(description: &str, equals: &str) -> RuleMessage {
    RuleMessage::new(
        "preferNullishOverOr",
        format!(
            "Prefer using nullish coalescing operator (`??{equals}`) instead of a logical \
             {description} (`||{equals}`), as it is a safer operator."
        ),
    )
}

fn prefer_nullish_over_ternary_message() -> RuleMessage {
    RuleMessage::new(
        "preferNullishOverTernary",
        "Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.",
    )
}

fn prefer_nullish_over_assignment_message() -> RuleMessage {
    RuleMessage::new(
        "preferNullishOverAssignment",
        "Prefer using nullish coalescing operator (`??=`) instead of an assignment expression, as it is simpler to read.",
    )
}

fn suggest_nullish_coalescing_message() -> RuleMessage {
    RuleMessage::new(
        "suggestNullishCoalescing",
        "Change to the nullish coalescing operator.",
    )
}

/// The operator of a nullish test.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TestOperator {
    /// `x`
    Truthy,
    /// `!x`
    Not,
    /// `==`
    Equal,
    /// `===`
    StrictEqual,
    /// `!=`
    NotEqual,
    /// `!==`
    NotStrictEqual,
}

fn create(ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    require_strict_null_checks(ctx);

    let ignorable_flags = match &options.ignore_primitives {
        BoolOr::Bool(true) => {
            TypeFlags::BIG_INT_LIKE
                | TypeFlags::BOOLEAN_LIKE
                | TypeFlags::NUMBER_LIKE
                | TypeFlags::STRING_LIKE
        }
        BoolOr::Object(primitives) => {
            let mut flags = TypeFlags::NONE;
            for (ignore, flag) in [
                (primitives.bigint, TypeFlags::BIG_INT_LIKE),
                (primitives.boolean, TypeFlags::BOOLEAN_LIKE),
                (primitives.number, TypeFlags::NUMBER_LIKE),
                (primitives.string, TypeFlags::STRING_LIKE),
            ] {
                if ignore {
                    flags |= flag;
                }
            }
            flags
        }
        _ => TypeFlags::NONE,
    };

    Listeners::new(State {
        options,
        ignorable_flags,
    })
    .on(
        SyntaxKind::BinaryExpression,
        |state, ctx, node| match node.operator_token().kind() {
            SyntaxKind::BarBarToken => check_or(state, ctx, node, "or", ""),
            SyntaxKind::BarBarEqualsToken => check_or(state, ctx, node, "assignment", "="),
            _ => {}
        },
    )
    .on(SyntaxKind::ConditionalExpression, check_conditional)
    .on(SyntaxKind::IfStatement, check_if_statement)
    .into()
}

fn is_logical_or_operator(node: Node) -> bool {
    is_binary_expression(node)
        && node.operator_token().is_some()
        && matches!(
            node.operator_token().kind(),
            SyntaxKind::BarBarToken | SyntaxKind::BarBarEqualsToken
        )
}

fn is_member_access_like(node: Node) -> bool {
    let node = skip_parentheses(node);
    matches!(
        node.kind(),
        SyntaxKind::Identifier
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
    ) || is_optional_chain(node)
}

fn is_node_equal(a: Node, b: Node) -> bool {
    if a.is_nil() || b.is_nil() {
        return a == b;
    }
    if a.kind() != b.kind() {
        return false;
    }
    match a.kind() {
        SyntaxKind::Identifier
        | SyntaxKind::StringLiteral
        | SyntaxKind::NoSubstitutionTemplateLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral => a.text() == b.text(),
        SyntaxKind::PropertyAccessExpression => {
            // A private name is never equal here, as in tsgolint.
            is_node_equal(a.name(), b.name()) && is_node_equal(a.expression(), b.expression())
        }
        SyntaxKind::ElementAccessExpression => {
            is_node_equal(a.argument_expression(), b.argument_expression())
                && is_node_equal(a.expression(), b.expression())
        }
        SyntaxKind::NullKeyword | SyntaxKind::ThisKeyword => true,
        _ => false,
    }
}

/// The static property name of `x.a`, `x['a']` or ``x[`a`]``, else "".
/// `x['']` has the name "" too; tsgolint compares such accesses by node
/// when either name is "".
fn get_property_name_from_access(node: Node) -> &'static str {
    if is_property_access_expression(node) {
        let name = node.name();
        return if name.is_some() { name.text() } else { "" };
    }
    if is_element_access_expression(node) {
        let argument = node.argument_expression();
        if argument.is_some()
            && matches!(
                argument.kind(),
                SyntaxKind::StringLiteral | SyntaxKind::NoSubstitutionTemplateLiteral
            )
        {
            return argument.text();
        }
    }
    ""
}

/// Whether two expressions access the same member chain (`a.b` and
/// `a['b']` match).
fn are_nodes_similar_member_access(mut a: Node, mut b: Node) -> bool {
    while a.kind() == SyntaxKind::ParenthesizedExpression {
        a = a.expression();
    }
    while b.kind() == SyntaxKind::ParenthesizedExpression {
        b = b.expression();
    }
    if a.kind() == SyntaxKind::NonNullExpression {
        a = a.expression();
    }
    if b.kind() == SyntaxKind::NonNullExpression {
        b = b.expression();
    }

    if !is_property_or_element_access(a) || !is_property_or_element_access(b) {
        return is_node_equal(a, b);
    }
    let a_name = get_property_name_from_access(a);
    let b_name = get_property_name_from_access(b);
    if a_name.is_empty() || b_name.is_empty() {
        if a.kind() != b.kind() {
            return false;
        }
        if is_element_access_expression(a) && is_element_access_expression(b) {
            return are_nodes_similar_member_access(a.expression(), b.expression())
                && is_node_equal(a.argument_expression(), b.argument_expression());
        }
    }
    a_name == b_name && are_nodes_similar_member_access(a.expression(), b.expression())
}

fn is_conditional_test(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    if is_logical_expression(parent) || parent.kind() == SyntaxKind::ParenthesizedExpression {
        return is_conditional_test(parent);
    }
    if is_conditional_expression(parent)
        && (parent.when_true() == node || parent.when_false() == node)
    {
        return is_conditional_test(parent);
    }
    if is_comma_with_right(parent, node) || is_not_expression(parent) {
        return is_conditional_test(parent);
    }
    match parent.kind() {
        SyntaxKind::ConditionalExpression | SyntaxKind::ForStatement => parent.condition() == node,
        SyntaxKind::DoStatement | SyntaxKind::IfStatement | SyntaxKind::WhileStatement => {
            parent.expression() == node
        }
        _ => false,
    }
}

fn is_comma_with_right(parent: Node, node: Node) -> bool {
    parent.kind() == SyntaxKind::BinaryExpression
        && parent.operator_token().kind() == SyntaxKind::CommaToken
        && parent.right() == node
}

fn is_not_expression(node: Node) -> bool {
    is_prefix_unary_expression(node) && node.operator() == SyntaxKind::ExclamationToken
}

/// Whether `node` flows into a call of the global `Boolean`.
fn is_boolean_constructor_context(checker: &mut Checker, node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    if parent.kind() == SyntaxKind::ParenthesizedExpression || is_logical_expression(parent) {
        return is_boolean_constructor_context(checker, parent);
    }
    if is_conditional_expression(parent)
        && (parent.when_true() == node || parent.when_false() == node)
    {
        return is_boolean_constructor_context(checker, parent);
    }
    if is_comma_with_right(parent, node) {
        return is_boolean_constructor_context(checker, parent);
    }
    if is_call_expression(parent) {
        let callee = parent.expression();
        if is_identifier(callee) && callee.text() == "Boolean" {
            let symbol = checker.get_symbol_at_location_exported(callee);
            if symbol.is_some() {
                // A `Boolean` declared in a source file is not the global one.
                let user_defined = checker.sym(symbol).declarations.iter().any(|&declaration| {
                    let file = get_source_file_of_node(declaration);
                    file.is_some() && !source_file_info(file).is_declaration_file
                });
                if user_defined {
                    return false;
                }
            }
            return true;
        }
    }
    false
}

/// Whether `t` can be `null` or `undefined` (`any` and `unknown` can).
fn may_be_nullish(checker: &Checker, t: TypeId) -> bool {
    if is_type_flag_set(checker, t, TypeFlags::ANY_OR_UNKNOWN) {
        return true;
    }
    union_type_parts(checker, t)
        .into_iter()
        .any(|part| checker.ty(part).flags.intersects(TypeFlags::NULLABLE))
}

/// Whether a truthiness test of a value of type `t` could become a
/// nullishness test under the rule's options.
fn is_type_eligible_for_prefer_nullish(state: &State, checker: &Checker, t: TypeId) -> bool {
    if !may_be_nullish(checker, t) {
        return false;
    }
    if state.ignorable_flags.is_empty() {
        return true;
    }
    if is_type_flag_set(checker, t, TypeFlags::ANY_OR_UNKNOWN) {
        return false;
    }
    !union_type_parts(checker, t).into_iter().any(|part| {
        intersection_type_parts(checker, part)
            .into_iter()
            .any(|inner| is_type_flag_set(checker, inner, state.ignorable_flags))
    })
}

fn is_truthiness_check_eligible(
    state: &State,
    checker: &mut Checker,
    node: Node,
    test_node: Node,
) -> bool {
    let test_type = checker.get_type_at_location(test_node);
    if !is_type_eligible_for_prefer_nullish(state, checker, test_type) {
        return false;
    }
    if state.options.ignore_conditional_tests && is_conditional_test(node) {
        return false;
    }
    // A ternary that is itself the argument of `Boolean(...)` is still checked.
    if state.options.ignore_boolean_coercion
        && is_boolean_constructor_context(checker, node)
        && !(is_conditional_expression(node) && is_call_expression(node.parent()))
    {
        return false;
    }
    true
}

/// The nodes compared in a nullish test (`x === null || x === undefined`):
/// whether `null` and `undefined` appear, and the first node that accesses
/// the same member as the target.
struct NullishTest {
    has_null_check: bool,
    has_undefined_check: bool,
    matching: Option<Node>,
}

impl NullishTest {
    /// None when a node is neither `null`, `undefined` nor the target.
    fn of(nodes: &[Node], target: Node) -> Option<Self> {
        let mut test = Self {
            has_null_check: false,
            has_undefined_check: false,
            matching: None,
        };
        for &node in nodes {
            if is_null_literal(node) {
                test.has_null_check = true;
            } else if is_undefined_identifier(node) {
                test.has_undefined_check = true;
            } else if are_nodes_similar_member_access(node, target) {
                test.matching.get_or_insert(node);
            } else {
                return None;
            }
        }
        Some(test)
    }
}

/// Whether a test that compares with only `null` or only `undefined`
/// misses part of the nullish values of `target`, so no fix is safe.
/// `allow_not_equal` treats `!=` like `==`.
fn should_skip_partial_nullish_check(
    checker: &mut Checker,
    has_null_check: bool,
    has_undefined_check: bool,
    operator: TestOperator,
    target: Node,
    allow_not_equal: bool,
) -> bool {
    if has_null_check && has_undefined_check {
        return false;
    }
    if !has_null_check && !has_undefined_check {
        return true;
    }
    // Loose equality matches both `null` and `undefined`.
    if operator == TestOperator::Equal || (allow_not_equal && operator == TestOperator::NotEqual) {
        return false;
    }
    let t = checker.get_type_at_location(target);
    if checker.ty(t).flags.intersects(TypeFlags::ANY_OR_UNKNOWN) {
        return true;
    }
    let parts = union_type_parts(checker, t);
    let has_part = |flag: TypeFlags| {
        parts
            .iter()
            .any(|&part| checker.ty(part).flags.intersects(flag))
    };
    (has_undefined_check && has_part(TypeFlags::NULL))
        || (has_null_check && has_part(TypeFlags::UNDEFINED))
}

/// Whether the `||` expression `node` is part of a logical expression that
/// also uses `&&`.
fn is_mixed_logical_expression(node: Node) -> bool {
    let mut seen = FxHashSet::default();
    let mut queue = std::collections::VecDeque::from([node.parent(), node.left(), node.right()]);
    while let Some(current) = queue.pop_front() {
        if current.is_nil() || !seen.insert(current) {
            continue;
        }
        if !is_logical_expression(current) {
            continue;
        }
        let unwrapped = skip_parentheses(current);
        if !is_binary_expression(unwrapped) {
            continue;
        }
        match unwrapped.operator_token().kind() {
            SyntaxKind::AmpersandAmpersandToken => return true,
            SyntaxKind::BarBarToken => {
                queue.extend([current.parent(), unwrapped.left(), unwrapped.right()]);
            }
            SyntaxKind::EqualsToken if is_logical_expression(unwrapped.left()) => {
                queue.extend([current.parent(), unwrapped.left(), unwrapped.right()]);
            }
            _ => {}
        }
    }
    false
}

/// `||` and `||=`.
fn check_or(
    state: &mut State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    description: &str,
    equals: &str,
) {
    let left = node.left();
    let right = node.right();
    let operator_token = node.operator_token();
    if !is_truthiness_check_eligible(state, ctx.checker, node, left) {
        return;
    }
    if state.options.ignore_mixed_logical_expressions && is_mixed_logical_expression(node) {
        return;
    }
    ctx.report_node_with_suggestions(
        operator_token,
        prefer_nullish_over_or_message(description, equals),
        |ctx| {
            let mut fixes = Vec::new();
            let mut left_operand_starts_inside_left = false;

            // Inside another logical expression, wrap the new `??` unless
            // it is already parenthesized.
            let parent = walk_up_parenthesized_expressions(node.parent());
            if parent.is_some()
                && is_logical_expression(parent)
                && !is_parenthesized_expression(node.parent())
            {
                // A parenthesized left side already groups itself
                // (oxc-project/tsgolint#604).
                if is_binary_expression(left)
                    && is_logical_expression(left)
                    && !is_logical_or_operator(left.left())
                {
                    fixes.push(ctx.fix_insert_before(left.right(), "("));
                    left_operand_starts_inside_left = true;
                } else {
                    fixes.push(ctx.fix_insert_before(left, "("));
                }
                fixes.push(RuleFix::insert_after(right, ")"));
            }

            if operator_token.kind() == SyntaxKind::BarBarToken {
                if !left_operand_starts_inside_left
                    && is_logical_expression(left)
                    && !is_parenthesized_expression(left)
                {
                    fixes.extend(ctx.fix_wrap_in_parens(left));
                }
                if is_logical_expression(right) && !is_parenthesized_expression(right) {
                    fixes.extend(ctx.fix_wrap_in_parens(right));
                }
            }

            let new_operator = if operator_token.kind() == SyntaxKind::BarBarToken {
                "??"
            } else {
                "??="
            };
            fixes.push(ctx.fix_replace(operator_token, new_operator));
            vec![RuleSuggestion {
                message: suggest_nullish_coalescing_message(),
                fixes,
            }]
        },
    );
}

/// The operator of the test of a ternary or `if`, and the operands it
/// compares (empty for a plain or negated truthiness test). `None` when the
/// test is not a nullish test.
fn get_operator_and_nodes_inside_test(node: Node) -> Option<(TestOperator, Vec<Node>)> {
    let test = if is_conditional_expression(node) {
        node.condition()
    } else if is_if_statement(node) {
        node.expression()
    } else {
        return None;
    };
    let test = skip_parentheses(test);

    if is_member_access_like(test) {
        return Some((TestOperator::Truthy, Vec::new()));
    }
    if is_not_expression(test) {
        return is_member_access_like(skip_parentheses(test.operand()))
            .then(|| (TestOperator::Not, Vec::new()));
    }
    if !is_binary_expression(test) {
        return None;
    }

    let left = skip_parentheses(test.left());
    let right = skip_parentheses(test.right());
    let operator = test.operator_token().kind();
    match operator {
        SyntaxKind::EqualsEqualsToken => return Some((TestOperator::Equal, vec![left, right])),
        SyntaxKind::ExclamationEqualsToken => {
            return Some((TestOperator::NotEqual, vec![left, right]));
        }
        SyntaxKind::EqualsEqualsEqualsToken => {
            return Some((TestOperator::StrictEqual, vec![left, right]));
        }
        SyntaxKind::ExclamationEqualsEqualsToken => {
            return Some((TestOperator::NotStrictEqual, vec![left, right]));
        }
        SyntaxKind::BarBarToken | SyntaxKind::AmpersandAmpersandToken => {}
        _ => return None,
    }

    // A compound test such as `a === null || a === undefined`.
    let (left_binary, right_binary) = (test.left(), test.right());
    if !is_binary_expression(left_binary) || !is_binary_expression(right_binary) {
        return None;
    }
    let is_nullish_comparison = |binary: Node| {
        is_null_literal_or_undefined_identifier(skip_parentheses(binary.left()))
            && is_null_literal_or_undefined_identifier(skip_parentheses(binary.right()))
    };
    if is_nullish_comparison(left_binary) || is_nullish_comparison(right_binary) {
        return None;
    }
    let nodes = vec![
        skip_parentheses(left_binary.left()),
        skip_parentheses(left_binary.right()),
        skip_parentheses(right_binary.left()),
        skip_parentheses(right_binary.right()),
    ];
    let left_op = left_binary.operator_token().kind();
    let right_op = right_binary.operator_token().kind();
    let both = |a: SyntaxKind, b: SyntaxKind| {
        (left_op == a || left_op == b) && (right_op == a || right_op == b)
    };
    let found = if operator == SyntaxKind::BarBarToken {
        if left_op == SyntaxKind::EqualsEqualsEqualsToken
            && right_op == SyntaxKind::EqualsEqualsEqualsToken
        {
            Some(TestOperator::StrictEqual)
        } else if both(
            SyntaxKind::EqualsEqualsEqualsToken,
            SyntaxKind::EqualsEqualsToken,
        ) {
            Some(TestOperator::Equal)
        } else {
            None
        }
    } else if left_op == SyntaxKind::ExclamationEqualsEqualsToken
        && right_op == SyntaxKind::ExclamationEqualsEqualsToken
    {
        Some(TestOperator::NotStrictEqual)
    } else if both(
        SyntaxKind::ExclamationEqualsEqualsToken,
        SyntaxKind::ExclamationEqualsToken,
    ) {
        Some(TestOperator::NotEqual)
    } else {
        None
    };
    found.map(|operator| (operator, nodes))
}

/// The text of `node` with its leading trivia, trimmed of white space, as
/// tsgolint takes it (comments stay).
fn raw_node_text_trimmed(ctx: &RuleContext<'_>, node: Node) -> String {
    ctx.range_text(node.loc()).trim().to_owned()
}

fn check_conditional(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if state.options.ignore_ternary_tests {
        return;
    }
    let Some((operator, nodes_inside_test)) = get_operator_and_nodes_inside_test(node) else {
        return;
    };
    let (non_nullish_branch, nullish_branch) = if matches!(
        operator,
        TestOperator::Truthy | TestOperator::NotEqual | TestOperator::NotStrictEqual
    ) {
        (node.when_true(), node.when_false())
    } else {
        (node.when_false(), node.when_true())
    };
    let non_nullish_branch = skip_parentheses(non_nullish_branch);

    let left_node;
    let has_truthiness_check = nodes_inside_test.is_empty();
    if has_truthiness_check {
        let test = skip_parentheses(node.condition());
        left_node = if is_not_expression(test) {
            skip_parentheses(test.operand())
        } else {
            test
        };
        if !are_nodes_similar_member_access(left_node, non_nullish_branch) {
            return;
        }
    } else {
        let Some(test) = NullishTest::of(&nodes_inside_test, non_nullish_branch) else {
            return;
        };
        let Some(matching) = test.matching else {
            return;
        };
        left_node = matching;
        if should_skip_partial_nullish_check(
            ctx.checker,
            test.has_null_check,
            test.has_undefined_check,
            operator,
            left_node,
            true,
        ) {
            return;
        }
    }

    if has_truthiness_check && !is_truthiness_check_eligible(state, ctx.checker, node, left_node) {
        return;
    }

    ctx.report_node_with_suggestions(node, prefer_nullish_over_ternary_message(), |ctx| {
        let mut right_text = raw_node_text_trimmed(ctx, nullish_branch);
        if !is_strong_precedence_node(nullish_branch)
            && !is_parenthesized_expression(nullish_branch)
        {
            right_text = format!("({right_text})");
        }
        let new_text = format!("{} ?? {right_text}", raw_node_text_trimmed(ctx, left_node));
        vec![RuleSuggestion {
            message: suggest_nullish_coalescing_message(),
            fixes: vec![ctx.fix_replace(node, new_text)],
        }]
    });
}

fn check_if_statement(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if state.options.ignore_if_statements || node.else_statement().is_some() {
        return;
    }

    // The single expression statement of the `then` branch.
    let then_statement = node.then_statement();
    let statement = if is_block(then_statement) {
        let statements = then_statement.statements();
        if statements.len() == 1 {
            statements.get(0)
        } else {
            Node::NIL
        }
    } else {
        then_statement
    };
    if statement.is_nil() || !is_expression_statement(statement) {
        return;
    }
    let assignment = skip_parentheses(statement.expression());
    if !is_assignment_expression(assignment, false) || !is_member_access_like(assignment.left()) {
        return;
    }
    let left_node = assignment.left();
    let right_node = assignment.right();

    let Some((operator, nodes_inside_test)) = get_operator_and_nodes_inside_test(node) else {
        return;
    };
    if !matches!(
        operator,
        TestOperator::Not | TestOperator::Equal | TestOperator::StrictEqual
    ) {
        return;
    }

    if nodes_inside_test.is_empty() {
        let mut test = skip_parentheses(node.expression());
        if is_prefix_unary_expression(test) {
            test = skip_parentheses(test.operand());
        }
        if !are_nodes_similar_member_access(test, left_node)
            || !is_truthiness_check_eligible(state, ctx.checker, node, test)
        {
            return;
        }
    } else {
        let Some(test) = NullishTest::of(&nodes_inside_test, left_node) else {
            return;
        };
        if test.matching.is_none()
            || should_skip_partial_nullish_check(
                ctx.checker,
                test.has_null_check,
                test.has_undefined_check,
                operator,
                left_node,
                false,
            )
        {
            return;
        }
    }

    ctx.report_node_with_suggestions(node, prefer_nullish_over_assignment_message(), |ctx| {
        let mut left_text = raw_node_text_trimmed(ctx, skip_parentheses(left_node));
        // Only an originally parenthesized target keeps one pair.
        if is_parenthesized_expression(left_node) {
            left_text = format!("({left_text})");
        }
        let new_text = format!(
            "{left_text} ??= {};",
            raw_node_text_trimmed(ctx, right_node)
        );
        vec![RuleSuggestion {
            message: suggest_nullish_coalescing_message(),
            fixes: vec![ctx.fix_replace(node, new_text)],
        }]
    });
}
