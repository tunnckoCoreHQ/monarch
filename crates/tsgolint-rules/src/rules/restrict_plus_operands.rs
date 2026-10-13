//! `restrict-plus-operands`: requires both operands of `+` (and `+=`) to be
//! numbers, bigints or strings of the same kind.

use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_constrained_type_at_location, intersection_type_parts, is_object_type, is_type_any_type,
    is_type_flag_set, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "restrict-plus-operands",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_any: bool,
    allow_boolean: bool,
    allow_nullish: bool,
    allow_number_and_string: bool,
    allow_reg_exp: bool,
    skip_compound_assignments: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_any: true,
            allow_boolean: true,
            allow_nullish: true,
            allow_number_and_string: true,
            allow_reg_exp: true,
            skip_compound_assignments: false,
        }
    }
}

struct State {
    options: Options,
    /// The help text's description of what a string may be added to.
    string_like: String,
    invalid_flags: TypeFlags,
}

fn invalid_message(invalid_type: &str, string_like: &str) -> RuleMessage {
    RuleMessage::new(
        "invalid",
        format!("Invalid operand of type '{invalid_type}' for a '+' operation."),
    )
    .with_help(format!("Operands must each be a number or {string_like}."))
}

fn mismatched_message(string_like: &str) -> RuleMessage {
    RuleMessage::new(
        "mismatched",
        "Operands of '+' operations must be of the same type.",
    )
    .with_help(format!(
        "Operands must both be a number or both be {string_like}."
    ))
}

fn bigint_and_number_message() -> RuleMessage {
    RuleMessage::new(
        "bigintAndNumber",
        "Numeric '+' operations must either be both bigints or both numbers.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);

    // tsgolint lists `null` and `undefined` around `RegExp` in this order.
    let string_likes: Vec<&str> = [
        (options.allow_any, "`any`"),
        (options.allow_boolean, "`boolean`"),
        (options.allow_nullish, "`null`"),
        (options.allow_reg_exp, "`RegExp`"),
        (options.allow_nullish, "`undefined`"),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect();
    let string_like = match string_likes.as_slice() {
        [] => "string".to_owned(),
        [only] => format!("string, allowing a string + {only}"),
        all => format!("string, allowing a string + any of: {}", all.join(", ")),
    };

    let mut invalid_flags = TypeFlags::ES_SYMBOL_LIKE | TypeFlags::NEVER | TypeFlags::UNKNOWN;
    for (allowed, flags) in [
        (options.allow_any, TypeFlags::ANY),
        (options.allow_boolean, TypeFlags::BOOLEAN_LIKE),
        (options.allow_nullish, TypeFlags::NULLABLE),
    ] {
        if !allowed {
            invalid_flags |= flags;
        }
    }

    Listeners::new(State {
        options,
        string_like,
        invalid_flags,
    })
    .on(SyntaxKind::BinaryExpression, check_binary)
    .into()
}

fn check_binary(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let operator = node.operator_token().kind();
    let checked = operator == SyntaxKind::PlusToken
        || (!state.options.skip_compound_assignments && operator == SyntaxKind::PlusEqualsToken);
    if checked {
        check_plus_operands(state, ctx, node);
    }
}

fn constrained_base_type(checker: &mut Checker, node: Node) -> TypeId {
    let t = get_constrained_type_at_location(checker, node);
    checker.get_base_type_of_literal_type(t)
}

fn check_plus_operands(state: &State, ctx: &mut RuleContext<'_>, node: Node) {
    let left = node.left();
    let right = node.right();
    let left_type = constrained_base_type(ctx.checker, left);
    let right_type = constrained_base_type(ctx.checker, right);

    if left_type == right_type
        && is_type_flag_set(
            ctx.checker,
            left_type,
            TypeFlags::BIG_INT_LIKE | TypeFlags::NUMBER_LIKE | TypeFlags::STRING_LIKE,
        )
    {
        return;
    }

    let (left_flags, left_invalid) =
        check_invalid_operand(state, ctx.checker, left_type, right_type);
    let (right_flags, right_invalid) =
        check_invalid_operand(state, ctx.checker, right_type, left_type);

    for (invalid, operand, t) in [
        (left_invalid, left, left_type),
        (right_invalid, right, right_type),
    ] {
        if invalid {
            let message = invalid_message(&ctx.checker.type_to_string(t), &state.string_like);
            let range = ctx.trim_node_text_range(operand);
            ctx.report_diagnostic(Report::new(range, message));
        }
    }
    if left_invalid || right_invalid {
        return;
    }

    let mismatch = |base: TypeFlags, other: TypeFlags| -> Option<RuleMessage> {
        if !state.options.allow_number_and_string
            && base.intersects(TypeFlags::STRING_LIKE)
            && other.intersects(TypeFlags::NUMBER_LIKE | TypeFlags::BIG_INT_LIKE)
        {
            return Some(mismatched_message(&state.string_like));
        }
        if base.intersects(TypeFlags::NUMBER_LIKE) && other.intersects(TypeFlags::BIG_INT_LIKE) {
            return Some(bigint_and_number_message());
        }
        None
    };
    let Some(message) =
        mismatch(left_flags, right_flags).or_else(|| mismatch(right_flags, left_flags))
    else {
        return;
    };
    let range = ctx.trim_node_text_range(node);
    let left_range = ctx.trim_node_text_range(left);
    let right_range = ctx.trim_node_text_range(right);
    let left_label = format!("Type: {}", ctx.checker.type_to_string(left_type));
    let right_label = format!("Type: {}", ctx.checker.type_to_string(right_type));
    ctx.report_diagnostic(
        Report::new(range, message)
            .with_label(left_label, left_range)
            .with_label(right_label, right_range),
    );
}

/// The union of the flags of `base_type`'s union members up to the first
/// invalid one, and whether some member is invalid in a `+`.
fn check_invalid_operand(
    state: &State,
    checker: &mut Checker,
    base_type: TypeId,
    other_type: TypeId,
) -> (TypeFlags, bool) {
    let options = &state.options;
    let mut flags = TypeFlags::default();
    let mut found_invalid = false;
    for part in union_type_parts(checker, base_type) {
        flags |= checker.ty(part).flags;
        if is_type_flag_set(checker, part, state.invalid_flags) {
            return (flags, true);
        }
        let valid = if part == checker.global_reg_exp_type {
            // `RegExp` is an object type too, so it needs its own test.
            options.allow_reg_exp && !is_type_flag_set(checker, other_type, TypeFlags::NUMBER_LIKE)
        } else {
            (options.allow_any || !is_type_any_type(checker, part))
                && !intersection_type_parts(checker, part)
                    .into_iter()
                    .all(|t| is_object_type(checker, t))
        };
        if !valid {
            found_invalid = true;
        }
    }
    (flags, found_invalid)
}
