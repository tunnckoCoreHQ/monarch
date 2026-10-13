//! `no-unsafe-assignment`: disallows assigning an `any` typed value to a
//! variable, a property, a parameter default or a destructuring target.

use goport_core::ast::{
    get_source_file_of_node, is_array_binding_pattern, is_array_literal_expression,
    is_assignment_expression, is_computed_property_name, is_literal_expression,
    is_object_binding_pattern, is_object_literal_expression, is_property_assignment,
    is_shorthand_property_assignment, is_spread_assignment, is_spread_element, skip_parentheses,
    source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use rustc_hash::FxHashMap;
use serde_json::Value;
use tsgolint_core::diagnostic::TextRange;
use tsgolint_core::{
    Listener, Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage,
};

use crate::utils::{
    any_typed_this_expression, get_contextual_type, is_intrinsic_error_type,
    is_type_any_array_type, is_type_any_type, is_type_unknown_type, is_unsafe_assignment,
    trim_node_text_range, type_to_string_or_error,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-assignment",
    create,
};

fn sender_type_name(checker: &Checker, sender: TypeId) -> &'static str {
    if is_intrinsic_error_type(checker, sender) {
        "error typed"
    } else {
        "any"
    }
}

fn any_assignment_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "anyAssignment",
        format!("Unsafe assignment of an {sender} value."),
    )
}

fn any_assignment_this_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "anyAssignmentThis",
        format!("Unsafe assignment of an {sender} value. `this` is typed as `any`.\n"),
    )
    .with_help(
        "You can try to fix this by turning on the `noImplicitThis` compiler option, or adding a `this` parameter to the function.",
    )
}

fn unsafe_array_pattern_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeArrayPattern",
        format!("Unsafe array destructuring of an {sender} array value."),
    )
}

fn unsafe_array_pattern_from_tuple_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeArrayPatternFromTuple",
        format!("Unsafe array destructuring of a tuple element with an {sender} value."),
    )
}

fn unsafe_array_spread_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeArraySpread",
        format!("Unsafe spread of an {sender} value in an array."),
    )
}

fn unsafe_assignment_message() -> RuleMessage {
    RuleMessage::new(
        "unsafeAssignment",
        "Unsafe assignment between incompatible types.",
    )
}

/// What the sender is compared against.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Comparison {
    /// No comparison: the receiver's type is inferred from the sender.
    None,
    /// The receiver's type.
    Basic,
    /// The sender's contextual type.
    Contextual,
}

struct State {
    no_implicit_this: bool,
}

fn create(ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    let options = ctx.compiler_options();
    let no_implicit_this = options.get_strict_option_value(options.no_implicit_this);
    Listeners::new(State { no_implicit_this })
        .on(SyntaxKind::PropertyDeclaration, check_property_declaration)
        .on(SyntaxKind::BinaryExpression, check_binary_expression)
        .on(SyntaxKind::BindingElement, check_initialized_declaration)
        .on(SyntaxKind::Parameter, check_initialized_declaration)
        .on(
            SyntaxKind::ShorthandPropertyAssignment,
            check_shorthand_default,
        )
        .on(SyntaxKind::VariableDeclaration, check_variable_declaration)
        .on(
            Listener::not_allow_pattern(SyntaxKind::ObjectLiteralExpression),
            check_object_literal,
        )
        .on(
            Listener::not_allow_pattern(SyntaxKind::ArrayLiteralExpression),
            check_array_literal,
        )
        .on(SyntaxKind::JsxAttribute, check_jsx_attribute)
        .into()
}

