//! `no-deprecated`: disallows using code marked as `@deprecated`.

use goport_core::ast::{
    is_computed_property_name, is_js_doc_deprecated_tag, is_object_literal_expression,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, LiteralValue};
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{CheckMode, ContextFlags, SymbolFlags, TypeFlags};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, is_symbol_flag_set, is_type_flag_set,
    symbol_matches_specifier_name_and_source, type_matches_some_specifier,
    value_matches_some_specifier,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-deprecated",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
}

fn deprecated_message(name: &str) -> RuleMessage {
    RuleMessage::new("deprecated", format!("`{name}` is deprecated."))
}

fn deprecated_with_reason_message(name: &str, reason: &str) -> RuleMessage {
    RuleMessage::new(
        "deprecatedWithReason",
        format!("`{name}` is deprecated. {reason}"),
    )
}

/// Whether something is deprecated, and the text of its `@deprecated` tag.
type Deprecation = Option<String>;

fn report_deprecation(ctx: &mut RuleContext<'_>, node: Node, name: &str, reason: &str) {
    // tsgolint tests the reason before trimming it.
    let message = if reason.is_empty() {
        deprecated_message(name)
    } else {
        deprecated_with_reason_message(name, reason.trim())
    };
    ctx.report_node(node, message);
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::Identifier, check_identifier_event)
        .on(SyntaxKind::ElementAccessExpression, check_element_access)
        .on(
            SyntaxKind::PropertyAssignment,
            check_object_literal_property,
        )
        .on(
            SyntaxKind::ShorthandPropertyAssignment,
            check_object_literal_property,
        )
        .on(SyntaxKind::MethodDeclaration, check_object_literal_property)
        .on(SyntaxKind::GetAccessor, check_object_literal_property)
        .on(SyntaxKind::SetAccessor, check_object_literal_property)
        .on(SyntaxKind::PrivateIdentifier, check_identifier)
        .on(SyntaxKind::SuperKeyword, check_identifier)
        .into()
}

fn check_identifier_event(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let parent = node.parent();
    if parent.is_nil() {
        return;
    }
    match parent.kind() {
        // The opening element reports; `export *` and `export * as ns` name
        // no deprecated use.
        SyntaxKind::JsxClosingElement
        | SyntaxKind::ExportDeclaration
        | SyntaxKind::NamespaceExport => return,
        SyntaxKind::ExportSpecifier => {
            // `foo` in `export { foo as bar }` is the local name; only the
            // exported name is checked.
            if parent.property_name() == node {
                return;
            }
            // A re-export marked `@deprecated` documents the deprecation.
            if has_deprecated_tag(parent) {
                return;
            }
        }
        _ => {}
    }
    check_identifier(options, ctx, node);
}

fn has_deprecated_tag(node: Node) -> bool {
    node.js_doc(Node::NIL).into_iter().any(|jsdoc| {
        let tags = jsdoc.tags();
        tags.is_some() && tags.nodes().into_iter().any(is_js_doc_deprecated_tag)
    })
}

fn check_identifier(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    if is_declaration(node) || is_inside_import(node) {
        return;
    }
    let Some(reason) = deprecation_reason(ctx.checker, node) else {
        return;
    };
    if !options.allow.is_empty() {
        let t = ctx.checker.get_type_at_location(node);
        let fs = ctx.fs();
        // TODO in tsgolint: skip when the type or the value is allowed.
        if type_matches_some_specifier(ctx.checker, &*fs, t, &options.allow)
            || value_matches_some_specifier(ctx.checker, &*fs, node, &options.allow, t)
        {
            return;
        }
    }
    let name = reported_node_name(node);
    report_deprecation(ctx, node, &name, &reason);
}

fn reported_node_name(node: Node) -> String {
    match node.kind() {
        SyntaxKind::SuperKeyword => "super".to_owned(),
        // The text of a private identifier has its `#` already; tsgolint
        // prints `##name`.
        SyntaxKind::PrivateIdentifier => format!("#{}", node.text()),
        _ => node.text().to_owned(),
    }
}

