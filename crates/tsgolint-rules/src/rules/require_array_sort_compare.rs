//! `require-array-sort-compare`: requires a compare function for
//! `Array.prototype.sort` and `toSorted`.

use goport_core::ast::is_access_expression;
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::TypeFlags;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{get_constrained_type_at_location, get_type_name, union_type_parts};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "require-array-sort-compare",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    ignore_string_arrays: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ignore_string_arrays: true,
        }
    }
}

fn require_compare_message() -> RuleMessage {
    RuleMessage::new("requireCompare", "Require 'compare' argument.")
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::CallExpression, check_call)
        .into()
}

fn check_call(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    if !node.arguments().is_empty() {
        return;
    }
    let callee = node.expression();
    if !is_access_expression(callee) {
        return;
    }
    let (property_name, found) = ctx.checker.get_accessed_property_name(callee);
    if !found || !matches!(property_name.as_str(), "sort" | "toSorted") {
        return;
    }

    let checker = &mut *ctx.checker;
    let object_type = get_constrained_type_at_location(checker, callee.expression());
    if options.ignore_string_arrays && checker.is_array_or_tuple_type(object_type) {
        let type_arguments = checker.get_type_arguments(object_type);
        let all_strings = type_arguments.iter().all(|&t| {
            let constraint = checker.get_base_constraint_of_type(t);
            let t = if constraint.is_some() { constraint } else { t };
            checker.ty(t).flags.intersects(TypeFlags::STRING)
                || get_type_name(checker, t) == "string"
        });
        if all_strings {
            return;
        }
    }

    let parts = union_type_parts(checker, object_type);
    if parts.iter().all(|&t| checker.is_array_type(t)) {
        ctx.report_node(node, require_compare_message());
    }
}