/// The `=` (or else the `:`) between the receiver and the sender, or the
/// receiver itself.
fn assignment_relation_range(source_file: Node, receiver: Node, sender: Node) -> TextRange {
    let text = source_file_text(source_file);
    let mut scanner = get_scanner_for_source_file(source_file, &text, receiver.end());
    let mut colon = None;
    while scanner.token() != SyntaxKind::EndOfFile && scanner.token_range().pos() < sender.end() {
        match scanner.token() {
            SyntaxKind::EqualsToken => return scanner.token_range(),
            SyntaxKind::ColonToken => colon = Some(scanner.token_range()),
            _ => {}
        }
        if scanner.token_range().pos() >= sender.pos() {
            break;
        }
        scanner.scan();
    }
    colon.unwrap_or_else(|| trim_node_text_range(source_file, receiver))
}

/// The type annotation when it is in this file, else the receiver.
fn local_target_range(source_file: Node, receiver: Node, type_annotation: Node) -> TextRange {
    if type_annotation.is_some() && get_source_file_of_node(type_annotation) == source_file {
        trim_node_text_range(source_file, type_annotation)
    } else {
        trim_node_text_range(source_file, receiver)
    }
}

/// Whether the sender's syntax rules out an `any` type.
fn can_skip_sender_type_check(node: Node, comparison: Comparison) -> bool {
    let node = skip_parentheses(node);
    match node.kind() {
        SyntaxKind::StringLiteral
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral
        | SyntaxKind::RegularExpressionLiteral
        | SyntaxKind::NoSubstitutionTemplateLiteral
        | SyntaxKind::TrueKeyword
        | SyntaxKind::FalseKeyword
        | SyntaxKind::NullKeyword
        | SyntaxKind::ArrowFunction
        | SyntaxKind::FunctionExpression
        | SyntaxKind::ClassExpression => true,
        SyntaxKind::PrefixUnaryExpression => {
            matches!(
                node.operator(),
                SyntaxKind::PlusToken | SyntaxKind::MinusToken
            ) && skip_parentheses(node.operand()).kind() == SyntaxKind::NumericLiteral
        }
        SyntaxKind::ObjectLiteralExpression => !node.properties().iter().any(is_spread_assignment),
        SyntaxKind::ArrayLiteralExpression => {
            comparison == Comparison::None && !node.elements().iter().any(is_spread_element)
        }
        _ => false,
    }
}

fn report_destructure(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender: Node,
    sender_type: TypeId,
    unsafe_type: &str,
    message: RuleMessage,
) {
    let receiver_range = ctx.trim_node_text_range(receiver);
    let sender_type = type_to_string_or_error(ctx.checker, sender_type);
    let report = Report::new(receiver_range, message)
        .with_label(
            format!("Destructured source provides type `{sender_type}`."),
            ctx.trim_node_text_range(sender),
        )
        .with_label(
            format!("This binding receives type `{unsafe_type}`."),
            receiver_range,
        );
    ctx.report_diagnostic(report);
}

/// Checks the destructured element `receiver` against `sender_type`.
/// Returns true when it reported.
fn check_destructured_element(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender_type: TypeId,
    sender: Node,
) -> bool {
    // Check for `any` first, for `{x: {y: z}} = {x: any}` and `[[[x]]] = [any]`.
    if is_type_any_type(ctx.checker, sender_type) {
        let unsafe_type = type_to_string_or_error(ctx.checker, sender_type);
        // tsgolint uses the tuple message for object properties too.
        let message =
            unsafe_array_pattern_from_tuple_message(sender_type_name(ctx.checker, sender_type));
        report_destructure(ctx, receiver, sender, sender_type, &unsafe_type, message);
        true
    } else if is_array_binding_pattern(receiver) || is_array_literal_expression(receiver) {
        check_array_destructure(ctx, receiver, sender_type, sender)
    } else if is_object_binding_pattern(receiver) || is_object_literal_expression(receiver) {
        check_object_destructure(ctx, receiver, sender_type, sender)
    } else {
        false
    }
}

