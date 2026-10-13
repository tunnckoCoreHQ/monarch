//! `related-getter-setter-pairs`: requires a getter's type to be assignable
//! to its setter's parameter type.

use std::collections::HashMap;

use goport_core::ast::{is_get_accessor_declaration, is_set_accessor_declaration};
use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::get_name_from_member;

pub static RULE: RuleDefinition = RuleDefinition {
    name: "related-getter-setter-pairs",
    create,
};

fn mismatch_message() -> RuleMessage {
    RuleMessage::new(
        "mismatch",
        "`get()` type should be assignable to its equivalent `set()` type.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::ClassDeclaration, check_members)
        .on(SyntaxKind::ClassExpression, check_members)
        .on(SyntaxKind::InterfaceDeclaration, check_members)
        .on(SyntaxKind::TypeLiteral, check_members)
        .into()
}

fn check_members(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    let mut getters: HashMap<String, Node> = HashMap::new();
    let mut setters: HashMap<String, Node> = HashMap::new();
    for member in node.members() {
        if is_get_accessor_declaration(member) {
            if member.type_().is_nil() {
                continue;
            }
            let (name, _) = get_name_from_member(ctx.source_file, member.name());
            match setters.get(&name) {
                Some(&setter) => check_pair(ctx, member, setter),
                None => {
                    getters.insert(name, member);
                }
            }
        } else if is_set_accessor_declaration(member) {
            if member.parameters().len() != 1 {
                continue;
            }
            let (name, _) = get_name_from_member(ctx.source_file, member.name());
            match getters.get(&name) {
                Some(&getter) => check_pair(ctx, getter, member),
                None => {
                    setters.insert(name, member);
                }
            }
        }
    }
}

fn check_pair(ctx: &mut RuleContext<'_>, getter: Node, setter: Node) {
    let get_type = ctx.checker.get_type_at_location(getter);
    let set_type = ctx.checker.get_type_at_location(setter.parameters().get(0));
    if !ctx.checker.is_type_assignable_to(get_type, set_type) {
        ctx.report_node(getter.type_(), mismatch_message());
    }
}
