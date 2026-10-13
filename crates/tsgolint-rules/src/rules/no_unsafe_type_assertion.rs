//! `no-unsafe-type-assertion`: disallows type assertions that narrow a
//! type.

use goport_core::ast::is_as_expression;
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::ObjectFlags;
use serde_json::Value;
use tsgolint_core::diagnostic::TextRange;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{
    is_intrinsic_error_type, is_object_type, is_type_any_type, is_type_parameter,
    is_type_unknown_type, is_unsafe_assignment, type_to_string_or_error,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-type-assertion",
    create,
};

fn unsafe_of_any_type_assertion_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeOfAnyTypeAssertion",
        format!("Unsafe assertion from {type_name} detected."),
    )
    .with_help("Consider using type guards or a safer assertion.")
}

fn unsafe_to_any_type_assertion_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeToAnyTypeAssertion",
        format!("Unsafe assertion to {type_name} detected."),
    )
    .with_help("Consider using a more specific type to ensure safety.")
}

fn unsafe_to_unconstrained_type_assertion_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeToUnconstrainedTypeAssertion",
        format!(
            "Unsafe type assertion: '{type_name}' could be instantiated with an arbitrary type which could be unrelated to the original type."
        ),
    )
}

fn unsafe_type_assertion_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeTypeAssertion",
        format!("Unsafe type assertion: type '{type_name}' is more narrow than the original type."),
    )
}

fn unsafe_type_assertion_assignable_to_constraint_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeTypeAssertionAssignableToConstraint",
        format!(
            "Unsafe type assertion: the original type is assignable to the constraint of type '{type_name}', but '{type_name}' could be instantiated with a different subtype of its constraint."
        ),
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::AsExpression, check_assertion)
        .on(SyntaxKind::TypeAssertionExpression, check_assertion)
        .into()
}

fn any_type_name(checker: &Checker, t: TypeId) -> &'static str {
    if is_intrinsic_error_type(checker, t) {
        "error typed"
    } else {
        "`any`"
    }
}

fn is_object_literal_type(checker: &Checker, t: TypeId) -> bool {
    is_object_type(checker, t)
        && checker
            .ty(t)
            .object_flags
            .intersects(ObjectFlags::OBJECT_LITERAL)
}

/// `as T` for an `as` expression, `<T>` for an angle-bracket assertion.
fn assertion_range(source_file: Node, node: Node, expression: Node, type_node: Node) -> TextRange {
    if is_as_expression(node) {
        return token_range_at(source_file, expression.end()).with_end(type_node.end());
    }
    let opening = token_range_at(source_file, node.pos());
    let closing = token_range_at(source_file, type_node.end());
    opening.with_end(closing.end())
}

fn check_assertion(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let expression = node.expression();
    let type_node = node.type_();
    let expression_type = ctx.checker.get_type_at_location(expression);
    let asserted_type = ctx.checker.get_type_at_location(type_node);

    let report = |ctx: &mut RuleContext<'_>, message: RuleMessage| {
        let range = assertion_range(ctx.source_file, node, expression, type_node);
        let original = type_to_string_or_error(ctx.checker, expression_type);
        let asserted = type_to_string_or_error(ctx.checker, asserted_type);
        let report = Report::new(range, message)
            .with_label(
                format!("Original expression has type `{original}`."),
                ctx.trim_node_text_range(expression),
            )
            .with_label(
                format!("Asserted type is `{asserted}`."),
                ctx.trim_node_text_range(type_node),
            );
        ctx.report_diagnostic(report);
    };

    if expression_type == asserted_type {
        return;
    }

    // `unknown` to `any`.
    if is_type_any_type(ctx.checker, asserted_type)
        && is_type_unknown_type(ctx.checker, expression_type)
    {
        report(ctx, unsafe_to_any_type_assertion_message("`any`"));
        return;
    }

    if let Some(unsafe_assignment) =
        is_unsafe_assignment(ctx.checker, expression_type, asserted_type, expression)
    {
        let name = any_type_name(ctx.checker, unsafe_assignment.sender);
        report(ctx, unsafe_of_any_type_assertion_message(name));
        return;
    }

    if let Some(unsafe_assignment) =
        is_unsafe_assignment(ctx.checker, asserted_type, expression_type, type_node)
    {
        let name = any_type_name(ctx.checker, unsafe_assignment.sender);
        report(ctx, unsafe_to_any_type_assertion_message(name));
        return;
    }

    // Widen object literals so the excess property check does not fail.
    let expression_widened_type = if is_object_literal_type(ctx.checker, expression_type) {
        ctx.checker.get_widened_type(expression_type)
    } else {
        expression_type
    };

    if ctx
        .checker
        .is_type_assignable_to(expression_widened_type, asserted_type)
    {
        return;
    }

    if is_type_parameter(ctx.checker, asserted_type) {
        let constraint = ctx.checker.get_base_constraint_of_type(asserted_type);
        if constraint.is_nil() {
            let message = unsafe_to_unconstrained_type_assertion_message(
                &ctx.checker.type_to_string(asserted_type),
            );
            report(ctx, message);
            return;
        }
        if ctx
            .checker
            .is_type_assignable_to(expression_widened_type, constraint)
        {
            let message = unsafe_type_assertion_assignable_to_constraint_message(
                &ctx.checker.type_to_string(asserted_type),
            );
            report(ctx, message);
            return;
        }
    }

    let message = unsafe_type_assertion_message(&ctx.checker.type_to_string(asserted_type));
    report(ctx, message);
}
