//! `unbound-method`: reports class methods used without their `this`
//! binding.

use goport_core::ast::{
    get_source_file_of_node, is_access_expression, is_assignment_expression, is_binding_element,
    is_computed_property_name, is_function_expression, is_identifier, is_interface_declaration,
    is_logical_binary_operator, is_parameter_declaration, is_property_assignment,
    is_shorthand_property_assignment, is_variable_declaration,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage,
    decode_options,
};

use crate::utils::{
    includes_modifier, is_any_builtin_symbol_like, is_builtin_symbol_like,
    is_source_file_default_library, trim_node_text_range, type_recurser,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "unbound-method",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    ignore_static: bool,
}

const BASE_MESSAGE: &str =
    "Avoid referencing unbound methods which may cause unintentional scoping of `this`.";

fn unbound_message() -> RuleMessage {
    RuleMessage::new("unbound", BASE_MESSAGE)
}

fn unbound_without_this_annotation_message() -> RuleMessage {
    RuleMessage::new("unboundWithoutThisAnnotation", BASE_MESSAGE).with_help(
        "If your function does not access `this`, you can annotate it with `this: void`, or consider using an arrow function instead.",
    )
}

/// Global types whose methods tsgolint treats as bound when the property's
/// type also comes from the default library.
const SUPPORTED_GLOBAL_TYPES: &[&str] = &[
    "NumberConstructor",
    "ObjectConstructor",
    "StringConstructor",
    "SymbolConstructor",
    "ArrayConstructor",
    "Array",
    "ProxyConstructor",
    "Console",
    "DateConstructor",
    "Atomics",
    "Math",
    "JSON",
];

/// Members of global objects that do not use `this` (tsgolint's generated
/// `natively_bound_members.go`).
const NATIVELY_BOUND_MEMBERS: &[(&str, &[&str])] = &[
    (
        "Number",
        &[
            "isFinite",
            "isInteger",
            "isNaN",
            "isSafeInteger",
            "parseFloat",
            "parseInt",
        ],
    ),
    (
        "Object",
        &[
            "assign",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
            "getOwnPropertyNames",
            "getOwnPropertySymbols",
            "hasOwn",
            "is",
            "preventExtensions",
            "seal",
            "create",
            "defineProperties",
            "defineProperty",
            "freeze",
            "getPrototypeOf",
            "setPrototypeOf",
            "isExtensible",
            "isFrozen",
            "isSealed",
            "keys",
            "entries",
            "fromEntries",
            "values",
            "groupBy",
        ],
    ),
    ("String", &["fromCharCode", "fromCodePoint", "raw"]),
    ("RegExp", &[]),
    ("Symbol", &["for", "keyFor"]),
    ("Array", &["isArray", "from", "of", "fromAsync"]),
    ("Proxy", &["revocable"]),
    ("Date", &["now", "parse", "UTC"]),
    (
        "Atomics",
        &[
            "load",
            "store",
            "add",
            "sub",
            "and",
            "or",
            "xor",
            "exchange",
            "compareExchange",
            "isLockFree",
            "wait",
            "waitAsync",
            "notify",
        ],
    ),
    (
        "Reflect",
        &[
            "defineProperty",
            "deleteProperty",
            "apply",
            "construct",
            "get",
            "getOwnPropertyDescriptor",
            "getPrototypeOf",
            "has",
            "isExtensible",
            "ownKeys",
            "preventExtensions",
            "set",
            "setPrototypeOf",
        ],
    ),
    (
        "console",
        &[
            "log",
            "info",
            "debug",
            "warn",
            "error",
            "dir",
            "time",
            "timeEnd",
            "timeLog",
            "trace",
            "assert",
            "clear",
            "count",
            "countReset",
            "group",
            "groupEnd",
            "table",
            "dirxml",
            "groupCollapsed",
            "Console",
            "profile",
            "profileEnd",
            "timeStamp",
            "context",
            "createTask",
        ],
    ),
    (
        "Math",
        &[
            "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "ceil", "cbrt",
            "expm1", "clz32", "cos", "cosh", "exp", "floor", "fround", "hypot", "imul", "log",
            "log1p", "log2", "log10", "max", "min", "pow", "random", "round", "sign", "sin",
            "sinh", "sqrt", "tan", "tanh", "trunc",
        ],
    ),
    ("JSON", &["parse", "stringify", "rawJSON", "isRawJSON"]),
    (
        "Intl",
        &[
            "getCanonicalLocales",
            "supportedValuesOf",
            "DateTimeFormat",
            "NumberFormat",
            "Collator",
            "PluralRules",
            "RelativeTimeFormat",
            "ListFormat",
            "Locale",
            "DisplayNames",
            "Segmenter",
        ],
    ),
];