/// Returns true when it reported.
fn check_object_destructure(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender_type: TypeId,
    sender: Node,
) -> bool {
    let property_symbols = ctx.checker.get_properties_of_type(sender_type);
    let mut properties = FxHashMap::default();
    for &property in property_symbols.iter() {
        let name = ctx.checker.sym(property).name.as_str().to_string();
        let t = ctx.checker.get_type_of_symbol_at_location(property, sender);
        properties.insert(name, t);
    }

    let check_property = |ctx: &mut RuleContext<'_>, key: Node, value: Node| -> bool {
        let key = if !is_computed_property_name(key) {
            key.text().to_string()
        } else if is_literal_expression(key.expression()) {
            key.expression().text().to_string()
        } else {
            // The name is unknown.
            return false;
        };
        match properties.get(&key) {
            Some(&property_type) => check_destructured_element(ctx, value, property_type, sender),
            None => false,
        }
    };

    let mut did_report = false;
    if is_object_literal_expression(receiver) {
        for property in receiver.properties().iter() {
            // Rests are not checked.
            if is_spread_assignment(property) {
                continue;
            }
            if (is_property_assignment(property)
                && check_property(ctx, property.name(), property.initializer()))
                || (is_shorthand_property_assignment(property)
                    && check_property(ctx, property.name(), property.name()))
            {
                did_report = true;
            }
        }
    } else if is_object_binding_pattern(receiver) {
        for element in receiver.elements().iter() {
            if element.dot_dot_dot_token().is_some() {
                continue;
            }
            let mut key = element.property_name();
            if key.is_nil() {
                key = element.name();
            }
            if check_property(ctx, key, element.name()) {
                did_report = true;
            }
        }
    }
    did_report
}

/// Returns true when it reported, and also for senders that are not tuples.
fn check_array_destructure(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender_type: TypeId,
    sender: Node,
) -> bool {
    // `const [x] = [] as any[]`
    if is_type_any_array_type(ctx.checker, sender_type) {
        let message = unsafe_array_pattern_message(sender_type_name(ctx.checker, sender_type));
        report_destructure(ctx, receiver, sender, sender_type, "any", message);
        // tsgolint returns false here, so the object check still runs.
        return false;
    }
    if !ctx.checker.is_tuple_type(sender_type) {
        return true;
    }

    let tuple_elements = ctx.checker.get_type_arguments(sender_type);
    let check_element = |ctx: &mut RuleContext<'_>, element: Node, index: usize| -> bool {
        if element.is_nil() {
            return false;
        }
        match tuple_elements.get(index) {
            Some(&element_type) => check_destructured_element(ctx, element, element_type, sender),
            None => false,
        }
    };

    // `const [x] = [1 as any]`
    let mut did_report = false;
    if is_array_literal_expression(receiver) {
        for (index, element) in receiver.elements().iter().enumerate() {
            // Rests are not a 1:1 assignment.
            if is_spread_element(element) {
                continue;
            }
            if check_element(ctx, element, index) {
                did_report = true;
            }
        }
    } else if is_array_binding_pattern(receiver) {
        for (index, element) in receiver.elements().iter().enumerate() {
            if element.dot_dot_dot_token().is_some() {
                continue;
            }
            if check_element(ctx, element.name(), index) {
                did_report = true;
            }
        }
    }
    did_report
}

fn check_array_destructure_helper(ctx: &mut RuleContext<'_>, receiver: Node, sender: Node) -> bool {
    if !is_array_binding_pattern(receiver) && !is_array_literal_expression(receiver) {
        return false;
    }
    let sender_type = ctx.checker.get_type_at_location(sender);
    check_array_destructure(ctx, receiver, sender_type, sender)
}

fn check_object_destructure_helper(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender: Node,
) -> bool {
    if !is_object_binding_pattern(receiver) && !is_object_literal_expression(receiver) {
        return false;
    }
    let sender_type = ctx.checker.get_type_at_location(sender);
    check_object_destructure(ctx, receiver, sender_type, sender)
}

