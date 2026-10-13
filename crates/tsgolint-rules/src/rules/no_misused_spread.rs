//! `no-misused-spread`: disallows spreads that drop data or split strings.

use goport_core::ast::{
    TextRange, is_class_declaration, is_class_expression, is_object_literal_expression,
    is_spread_assignment, is_spread_element, skip_parentheses,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ObjectFlags, TypeFlags};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listener, Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, get_call_signatures, get_constrained_type_at_location,
    get_construct_signatures, get_well_known_symbol_property_of_type, insert_await_fixes,
    is_builtin_symbol_like, is_object_type, is_promise_like, is_type_flag_set,
    type_matches_some_specifier, type_recurser, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-misused-spread",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
}

fn add_await_message() -> RuleMessage {
    RuleMessage::new("addAwait", "Add await operator.")
}

fn no_array_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noArraySpreadInObject",
        "Using the spread operator on an array in an object will result in a list of indices.",
    )
}

fn no_class_declaration_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noClassDeclarationSpreadInObject",
        "Using the spread operator on class declarations will spread only their static properties, and will lose their class prototype.",
    )
}

fn no_class_instance_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noClassInstanceSpreadInObject",
        "Using the spread operator on class instances will lose their class prototype.",
    )
}

fn no_function_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noFunctionSpreadInObject",
        "Using the spread operator on a function without additional properties can cause unexpected behavior.",
    )
    .with_help("Did you forget to call the function?")
}

fn no_iterable_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noIterableSpreadInObject",
        "Using the spread operator on an Iterable in an object can cause unexpected behavior.",
    )
}

fn no_map_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noMapSpreadInObject",
        "Using the spread operator on a Map in an object will result in an empty object.",
    )
    .with_help("Did you mean to use `Object.fromEntries(map)` instead?")
}

fn no_promise_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "noPromiseSpreadInObject",
        "Using the spread operator on Promise in an object can cause unexpected behavior.",
    )
    .with_help("Did you forget to await the promise before spreading it?")
}

fn no_string_spread_message() -> RuleMessage {
    RuleMessage::new(
        "noStringSpread",
        "Using the spread operator on a string can mishandle special characters, because it produces Unicode code points, which will break complex characters (like emojis) into multiple parts.",
    )
    .with_help("Consider using `Intl.Segmenter` for locale-aware string decomposition. Otherwise, if you don't need to preserve emojis or other non-ASCII characters, disable this lint rule on this line or configure the 'allow' rule option.")
}