fn is_natively_bound_member(object: &str, property: &str) -> bool {
    NATIVELY_BOUND_MEMBERS
        .iter()
        .any(|&(name, members)| name == object && members.contains(&property))
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::PropertyAccessExpression, check_property_access)
        .on(
            Listener::allow_pattern(SyntaxKind::ObjectLiteralExpression),
            check_assignment_pattern,
        )
        .on(SyntaxKind::ObjectBindingPattern, check_binding_pattern)
        .into()
}

fn check_property_access(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    if is_safe_use(node) || is_natively_bound(ctx, node.expression(), node.name()) {
        return;
    }
    let symbol = ctx.checker.get_symbol_at_location_exported(node);
    check_if_method_and_report(options, ctx, node, node.name(), symbol);
}

fn check_assignment_pattern(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let parent = node.parent();
    if !is_assignment_expression(parent, true) {
        return;
    }
    let init = parent.right();
    for property in node.properties() {
        if is_property_assignment(property) || is_shorthand_property_assignment(property) {
            check_binding_property(options, ctx, node, init, property.name(), true);
        }
    }
}

fn check_binding_pattern(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    if is_node_inside_type_declaration(node) {
        return;
    }
    let parent = node.parent();
    let parent_is_assignment_pattern_like =
        is_binding_element(parent) || is_parameter_declaration(parent);
    let init = if is_variable_declaration(parent) || parent_is_assignment_pattern_like {
        parent.initializer()
    } else {
        Node::NIL
    };
    for element in node.elements() {
        if !is_binding_element(element) {
            continue;
        }
        let property_name = match element.property_name() {
            name if name.is_some() => name,
            _ => element.name(),
        };
        if element.dot_dot_dot_token().is_some() || !is_identifier(property_name) {
            continue;
        }
        check_binding_property(
            options,
            ctx,
            node,
            init,
            property_name,
            parent_is_assignment_pattern_like,
        );
    }
}

fn check_binding_property(
    options: &Options,
    ctx: &mut RuleContext<'_>,
    pattern: Node,
    init: Node,
    property_name: Node,
    parent_is_assignment_pattern_like: bool,
) {
    // A computed name cannot be resolved statically.
    if is_computed_property_name(property_name) {
        return;
    }
    if init.is_some() {
        if !is_natively_bound(ctx, init, property_name) {
            let init_type = ctx.checker.get_type_at_location(init);
            let symbol = ctx
                .checker
                .get_property_of_type(init_type, property_name.text());
            if check_if_method_and_report(options, ctx, property_name, property_name, symbol) {
                return;
            }
            // In a pattern with a default value, the default may be the
            // natively bound object, so the declared type is checked too:
            // `function ({ nativelyBound }: Foo = NativeObject) {}`.
        } else if !parent_is_assignment_pattern_like {
            return;
        }
    }
    let pattern_type = ctx.checker.get_type_at_location(pattern);
    let source_file = ctx.source_file;
    // The walk stops at the first report.
    let mut report = None;
    type_recurser(ctx.checker, pattern_type, |checker, t| {
        if is_spec_bound_builtin_method(checker, t, property_name) {
            return false;
        }
        let symbol = checker.get_property_of_type(t, property_name.text());
        report = method_report(
            checker,
            options,
            source_file,
            property_name,
            property_name,
            symbol,
        );
        report.is_some()
    });
    if let Some(report) = report {
        ctx.report_diagnostic(report);
    }
}