/// `a['b']` and `a[0]` with a literal key.
fn check_element_access(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let argument = node.argument_expression();
    if argument.is_nil() {
        return;
    }
    let property_type = ctx.checker.get_type_at_location(argument);
    if property_type.is_nil() {
        return;
    }
    let is_literal = ctx.checker.ty(property_type).is_string_literal()
        || is_type_flag_set(
            ctx.checker,
            property_type,
            TypeFlags::NUMBER_LITERAL | TypeFlags::BIG_INT_LITERAL,
        );
    if !is_literal {
        return;
    }
    let object_type = ctx.checker.get_type_at_location(node.expression());
    let Some(property_name) = literal_type_property_name(ctx.checker, property_type) else {
        return;
    };
    let property = ctx
        .checker
        .get_property_of_type(object_type, property_name.as_str());
    let Some(reason) = js_doc_deprecation(ctx.checker, property) else {
        return;
    };
    if type_matches_some_specifier(ctx.checker, &*ctx.fs(), object_type, &options.allow) {
        return;
    }
    report_deprecation(ctx, argument, &property_name, &reason);
}

/// The property name of a literal type: a string value as is, other values
/// as Go's `LiteralType.String()`. None when the type has no value.
fn literal_type_property_name(c: &Checker, t: TypeId) -> Option<String> {
    let literal = c.ty(t).as_literal_type();
    match literal.value()? {
        LiteralValue::String(s) => Some(s.clone()),
        _ => Some(literal.string()),
    }
}

/// A property of an object literal whose contextual type marks it
/// `@deprecated`.
fn check_object_literal_property(options: &mut Options, ctx: &mut RuleContext<'_>, node: Node) {
    let name = node.name();
    let object = node.parent();
    if object.is_nil() || !is_object_literal_expression(object) {
        return;
    }
    let Some(property_name) = object_literal_property_name(ctx.checker, name) else {
        return;
    };
    let contextual_type = ctx
        .checker
        .get_apparent_type_of_contextual_type(object, ContextFlags::NONE);
    if contextual_type.is_nil() {
        return;
    }
    let property = ctx
        .checker
        .get_property_of_type(contextual_type, property_name.as_str());
    if property.is_nil() || !ctx.checker.is_deprecated_symbol(property) {
        return;
    }
    let Some(reason) = js_doc_deprecation(ctx.checker, property) else {
        return;
    };

    if !options.allow.is_empty() {
        let name_type = ctx.checker.get_type_at_location(name);
        let fs = ctx.fs();
        let property_name_allowed = options.allow.iter().any(|specifier| {
            symbol_matches_specifier_name_and_source(
                ctx.checker,
                &*fs,
                property,
                &property_name,
                specifier,
            )
        });
        if type_matches_some_specifier(ctx.checker, &*fs, contextual_type, &options.allow)
            || type_matches_some_specifier(ctx.checker, &*fs, name_type, &options.allow)
            || property_name_allowed
        {
            return;
        }
    }

    let reported_name = if property_name.is_empty() {
        "\"\""
    } else {
        property_name.as_str()
    };
    report_deprecation(ctx, name, reported_name, &reason);
}

/// The static name of an object literal property, or None when it is not
/// known.
fn object_literal_property_name(c: &mut Checker, name: Node) -> Option<String> {
    if name.is_nil() {
        return None;
    }
    if is_computed_property_name(name) {
        let expression = name.expression();
        if expression.is_nil() {
            return None;
        }
        if matches!(
            expression.kind(),
            SyntaxKind::StringLiteral | SyntaxKind::NumericLiteral | SyntaxKind::BigIntLiteral
        ) {
            return Some(expression.text().to_owned());
        }
        let t = c.get_type_at_location(expression);
        if t.is_some() {
            let ty = c.ty(t);
            if ty.is_string_literal() || ty.is_number_literal() || ty.is_big_int_literal() {
                return literal_type_property_name(c, t);
            }
        }
        return None;
    }
    match name.kind() {
        SyntaxKind::Identifier
        | SyntaxKind::PrivateIdentifier
        | SyntaxKind::StringLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral => Some(name.text().to_owned()),
        _ => None,
    }
}

/// The text of the first `@deprecated` tag in the JSDoc of `node`, or "".
fn js_doc_deprecation_text(node: Node) -> String {
    if node.is_nil() {
        return String::new();
    }
    for jsdoc in node.js_doc(Node::NIL) {
        let tags = jsdoc.tags();
        if tags.is_nil() {
            continue;
        }
        if let Some(tag) = tags
            .nodes()
            .into_iter()
            .find(|&tag| is_js_doc_deprecated_tag(tag))
        {
            let comment = tag.comment();
            if comment.is_nil() {
                return String::new();
            }
            return comment.nodes().into_iter().map(|n| n.text()).collect();
        }
    }
    String::new()
}

