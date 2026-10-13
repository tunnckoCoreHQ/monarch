//! `no-mixed-enums`: disallows enums with both number and string members.

use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use goport_core::flags::TypeFlags;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::is_type_flag_set;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-mixed-enums",
    create,
};

fn mixed_message() -> RuleMessage {
    RuleMessage::new("mixed", "Mixing number and string enums can be confusing.")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MemberType {
    Number,
    String,
    Unknown,
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::EnumDeclaration, check_enum)
        .into()
}

fn check_enum(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let members = node.members();
    if members.is_empty() {
        return;
    }
    // The first member of the first declaration of a merged enum decides.
    let symbol = ctx.checker.get_symbol_at_location_exported(node.name());
    let first_declaration = ctx.checker.sym(symbol).declarations[0];
    let desired = member_type(ctx, first_declaration.members().get(0));
    if desired == MemberType::Unknown {
        return;
    }
    for member in members {
        let current = member_type(ctx, member);
        if current == MemberType::Unknown {
            return;
        }
        if current != desired {
            let initializer = member.initializer();
            let target = if initializer.is_some() {
                initializer
            } else {
                member
            };
            ctx.report_node(target, mixed_message());
            return;
        }
    }
}

fn member_type(ctx: &mut RuleContext<'_>, member: Node) -> MemberType {
    let initializer = member.initializer();
    if initializer.is_nil() {
        return MemberType::Number;
    }
    match initializer.kind() {
        SyntaxKind::NumericLiteral => MemberType::Number,
        SyntaxKind::StringLiteral => MemberType::String,
        _ => {
            let t = ctx.checker.get_type_at_location(initializer);
            if is_type_flag_set(ctx.checker, t, TypeFlags::STRING_LIKE) {
                MemberType::String
            } else if is_type_flag_set(ctx.checker, t, TypeFlags::NUMBER_LIKE) {
                MemberType::Number
            } else {
                MemberType::Unknown
            }
        }
    }
}
