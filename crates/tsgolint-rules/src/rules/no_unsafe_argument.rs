//! `no-unsafe-argument`: disallows passing an `any` typed value as an
//! argument.

use goport_core::ast::{
    is_spread_assignment, is_tagged_template_expression, is_template_expression,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::flags::{CheckMode, ElementFlags};
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{
    is_intrinsic_error_type, is_rest_parameter_declaration, is_type_any_array_type,
    is_type_any_type, is_unsafe_assignment,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-argument",
    create,
};

fn unsafe_argument_message(sender: &str, receiver: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeArgument",
        format!("Unsafe argument of type {sender} assigned to a parameter of type {receiver}."),
    )
}

fn unsafe_array_spread_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeArraySpread",
        format!("Unsafe spread of an {sender} array type."),
    )
}

fn unsafe_spread_message(sender: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeSpread",
        format!("Unsafe spread of an {sender} type."),
    )
}

fn unsafe_tuple_spread_message(sender: &str, receiver: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeTupleSpread",
        format!(
            "Unsafe spread of a tuple type. The argument is {sender} and is assigned to a parameter of type {receiver}."
        ),
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::CallExpression, |_, ctx, node| {
            check_unsafe_arguments(ctx, node.arguments().iter(), node.expression(), node);
        })
        .on(SyntaxKind::NewExpression, |_, ctx, node| {
            check_unsafe_arguments(ctx, node.arguments().iter(), node.expression(), node);
        })
        .on(SyntaxKind::TaggedTemplateExpression, |_, ctx, node| {
            let template = node.template();
            if is_template_expression(template) {
                let arguments = template
                    .template_spans()
                    .nodes()
                    .iter()
                    .map(|span| span.expression());
                check_unsafe_arguments(ctx, arguments, node.tag(), node);
            }
        })
        .into()
}

/// The rest parameter of a signature, as the arguments past the fixed
/// parameters see it.
enum RestType {
    /// `...rest: T[]`: the element type.
    Array(TypeId),
    /// `...rest: [A, B]`: the element types.
    Tuple(Vec<TypeId>),
    /// Any other rest type.
    Other(TypeId),
    /// No rest parameter.
    None,
}

/// Walks the parameters of the resolved signature as arguments consume them.
struct FunctionSignature {
    node: Node,
    /// The parameters before the rest parameter.
    parameters: Vec<SymbolId>,
    /// Parameter types, resolved lazily so skipped positions never ask for them.
    parameter_types: Vec<Option<TypeId>>,
    rest_parameter: Option<SymbolId>,
    rest_type: Option<RestType>,
    parameter_index: usize,
    has_consumed_arguments: bool,
}

impl FunctionSignature {
    fn new(checker: &mut Checker, node: Node) -> Option<Self> {
        let signature = checker.get_resolved_signature(node, None, CheckMode::NORMAL);
        if signature.is_nil() {
            return None;
        }
        let mut parameters = checker.sig(signature).parameters().to_vec();
        let mut rest_parameter = None;
        if let Some(i) = parameters.iter().position(|&parameter| {
            checker
                .sym(parameter)
                .declarations
                .first()
                .is_some_and(|&declaration| is_rest_parameter_declaration(declaration))
        }) {
            rest_parameter = Some(parameters[i]);
            parameters.truncate(i);
        }
        Some(FunctionSignature {
            node,
            parameter_types: vec![None; parameters.len()],
            parameters,
            rest_parameter,
            rest_type: None,
            parameter_index: 0,
            has_consumed_arguments: false,
        })
    }

    fn consume_remaining_arguments(&mut self) {
        self.has_consumed_arguments = true;
    }

    /// Moves past the parameter of an argument that needs no check.
    fn skip_parameter(&mut self) {
        self.parameter_index += 1;
    }

    fn rest_type(&mut self, checker: &mut Checker) -> &RestType {
        let (rest_parameter, node) = (self.rest_parameter, self.node);
        self.rest_type.get_or_insert_with(|| {
            let Some(rest_parameter) = rest_parameter else {
                return RestType::None;
            };
            let t = checker.get_type_of_symbol_at_location(rest_parameter, node);
            if checker.is_array_type(t) {
                RestType::Array(checker.get_type_arguments(t)[0])
            } else if checker.is_tuple_type(t) {
                RestType::Tuple(checker.get_type_arguments(t).to_vec())
            } else {
                RestType::Other(t)
            }
        })
    }

    /// The type of the next parameter, if there is one.
    fn next_parameter_type(&mut self, checker: &mut Checker) -> Option<TypeId> {
        let index = self.parameter_index;
        self.parameter_index += 1;

        let t = if index >= self.parameters.len() || self.has_consumed_arguments {
            let fixed_count = self.parameters.len();
            let has_consumed_arguments = self.has_consumed_arguments;
            match self.rest_type(checker) {
                RestType::Tuple(type_arguments) => {
                    let &last = type_arguments.last()?;
                    // After a rest spread, assume the last element type. This
                    // is wrong for `...a: [number, ...string[], number]`.
                    if has_consumed_arguments {
                        last
                    } else {
                        type_arguments
                            .get(index - fixed_count)
                            .copied()
                            .unwrap_or(last)
                    }
                }
                RestType::Array(t) | RestType::Other(t) => *t,
                RestType::None => return None,
            }
        } else {
            *self.parameter_types[index].get_or_insert_with(|| {
                checker.get_type_of_symbol_at_location(self.parameters[index], self.node)
            })
        };
        t.is_some().then_some(t)
    }
}