fn receiver_type(
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender: Node,
    comparison: Comparison,
) -> TypeId {
    if comparison == Comparison::Contextual {
        let t = get_contextual_type(ctx.checker, sender);
        if t.is_some() {
            return t;
        }
        let t = get_contextual_type(ctx.checker, receiver);
        if t.is_some() {
            return t;
        }
    }
    ctx.checker.get_type_at_location(receiver)
}

/// Returns true when it reported.
fn check_assignment(
    state: &State,
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender: Node,
    type_annotation: Node,
    primary: TextRange,
    comparison: Comparison,
) -> bool {
    if can_skip_sender_type_check(sender, comparison) {
        return false;
    }

    let sender_type = ctx.checker.get_type_at_location(sender);

    if is_type_any_type(ctx.checker, sender_type) {
        let receiver_type = receiver_type(ctx, receiver, sender, comparison);
        let receiver_range = local_target_range(ctx.source_file, receiver, type_annotation);
        // `any` to `unknown` is allowed.
        if is_type_unknown_type(ctx.checker, receiver_type) {
            return false;
        }
        let receiver_text = type_to_string_or_error(ctx.checker, receiver_type);
        let receiver_label = if comparison == Comparison::None {
            format!("Target is inferred as `{receiver_text}`.")
        } else {
            format!("Target expects type `{receiver_text}`.")
        };
        let sender_name = sender_type_name(ctx.checker, sender_type);

        // `var foo = this`
        if !state.no_implicit_this
            && let Some((this_expression, this_type)) =
                any_typed_this_expression(ctx.checker, sender)
        {
            let this_text = type_to_string_or_error(ctx.checker, this_type);
            let report = Report::new(primary, any_assignment_this_message(sender_name))
                .with_label(
                    format!("`this` has type `{this_text}`."),
                    ctx.trim_node_text_range(this_expression),
                )
                .with_label(receiver_label, receiver_range);
            ctx.report_diagnostic(report);
            return true;
        }

        let sender_text = type_to_string_or_error(ctx.checker, sender_type);
        let report = Report::new(primary, any_assignment_message(sender_name))
            .with_label(
                format!("Assigned value has type `{sender_text}`."),
                ctx.trim_node_text_range(sender),
            )
            .with_label(receiver_label, receiver_range);
        ctx.report_diagnostic(report);
        return true;
    }

    if comparison == Comparison::None || !ctx.checker.is_non_deferred_type_reference(sender_type) {
        return false;
    }

    let receiver_type = receiver_type(ctx, receiver, sender, comparison);
    let Some(unsafe_assignment) =
        is_unsafe_assignment(ctx.checker, sender_type, receiver_type, sender)
    else {
        return false;
    };
    let sender_text = type_to_string_or_error(ctx.checker, unsafe_assignment.sender);
    let receiver_text = type_to_string_or_error(ctx.checker, unsafe_assignment.receiver);
    let report = Report::new(primary, unsafe_assignment_message())
        .with_label(
            format!("Assigned value has type `{sender_text}`."),
            ctx.trim_node_text_range(sender),
        )
        .with_label(
            format!("Target expects type `{receiver_text}`."),
            local_target_range(ctx.source_file, receiver, type_annotation),
        );
    ctx.report_diagnostic(report);
    true
}

/// A plain check, then the array and the object destructuring checks until
/// one reports.
fn check_assignment_full(
    state: &State,
    ctx: &mut RuleContext<'_>,
    receiver: Node,
    sender: Node,
    type_annotation: Node,
    primary: TextRange,
    comparison: Comparison,
) {
    if receiver.is_nil() || sender.is_nil() {
        return;
    }
    let did_report = check_assignment(
        state,
        ctx,
        receiver,
        sender,
        type_annotation,
        primary,
        comparison,
    ) || check_array_destructure_helper(ctx, receiver, sender);
    if !did_report {
        check_object_destructure_helper(ctx, receiver, sender);
    }
}