/// Reports `node` when `symbol` is a method that needs its `this`.
fn check_if_method_and_report(
    options: &Options,
    ctx: &mut RuleContext<'_>,
    node: Node,
    dangerous_reference: Node,
    symbol: SymbolId,
) -> bool {
    let report = method_report(
        ctx.checker,
        options,
        ctx.source_file,
        node,
        dangerous_reference,
        symbol,
    );
    match report {
        Some(report) => {
            ctx.report_diagnostic(report);
            true
        }
        None => false,
    }
}

/// The report for `node` when `symbol` is a method that needs its `this`.
fn method_report(
    checker: &Checker,
    options: &Options,
    source_file: Node,
    node: Node,
    dangerous_reference: Node,
    symbol: SymbolId,
) -> Option<Report> {
    if symbol.is_nil() {
        return None;
    }
    let message = check_if_method(checker, symbol, options.ignore_static)?;
    let range = trim_node_text_range(source_file, node);
    let dangerous_range = trim_node_text_range(source_file, dangerous_reference);
    let mut report = Report::new(range, message);
    if range != dangerous_range {
        report = report.with_label(
            "This reference may be unbound and lose `this` context",
            dangerous_range,
        );
    }
    Some(report)
}

/// The message for a reference to `symbol` when it is a method that needs
/// its `this`, judged by its value declaration.
fn check_if_method(
    checker: &Checker,
    symbol: SymbolId,
    ignore_static: bool,
) -> Option<RuleMessage> {
    // The value declaration can be missing (microsoft/TypeScript#31294).
    let declaration = checker.sym(symbol).value_declaration;
    if declaration.is_nil() {
        return None;
    }
    match declaration.kind() {
        SyntaxKind::PropertyDeclaration => {
            let initializer = declaration.initializer();
            (initializer.is_some() && is_function_expression(initializer)).then(unbound_message)
        }
        SyntaxKind::PropertyAssignment => {
            let initializer = declaration.initializer();
            if is_function_expression(initializer) {
                check_method(initializer, ignore_static)
            } else {
                None
            }
        }
        SyntaxKind::MethodDeclaration | SyntaxKind::MethodSignature => {
            check_method(declaration, ignore_static)
        }
        _ => None,
    }
}

fn check_method(declaration: Node, ignore_static: bool) -> Option<RuleMessage> {
    let first = declaration.parameters().first();
    let first_param_is_this = first.is_some_and(|first| {
        is_parameter_declaration(first)
            && is_identifier(first.name())
            && first.name().text() == "this"
    });
    let this_is_void = first_param_is_this
        && first.is_some_and(|first| first.type_().kind() == SyntaxKind::VoidKeyword);
    let dangerous = !this_is_void
        && (!ignore_static || !includes_modifier(declaration, SyntaxKind::StaticKeyword));
    if !dangerous {
        return None;
    }
    Some(if first_param_is_this {
        unbound_message()
    } else {
        unbound_without_this_annotation_message()
    })
}

/// `Intl.Collator.prototype.compare` is a bound getter (ECMA-402) that the
/// lib declares as a method; only the lib's declaration is exempt.
fn is_spec_bound_builtin_method(
    checker: &mut Checker,
    object_type: TypeId,
    property: Node,
) -> bool {
    if !is_identifier(property) || property.text() != "compare" {
        return false;
    }
    let symbol = checker.get_property_of_type(object_type, property.text());
    if symbol.is_nil() {
        return false;
    }
    let declarations = &checker.sym(symbol).declarations;
    !declarations.is_empty()
        && declarations.iter().all(|&declaration| {
            let owner = declaration.parent();
            owner.is_some()
                && is_interface_declaration(owner)
                && owner.name().text() == "Collator"
                && is_source_file_default_library(get_source_file_of_node(declaration))
        })
}

fn is_natively_bound(ctx: &mut RuleContext<'_>, object: Node, property: Node) -> bool {
    // Declarations do not always come from the default library (for example
    // `@types/node`), so known global members are checked by name first.
    if is_identifier(object)
        && is_identifier(property)
        && is_natively_bound_member(object.text(), property.text())
    {
        let symbol = ctx.checker.get_symbol_at_location_exported(object);
        if symbol.is_some() && is_not_imported(ctx.checker, symbol, ctx.source_file) {
            return true;
        }
    }
    let object_type = ctx.checker.get_type_at_location(object);
    if is_spec_bound_builtin_method(ctx.checker, object_type, property) {
        return true;
    }
    if !is_builtin_symbol_like(ctx.checker, object_type, SUPPORTED_GLOBAL_TYPES) {
        return false;
    }
    let property_type = ctx.checker.get_type_at_location(property);
    is_any_builtin_symbol_like(ctx.checker, property_type)
}