/// Whether the argument's type can be one that `is_unsafe_assignment`
/// reports. Literals, templates and functions never are; an object literal
/// is `any` only through a spread.
fn argument_can_be_unsafe(node: Node) -> bool {
    match node.kind() {
        SyntaxKind::StringLiteral
        | SyntaxKind::NoSubstitutionTemplateLiteral
        | SyntaxKind::TemplateExpression
        | SyntaxKind::NumericLiteral
        | SyntaxKind::BigIntLiteral
        | SyntaxKind::TrueKeyword
        | SyntaxKind::FalseKeyword
        | SyntaxKind::NullKeyword
        | SyntaxKind::RegularExpressionLiteral
        | SyntaxKind::ArrowFunction
        | SyntaxKind::FunctionExpression => false,
        SyntaxKind::ObjectLiteralExpression => node.properties().iter().any(is_spread_assignment),
        _ => true,
    }
}

fn describe_type(checker: &mut Checker, t: TypeId) -> String {
    if is_intrinsic_error_type(checker, t) {
        "error typed".to_string()
    } else {
        checker.type_to_string(t)
    }
}

fn describe_type_for_spread(checker: &mut Checker, t: TypeId) -> String {
    if checker.is_array_type(t) {
        let element = checker.get_type_arguments(t)[0];
        if is_intrinsic_error_type(checker, element) {
            return "error".to_string();
        }
    }
    describe_type(checker, t)
}

fn describe_type_for_tuple(checker: &mut Checker, t: TypeId) -> String {
    if is_intrinsic_error_type(checker, t) {
        "error typed".to_string()
    } else {
        format!("of type {}", checker.type_to_string(t))
    }
}

fn check_unsafe_arguments(
    ctx: &mut RuleContext<'_>,
    arguments: impl Iterator<Item = Node> + Clone,
    callee: Node,
    node: Node,
) {
    // Skip the callee and signature queries when no argument can be unsafe.
    if !arguments.clone().any(argument_can_be_unsafe) {
        return;
    }
    // `any` callees are no-unsafe-call's job.
    let callee_type = ctx.checker.get_type_at_location(callee);
    if is_type_any_type(ctx.checker, callee_type) {
        return;
    }

    let Some(mut signature) = FunctionSignature::new(ctx.checker, node) else {
        panic!("Expected to a signature resolved");
    };
    if is_tagged_template_expression(node) {
        // The first parameter takes the `TemplateStringsArray`.
        signature.skip_parameter();
    }

    for argument in arguments {
        if argument.kind() == SyntaxKind::SpreadElement {
            check_spread_argument(ctx, &mut signature, argument);
            continue;
        }
        if !argument_can_be_unsafe(argument) {
            signature.skip_parameter();
            continue;
        }
        let Some(parameter_type) = signature.next_parameter_type(ctx.checker) else {
            continue;
        };
        let argument_type = ctx.checker.get_type_at_location(argument);
        if is_unsafe_assignment(ctx.checker, argument_type, parameter_type, argument).is_some() {
            let sender = describe_type(ctx.checker, argument_type);
            let receiver = describe_type(ctx.checker, parameter_type);
            ctx.report_node(argument, unsafe_argument_message(&sender, &receiver));
        }
    }
}

fn check_spread_argument(
    ctx: &mut RuleContext<'_>,
    signature: &mut FunctionSignature,
    argument: Node,
) {
    let spread_type = ctx.checker.get_type_at_location(argument.expression());
    if is_type_any_type(ctx.checker, spread_type) {
        // `foo(...any)`
        let sender = describe_type(ctx.checker, spread_type);
        ctx.report_node(argument, unsafe_spread_message(&sender));
    } else if is_type_any_array_type(ctx.checker, spread_type) {
        // `foo(...any[])`
        let sender = describe_type_for_spread(ctx.checker, spread_type);
        ctx.report_node(argument, unsafe_array_spread_message(&sender));
    } else if ctx.checker.is_tuple_type(spread_type) {
        // `foo(...[tuple1, tuple2])`
        let element_types = ctx.checker.get_type_arguments(spread_type);
        for &element_type in element_types.iter() {
            let Some(parameter_type) = signature.next_parameter_type(ctx.checker) else {
                continue;
            };
            // The elements have no nodes of their own: the spread is most
            // likely a variable, not an array literal.
            if is_unsafe_assignment(ctx.checker, element_type, parameter_type, Node::NIL).is_some()
            {
                let sender = describe_type_for_tuple(ctx.checker, element_type);
                let receiver = describe_type(ctx.checker, parameter_type);
                ctx.report_node(argument, unsafe_tuple_spread_message(&sender, &receiver));
            }
        }
        let combined_flags = ctx.checker.target_tuple_type(spread_type).combined_flags;
        if combined_flags.intersects(ElementFlags::VARIABLE) {
            // A rest element consumes every remaining parameter.
            signature.consume_remaining_arguments();
        }
    }
    // Other iterables are not checked.
}