/// The deprecation of the first declaration of `symbol` that the checker
/// considers deprecated.
fn js_doc_deprecation(c: &mut Checker, symbol: SymbolId) -> Deprecation {
    if symbol.is_nil() {
        return None;
    }
    let declarations = c.sym(symbol).declarations.to_vec();
    declarations
        .into_iter()
        .find(|&declaration| c.is_deprecated_declaration(declaration))
        .map(js_doc_deprecation_text)
}

/// Walks the alias chain of `symbol`: the first deprecated alias, or with
/// `check_aliased_symbol` the deprecation of the final target.
fn search_alias_chain(
    c: &mut Checker,
    symbol: SymbolId,
    check_aliased_symbol: bool,
) -> Deprecation {
    if symbol.is_nil() {
        return None;
    }
    if !is_symbol_flag_set(c, symbol, SymbolFlags::ALIAS) {
        return if check_aliased_symbol {
            js_doc_deprecation(c, symbol)
        } else {
            None
        };
    }

    let target = c.get_aliased_symbol(symbol);
    let mut symbol = symbol;
    while is_symbol_flag_set(c, symbol, SymbolFlags::ALIAS) {
        if let Some(reason) = js_doc_deprecation(c, symbol) {
            return Some(reason);
        }
        if c.get_declaration_of_alias_symbol(symbol).is_nil() {
            break;
        }
        let immediate = c.get_immediate_aliased_symbol(symbol);
        if immediate.is_nil() {
            break;
        }
        symbol = immediate;
        if check_aliased_symbol && symbol == target {
            return js_doc_deprecation(c, symbol);
        }
    }
    None
}

/// The deprecation of the callee of a call, `new`, tagged template or JSX
/// element: its resolved signature, else its symbol.
fn call_like_deprecation(c: &mut Checker, node: Node) -> Deprecation {
    if node.is_nil() || node.parent().is_nil() {
        return None;
    }
    let signature = c.get_resolved_signature(node.parent(), None, CheckMode::NORMAL);
    if signature.is_nil() {
        return None;
    }
    let signature_declaration = c.sig(signature).declaration();
    if signature_declaration.is_some() && c.is_deprecated_declaration(signature_declaration) {
        return Some(js_doc_deprecation_text(signature_declaration));
    }

    let symbol = c.get_symbol_at_location_exported(node);
    if symbol.is_nil() {
        return None;
    }
    let aliased = if is_symbol_flag_set(c, symbol, SymbolFlags::ALIAS) {
        c.get_aliased_symbol(symbol)
    } else {
        symbol
    };
    let declaration_kind = if aliased.is_some() {
        c.sym(aliased).declarations.first().map(|d| d.kind())
    } else {
        None
    };

    if !matches!(
        declaration_kind,
        Some(
            SyntaxKind::MethodDeclaration
                | SyntaxKind::FunctionDeclaration
                | SyntaxKind::MethodSignature
        )
    ) {
        // A property of function type has `@deprecated` on its symbol, not on
        // its signatures.
        return search_alias_chain(c, symbol, true);
    }
    // Functions and methods rely on the signature checked above.
    if let Some(reason) = search_alias_chain(c, symbol, false) {
        return Some(reason);
    }
    if signature_declaration.is_nil() {
        return js_doc_deprecation(c, aliased);
    }
    None
}

/// The deprecation of the attribute `property_name` of a JSX element.
fn jsx_attribute_deprecation(c: &mut Checker, element: Node, property_name: &str) -> Deprecation {
    if element.is_nil() {
        return None;
    }
    let tag_name = match element.kind() {
        SyntaxKind::JsxSelfClosingElement | SyntaxKind::JsxOpeningElement => element.tag_name(),
        _ => Node::NIL,
    };
    if tag_name.is_nil() {
        return None;
    }
    let contextual_type = c.get_contextual_type(tag_name, ContextFlags::NONE);
    if contextual_type.is_nil() {
        return None;
    }
    let symbol = c.get_property_of_type(contextual_type, property_name);
    js_doc_deprecation(c, symbol)
}