/// A declaration with a type annotation compares against it; without one,
/// the type is inferred from the sender.
fn comparison_of(declaration: Node) -> Comparison {
    if declaration.type_().is_some() {
        Comparison::Basic
    } else {
        Comparison::None
    }
}

fn check_property_declaration(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    let name = node.name();
    let primary = assignment_relation_range(ctx.source_file, name, initializer);
    check_assignment(
        state,
        ctx,
        name,
        initializer,
        node.type_(),
        primary,
        comparison_of(node),
    );
}

fn check_binary_expression(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if !is_assignment_expression(node, true) {
        return;
    }
    let primary = ctx.trim_node_text_range(node.operator_token());
    check_assignment_full(
        state,
        ctx,
        node.left(),
        node.right(),
        Node::NIL,
        primary,
        Comparison::Basic,
    );
}

/// Binding elements and parameters with a default value.
fn check_initialized_declaration(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    let name = node.name();
    let primary = assignment_relation_range(ctx.source_file, name, initializer);
    check_assignment_full(
        state,
        ctx,
        name,
        initializer,
        node.type_(),
        primary,
        Comparison::Basic,
    );
}

fn check_shorthand_default(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.object_assignment_initializer();
    if initializer.is_nil() {
        return;
    }
    let name = node.name();
    let primary = assignment_relation_range(ctx.source_file, name, initializer);
    check_assignment_full(
        state,
        ctx,
        name,
        initializer,
        Node::NIL,
        primary,
        Comparison::Basic,
    );
}

fn check_variable_declaration(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() {
        return;
    }
    let name = node.name();
    let primary = assignment_relation_range(ctx.source_file, name, initializer);
    check_assignment_full(
        state,
        ctx,
        name,
        initializer,
        node.type_(),
        primary,
        comparison_of(node),
    );
}

/// Object literal properties outside destructuring patterns.
fn check_object_literal(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    for property in node.properties().iter() {
        let initializer = if is_property_assignment(property) {
            property.initializer()
        } else if is_shorthand_property_assignment(property) {
            property.name()
        } else {
            continue;
        };
        // tsgolint stops at the first property without a value or with an
        // assignment value.
        if initializer.is_nil() {
            return;
        }
        let initializer = skip_parentheses(initializer);
        if is_assignment_expression(initializer, false) {
            return;
        }
        let name = property.name();
        let primary = assignment_relation_range(ctx.source_file, name, initializer);
        check_assignment(
            state,
            ctx,
            name,
            initializer,
            Node::NIL,
            primary,
            Comparison::Contextual,
        );
    }
}

/// Spreads in array literals outside destructuring patterns.
fn check_array_literal(_: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    for element in node.elements().iter() {
        if !is_spread_element(element) {
            continue;
        }
        let expression = element.expression();
        let rest_type = ctx.checker.get_type_at_location(expression);
        if is_type_any_type(ctx.checker, rest_type)
            || is_type_any_array_type(ctx.checker, rest_type)
        {
            let element_range = ctx.trim_node_text_range(element);
            // The `...` token.
            let spread_range = TextRange::new(element_range.pos(), element_range.pos() + 3);
            let rest_text = type_to_string_or_error(ctx.checker, rest_type);
            let message = unsafe_array_spread_message(sender_type_name(ctx.checker, rest_type));
            let report = Report::new(spread_range, message).with_label(
                format!("Spread value has type `{rest_text}`."),
                ctx.trim_node_text_range(expression),
            );
            ctx.report_diagnostic(report);
        }
    }
}

fn check_jsx_attribute(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let initializer = node.initializer();
    if initializer.is_nil() || initializer.kind() != SyntaxKind::JsxExpression {
        return;
    }
    let expression = initializer.expression();
    if expression.is_nil() {
        return;
    }
    let name = node.name();
    let primary = assignment_relation_range(ctx.source_file, name, expression);
    check_assignment(
        state,
        ctx,
        name,
        expression,
        Node::NIL,
        primary,
        Comparison::Contextual,
    );
}