fn is_not_imported(checker: &Checker, symbol: SymbolId, source_file: Node) -> bool {
    // The value declaration can be missing (microsoft/TypeScript#31294).
    let declaration = checker.sym(symbol).value_declaration;
    declaration.is_some() && get_source_file_of_node(declaration) != source_file
}

fn is_node_inside_type_declaration(node: Node) -> bool {
    let mut parent = node.parent();
    while parent.is_some() {
        let inside = match parent.kind() {
            SyntaxKind::ClassDeclaration | SyntaxKind::VariableStatement => {
                includes_modifier(parent, SyntaxKind::DeclareKeyword)
            }
            SyntaxKind::MethodDeclaration => includes_modifier(parent, SyntaxKind::AbstractKeyword),
            SyntaxKind::FunctionDeclaration => parent.body().is_nil(),
            SyntaxKind::FunctionType
            | SyntaxKind::InterfaceDeclaration
            | SyntaxKind::TypeAliasDeclaration => true,
            _ => false,
        };
        if inside {
            return true;
        }
        parent = parent.parent();
    }
    false
}

/// The method reference is called, tested or otherwise used without
/// losing `this`.
fn is_safe_use(node: Node) -> bool {
    let mut node = node;
    loop {
        let parent = node.parent();
        if parent.is_nil() {
            return false;
        }
        match parent.kind() {
            SyntaxKind::ParenthesizedExpression
            | SyntaxKind::NonNullExpression
            | SyntaxKind::AsExpression
            | SyntaxKind::TypeAssertionExpression => {}
            SyntaxKind::IfStatement
            | SyntaxKind::ForStatement
            | SyntaxKind::PropertyAccessExpression
            | SyntaxKind::ElementAccessExpression
            | SyntaxKind::SwitchStatement
            | SyntaxKind::WhileStatement
            | SyntaxKind::DeleteExpression
            | SyntaxKind::TypeOfExpression
            | SyntaxKind::VoidExpression => return true,
            SyntaxKind::PostfixUnaryExpression => {
                return matches!(
                    parent.operator(),
                    SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
                );
            }
            SyntaxKind::PrefixUnaryExpression => {
                return matches!(
                    parent.operator(),
                    SyntaxKind::PlusPlusToken
                        | SyntaxKind::MinusMinusToken
                        | SyntaxKind::ExclamationToken
                );
            }
            SyntaxKind::CallExpression => return parent.expression() == node,
            SyntaxKind::ConditionalExpression => return parent.condition() == node,
            SyntaxKind::TaggedTemplateExpression => return parent.tag() == node,
            SyntaxKind::BinaryExpression => {
                let operator = parent.operator_token().kind();
                match operator {
                    // `&&` returns its left side only when it is falsy.
                    SyntaxKind::AmpersandAmpersandToken if parent.left() == node => return true,
                    // Otherwise the logical expression can return the method,
                    // so its own use decides.
                    SyntaxKind::AmpersandAmpersandToken => {}
                    SyntaxKind::ExclamationEqualsToken
                    | SyntaxKind::ExclamationEqualsEqualsToken
                    | SyntaxKind::EqualsEqualsToken
                    | SyntaxKind::EqualsEqualsEqualsToken
                    | SyntaxKind::InstanceOfKeyword => return true,
                    _ if is_logical_binary_operator(operator) => {}
                    _ if is_assignment_expression(parent, true) => {
                        let left = parent.left();
                        return node == left
                            || (is_access_expression(node)
                                && node.expression().kind() == SyntaxKind::SuperKeyword
                                && is_access_expression(left)
                                && left.expression().kind() == SyntaxKind::ThisKeyword);
                    }
                    _ => return false,
                }
            }
            _ => return false,
        }
        node = parent;
    }
}