/// The type that the binding pattern (or binding element) `node` destructures,
/// found by walking up to its declaration. None when it is not known.
fn binding_pattern_source_type(c: &mut Checker, node: Node) -> Option<TypeId> {
    let mut current = node;
    while current.is_some() {
        match current.kind() {
            SyntaxKind::VariableDeclaration => {
                let initializer = current.initializer();
                return initializer
                    .is_some()
                    .then(|| c.get_type_at_location(initializer));
            }
            SyntaxKind::Parameter => return Some(c.get_type_at_location(current)),
            SyntaxKind::BindingElement => {
                // `{ bar: { anchor } }`: the type of the parent's property.
                let parent_pattern = current.parent();
                if parent_pattern.is_nil() {
                    return None;
                }
                let parent_type = binding_pattern_source_type(c, parent_pattern)?;
                let property_name = current.property_name();
                let name = if property_name.is_some() {
                    if property_name.kind() == SyntaxKind::ComputedPropertyName {
                        return None;
                    }
                    property_name.text()
                } else {
                    let name = current.name();
                    if name.is_nil() {
                        ""
                    } else if matches!(
                        name.kind(),
                        SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
                    ) {
                        // `const [{ anchor }] = x` has no property name.
                        return None;
                    } else {
                        name.text()
                    }
                };
                if name.is_empty() {
                    return None;
                }
                let property = c.get_property_of_type(parent_type, name);
                return property
                    .is_some()
                    .then(|| c.get_type_of_symbol_at_location(property, current));
            }
            SyntaxKind::ArrayBindingPattern => {
                // The first element of a tuple, else the array type itself.
                let parent_type = binding_pattern_source_type(c, current.parent())?;
                let property = c.get_property_of_type(parent_type, "0");
                if property.is_some() {
                    return Some(c.get_type_of_symbol_at_location(property, current));
                }
                return Some(parent_type);
            }
            _ => {}
        }
        current = current.parent();
    }
    None
}

/// The deprecation of what an identifier, private identifier or `super`
/// refers to.
fn deprecation_reason(c: &mut Checker, node: Node) -> Deprecation {
    let call_like = call_like_node(node);
    if call_like.is_some() {
        return call_like_deprecation(c, call_like);
    }

    let parent = node.parent();
    let is_super = node.kind() == SyntaxKind::SuperKeyword;
    if parent.is_some() && parent.kind() == SyntaxKind::JsxAttribute && !is_super {
        // JsxAttribute, then JsxAttributes, then the element.
        let attributes = parent.parent();
        if attributes.is_some() && attributes.parent().is_some() {
            return jsx_attribute_deprecation(c, attributes.parent(), node.text());
        }
    }

    if parent.is_some() && !is_super {
        // `const { b } = a`: a destructured property.
        if parent.kind() == SyntaxKind::BindingElement {
            let pattern = parent.parent();
            if pattern.is_some()
                && matches!(
                    pattern.kind(),
                    SyntaxKind::ObjectBindingPattern | SyntaxKind::ArrayBindingPattern
                )
            {
                // Nested destructuring falls back to the pattern's type.
                let source_type = binding_pattern_source_type(c, pattern)
                    .unwrap_or_else(|| c.get_type_at_location(pattern));
                if source_type.is_some() {
                    let element_property_name = parent.property_name();
                    let property_name = if element_property_name.is_some() {
                        if element_property_name.kind() == SyntaxKind::ComputedPropertyName {
                            return None;
                        }
                        element_property_name.text()
                    } else {
                        node.text()
                    };
                    let property = c.get_property_of_type(source_type, property_name);
                    let property_symbol = c.get_symbol_at_location_exported(node);
                    if let Some(reason) = search_alias_chain(c, property_symbol, true)
                        .or_else(|| js_doc_deprecation(c, property))
                        .or_else(|| js_doc_deprecation(c, property_symbol))
                        .or_else(|| {
                            let value_symbol = shorthand_value_symbol(c, property_symbol);
                            js_doc_deprecation(c, value_symbol)
                        })
                    {
                        return Some(reason);
                    }
                }
            }
        }

        // `{ a }` in an object literal.
        if parent.kind() == SyntaxKind::ShorthandPropertyAssignment && parent.parent().is_some() {
            let parent_type = c.get_type_at_location(parent.parent());
            if parent_type.is_some() {
                let property_symbol = c.get_symbol_at_location_exported(node);
                let property = c.get_property_of_type(parent_type, node.text());
                if let Some(reason) = search_alias_chain(c, property_symbol, true)
                    .or_else(|| js_doc_deprecation(c, property))
                    .or_else(|| js_doc_deprecation(c, property_symbol))
                    .or_else(|| {
                        let value_symbol = shorthand_value_symbol(c, property_symbol);
                        search_alias_chain(c, value_symbol, true)
                    })
                {
                    return Some(reason);
                }
            }
        }
    }

    let symbol = c.get_symbol_at_location_exported(node);
    search_alias_chain(c, symbol, true)
}

