//! `prefer-return-this-type`: prefers `this` as the return type of methods
//! that only return `this`.

use goport_core::ast::{
    for_each_return_statement, is_arrow_function, is_block, is_class_like, is_function_expression,
    is_identifier, is_type_reference_node, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, TypeId};
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-return-this-type",
    create,
};

fn use_this_type_message() -> RuleMessage {
    RuleMessage::new("useThisType", "Use `this` type instead.")
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::PropertyDeclaration, check_property)
        .on(SyntaxKind::MethodDeclaration, check_method)
        .into()
}

fn check_property(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if !is_class_like(node.parent()) {
        return;
    }
    let initializer = node.initializer();
    if initializer.is_some()
        && (is_function_expression(initializer) || is_arrow_function(initializer))
    {
        check_function(ctx, initializer, node.parent());
    }
}

fn check_method(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if is_class_like(node.parent()) {
        check_function(ctx, node, node.parent());
    }
}

/// The type reference to `name` in `node`, also as a member of a union.
fn find_name_in_type_node(name: &str, node: Node) -> Option<Node> {
    let node = skip_parentheses(node);
    if is_type_reference_node(node) {
        let type_name = node.type_name();
        if is_identifier(type_name) && type_name.text() == name {
            return Some(node);
        }
    } else if node.kind() == SyntaxKind::UnionType {
        return node
            .types()
            .nodes()
            .into_iter()
            .find_map(|t| find_name_in_type_node(name, t));
    }
    None
}

fn check_function(ctx: &mut RuleContext<'_>, function: Node, class: Node) {
    let return_type = function.type_();
    let body = function.body();
    if return_type.is_nil() || body.is_nil() {
        return;
    }
    let class_name = class.name();
    if class_name.is_nil() {
        return;
    }
    let Some(node) = find_name_in_type_node(class_name.text(), return_type) else {
        return;
    };
    // A `this` parameter declares the type of `this` explicitly.
    if let Some(first) = function.parameters().first() {
        let name = first.name();
        if is_identifier(name) && name.text() == "this" {
            return;
        }
    }

    let class_type = ctx.checker.get_type_at_location(class);
    // (class type, its `this` type); None when it is not an interface type.
    let class_types: Option<(TypeId, TypeId)> = ctx
        .checker
        .ty(class_type)
        .data
        .as_interface_type()
        .map(|interface| (class_type, interface.this_type));

    if is_block(body) {
        let mut has_return_this = false;
        let has_return_class_type = for_each_return_statement(body, |statement| {
            let expression = statement.expression();
            if expression.is_nil() {
                return false;
            }
            if expression.kind() == SyntaxKind::ThisKeyword {
                has_return_this = true;
                return false;
            }
            let Some((class_type, this_type)) = class_types else {
                return false;
            };
            let t = ctx.checker.get_type_at_location(expression);
            if t == class_type {
                return true;
            }
            if t == this_type {
                has_return_this = true;
            }
            false
        });
        if has_return_class_type || !has_return_this {
            return;
        }
    } else {
        let Some((_, this_type)) = class_types else {
            return;
        };
        if ctx.checker.get_type_at_location(body) != this_type {
            return;
        }
    }

    ctx.report_node_with_fixes(node, use_this_type_message(), |ctx| {
        vec![ctx.fix_replace(node, "this")]
    });
}