fn replace_map_spread_in_object_message() -> RuleMessage {
    RuleMessage::new(
        "replaceMapSpreadInObject",
        "Replace map spread in object with `Object.fromEntries()`",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(
            Listener::not_allow_pattern(SyntaxKind::ArrayLiteralExpression),
            |options, ctx, node| check_spread_elements(options, ctx, node.elements()),
        )
        .on(SyntaxKind::CallExpression, |options, ctx, node| {
            check_spread_elements(options, ctx, node.arguments())
        })
        .on(SyntaxKind::JsxSpreadAttribute, |options, ctx, node| {
            check_object_spread(options, ctx, node, node.expression())
        })
        .on(
            Listener::not_allow_pattern(SyntaxKind::ObjectLiteralExpression),
            |options, ctx, node| {
                for property in node.properties() {
                    if is_spread_assignment(property) {
                        check_object_spread(options, ctx, property, property.expression());
                    }
                }
            },
        )
        .into()
}

/// Spreads in array literals and call arguments.
fn check_spread_elements(
    options: &Options,
    ctx: &mut RuleContext<'_>,
    elements: impl IntoIterator<Item = Node>,
) {
    for element in elements {
        if !is_spread_element(element) {
            continue;
        }
        let t = get_constrained_type_at_location(ctx.checker, element.expression());
        if !type_matches_some_specifier(ctx.checker, &*ctx.fs(), t, &options.allow)
            && is_string(ctx.checker, t)
        {
            ctx.report_node(element, no_string_spread_message());
        }
    }
}

/// What an object spread argument is, in the order tsgolint tests.
#[derive(Clone, Copy)]
enum ObjectSpreadKind {
    Promise,
    FunctionWithoutProps,
    Map,
    Array,
    Iterable,
    ClassInstance,
    ClassDeclaration,
}

fn classify_object_spread(c: &mut Checker, t: TypeId) -> Option<ObjectSpreadKind> {
    use ObjectSpreadKind::*;
    if type_recurser(c, t, is_promise_like) {
        Some(Promise)
    } else if type_recurser(c, t, |c, t| {
        !get_call_signatures(c, t).is_empty() && c.get_properties_of_type(t).is_empty()
    }) {
        Some(FunctionWithoutProps)
    } else if type_recurser(c, t, |c, t| {
        is_builtin_symbol_like(c, t, &["Map", "ReadonlyMap", "WeakMap"])
    }) {
        Some(Map)
    } else if type_recurser(c, t, |c, t| c.is_array_or_tuple_type(t)) {
        Some(Array)
    } else if type_recurser(c, t, |c, t| {
        get_well_known_symbol_property_of_type(c, t, "iterator").is_some()
    }) && !is_string(c, t)
    {
        // A string spread is a TypeScript error already.
        Some(Iterable)
    } else if type_recurser(c, t, is_class_instance) {
        Some(ClassInstance)
    } else if type_recurser(c, t, is_class_declaration_type) {
        Some(ClassDeclaration)
    } else {
        None
    }
}

fn check_object_spread(options: &Options, ctx: &mut RuleContext<'_>, node: Node, argument: Node) {
    let t = get_constrained_type_at_location(ctx.checker, argument);
    if type_matches_some_specifier(ctx.checker, &*ctx.fs(), t, &options.allow) {
        return;
    }
    let Some(kind) = classify_object_spread(ctx.checker, t) else {
        return;
    };
    match kind {
        ObjectSpreadKind::Promise => {
            ctx.report_node_with_suggestions(node, no_promise_spread_in_object_message(), |ctx| {
                vec![RuleSuggestion {
                    message: add_await_message(),
                    fixes: insert_await_fixes(ctx.source_file, skip_parentheses(argument)),
                }]
            });
        }
        ObjectSpreadKind::Map => {
            ctx.report_node_with_suggestions(node, no_map_spread_in_object_message(), |ctx| {
                map_spread_suggestions(ctx, node, argument, t)
            });
        }
        ObjectSpreadKind::FunctionWithoutProps => {
            ctx.report_node(node, no_function_spread_in_object_message());
        }
        ObjectSpreadKind::Array => ctx.report_node(node, no_array_spread_in_object_message()),
        ObjectSpreadKind::Iterable => {
            ctx.report_node(node, no_iterable_spread_in_object_message());
        }
        ObjectSpreadKind::ClassInstance => {
            ctx.report_node(node, no_class_instance_spread_in_object_message());
        }
        ObjectSpreadKind::ClassDeclaration => {
            ctx.report_node(node, no_class_declaration_spread_in_object_message());
        }
    }
}

fn is_string(c: &mut Checker, t: TypeId) -> bool {
    type_recurser(c, t, |c, t| is_type_flag_set(c, t, TypeFlags::STRING_LIKE))
}

fn is_iterable_map(c: &mut Checker, t: TypeId) -> bool {
    type_recurser(c, t, |c, t| {
        is_builtin_symbol_like(c, t, &["Map", "ReadonlyMap"])
    })
}

/// An instance type: the type has no construct signature, but its symbol's
/// type at one of its declarations has one.
fn is_class_instance(c: &mut Checker, t: TypeId) -> bool {
    if !get_construct_signatures(c, t).is_empty() {
        return false;
    }
    let symbol = c.ty(t).symbol;
    if symbol.is_nil() {
        return false;
    }
    let declarations = c.sym(symbol).declarations.to_vec();
    declarations.into_iter().any(|declaration| {
        let symbol_type = c.get_type_of_symbol_at_location(symbol, declaration);
        !get_construct_signatures(c, symbol_type).is_empty()
    })
}

fn is_class_declaration_type(c: &mut Checker, t: TypeId) -> bool {
    if is_object_type(c, t)
        && c.ty(t)
            .object_flags
            .intersects(ObjectFlags::INSTANTIATION_EXPRESSION_TYPE)
    {
        return true;
    }
    let symbol = c.ty(t).symbol;
    if symbol.is_nil() {
        return false;
    }
    let declaration = c.sym(symbol).value_declaration;
    declaration.is_some() && (is_class_expression(declaration) || is_class_declaration(declaration))
}

fn map_spread_suggestions(
    ctx: &mut RuleContext<'_>,
    node: Node,
    argument: Node,
    t: TypeId,
) -> Vec<RuleSuggestion> {
    // `Object.fromEntries` needs every union member to be an iterable map.
    for part in union_type_parts(ctx.checker, t) {
        if !is_iterable_map(ctx.checker, part) {
            return Vec::new();
        }
    }

    let object = node.parent();
    if is_object_literal_expression(object) {
        let properties = object.property_list();
        if properties.nodes().len() == 1 {
            // `{ ...map }` becomes `Object.fromEntries(map)`.
            return vec![RuleSuggestion {
                message: replace_map_spread_in_object_message(),
                fixes: vec![
                    RuleFix::remove_range(token_range_at(ctx.source_file, object.pos())),
                    RuleFix::replace_range(
                        token_range_at(ctx.source_file, node.pos()),
                        "Object.fromEntries(",
                    ),
                    RuleFix::replace_range(properties.loc().with_pos(argument.end()), ")"),
                    RuleFix::remove_range(TextRange::new(object.end() - 1, object.end())),
                ],
            }];
        }
    }

    vec![RuleSuggestion {
        message: replace_map_spread_in_object_message(),
        fixes: vec![
            ctx.fix_insert_before(argument, "Object.fromEntries("),
            RuleFix::insert_after(argument, ")"),
        ],
    }]
}