/// The value symbol of the shorthand property that declares `symbol`, or nil.
fn shorthand_value_symbol(c: &mut Checker, symbol: SymbolId) -> SymbolId {
    if symbol.is_nil() {
        return SymbolId::NIL;
    }
    let declaration = c.sym(symbol).value_declaration;
    if declaration.is_nil() {
        return SymbolId::NIL;
    }
    c.get_shorthand_assignment_value_symbol(declaration)
}

/// The callee of a call, `new`, tagged template or JSX element that `node`
/// names (walking up from `c` in `a.b.c()`), or nil.
fn call_like_node(node: Node) -> Node {
    let mut callee = node;
    loop {
        let parent = callee.parent();
        if parent.is_nil()
            || parent.kind() != SyntaxKind::PropertyAccessExpression
            || parent.name() != callee
        {
            break;
        }
        callee = parent;
    }
    if is_callee_of_parent(callee) {
        callee
    } else {
        Node::NIL
    }
}

fn is_callee_of_parent(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        SyntaxKind::NewExpression | SyntaxKind::CallExpression => parent.expression() == node,
        SyntaxKind::TaggedTemplateExpression => parent.tag() == node,
        SyntaxKind::JsxOpeningElement => parent.tag_name() == node,
        _ => false,
    }
}

/// Whether `node` is the name that a declaration declares. Object binding
/// patterns are not declarations here: they also read properties.
fn is_declaration(node: Node) -> bool {
    let parent = node.parent();
    if parent.is_nil() {
        return false;
    }
    match parent.kind() {
        SyntaxKind::BindingElement => {
            parent.parent().is_some()
                && parent.parent().kind() == SyntaxKind::ArrayBindingPattern
                && parent.name() == node
        }
        SyntaxKind::ClassExpression
        | SyntaxKind::VariableDeclaration
        | SyntaxKind::EnumMember
        | SyntaxKind::ClassDeclaration
        | SyntaxKind::MethodDeclaration
        | SyntaxKind::PropertyDeclaration
        | SyntaxKind::GetAccessor
        | SyntaxKind::SetAccessor
        | SyntaxKind::ImportEqualsDeclaration => parent.name() == node,
        // The key of `{ key: value }` declares; the value uses.
        SyntaxKind::PropertyAssignment => {
            parent.initializer() != node
                && parent.parent().is_some()
                && parent.parent().kind() == SyntaxKind::ObjectLiteralExpression
        }
        SyntaxKind::ArrowFunction
        | SyntaxKind::FunctionDeclaration
        | SyntaxKind::FunctionExpression
        | SyntaxKind::EnumDeclaration
        | SyntaxKind::InterfaceDeclaration
        | SyntaxKind::ModuleDeclaration
        | SyntaxKind::MethodSignature
        | SyntaxKind::PropertySignature
        | SyntaxKind::TypeAliasDeclaration
        | SyntaxKind::TypeParameter
        | SyntaxKind::Parameter => true,
        _ => false,
    }
}

/// Whether `node` is in an import declaration, stopping at a block,
/// function or class declaration.
fn is_inside_import(node: Node) -> bool {
    let mut current = node;
    while current.is_some() {
        match current.kind() {
            SyntaxKind::ImportDeclaration => return true,
            SyntaxKind::SourceFile
            | SyntaxKind::Block
            | SyntaxKind::FunctionDeclaration
            | SyntaxKind::ClassDeclaration => return false,
            _ => {}
        }
        current = current.parent();
    }
    false
}
