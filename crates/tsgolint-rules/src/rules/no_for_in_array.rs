//! `no-for-in-array`: disallows iterating over an array with a for-in loop.

use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{
    get_constrained_type_at_location, get_for_statement_head_loc, get_number_index_type,
    is_type_flag_set, type_recurser,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-for-in-array",
    create,
};

fn for_in_violation_message() -> RuleMessage {
    RuleMessage::new(
        "forInViolation",
        "For-in loops over arrays skips holes, returns indices as strings, and may visit the prototype chain or other enumerable properties.",
    )
    .with_help("Use a more robust iteration method such as for-of or array.forEach instead.")
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::ForInStatement, check_for_in)
        .into()
}

fn check_for_in(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let t = get_constrained_type_at_location(ctx.checker, node.expression());
    if is_array_like(ctx.checker, t) {
        let range = get_for_statement_head_loc(ctx.source_file, node);
        ctx.report_range(range, for_in_violation_message());
    }
}

/// Some union or intersection member has a number index and a numeric
/// `length` property.
fn is_array_like(checker: &mut Checker, t: TypeId) -> bool {
    type_recurser(checker, t, |checker, t| {
        get_number_index_type(checker, t).is_some() && has_arrayish_length(checker, t)
    })
}

fn has_arrayish_length(checker: &mut Checker, t: TypeId) -> bool {
    let length = checker.get_property_of_type(t, "length");
    if length.is_nil() {
        return false;
    }
    let length_type = checker.get_type_of_symbol(length);
    is_type_flag_set(checker, length_type, TypeFlags::NUMBER_LIKE)
}
