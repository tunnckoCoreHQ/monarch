//! `no-generated-empty-object-type`: reports generic instantiations and
//! intersections that resolve to the empty object type `{}`.

use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ObjectFlags, SignatureKind};
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{is_object_type, union_type_parts};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-generated-empty-object-type",
    create,
};

fn no_generated_empty_object_type_message() -> RuleMessage {
    RuleMessage::new(
        "noGeneratedEmptyObjectType",
        "This type resolves to `{}`, the empty object type. This was likely not intentional.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::IntersectionType, |_, ctx, node| {
            check_node(ctx, node)
        })
        .on(SyntaxKind::TypeReference, check_type_reference)
        .into()
}

fn check_type_reference(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let mut parent = node.parent();
    while parent.kind() == SyntaxKind::ParenthesizedType {
        parent = parent.parent();
    }
    // An intersection is checked as a whole.
    if node.type_argument_list().is_some() && parent.kind() != SyntaxKind::IntersectionType {
        check_node(ctx, node);
    }
}

fn check_node(ctx: &mut RuleContext<'_>, node: Node) {
    let t = ctx.checker.get_type_at_location(node);
    let parts = union_type_parts(ctx.checker, t);
    if parts
        .iter()
        .any(|&part| is_empty_object_type(ctx.checker, part))
    {
        ctx.report_node(node, no_generated_empty_object_type_message());
    }
}

fn is_empty_object_type(checker: &mut Checker, t: TypeId) -> bool {
    if !is_object_type(checker, t)
        || checker
            .ty(t)
            .object_flags
            .intersects(ObjectFlags::CLASS_OR_INTERFACE)
    {
        return false;
    }
    if !checker.get_properties_of_type(t).is_empty()
        || !checker.get_index_infos_of_type(t).is_empty()
        || !checker
            .get_signatures_of_type(t, SignatureKind::CALL)
            .is_empty()
        || !checker
            .get_signatures_of_type(t, SignatureKind::CONSTRUCT)
            .is_empty()
    {
        return false;
    }
    // Unresolved mapped types can have no members and accept `number` but
    // reject `string`. Both primitives must be assignable to `{}`.
    let (number, string) = (checker.number_type, checker.string_type);
    checker.is_type_assignable_to(number, t) && checker.is_type_assignable_to(string, t)
}
