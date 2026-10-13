//! `no-redundant-type-constituents`: disallows union and intersection
//! constituents that do nothing or override all others.

use goport_core::ast::{is_function_like, is_literal_type_node, skip_parentheses};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use goport_core::gostd::strconv::quote;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{is_type_flag_set, union_type_parts};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-redundant-type-constituents",
    create,
};

fn error_type_overrides_message(type_name: &str, container: Container) -> RuleMessage {
    RuleMessage::new(
        "errorTypeOverrides",
        format!(
            "'{type_name}' is an 'error' type that acts as 'any' and overrides all other types in this {} type.",
            container.name()
        ),
    )
}

fn literal_overridden_message(literal: &str, primitive: &str) -> RuleMessage {
    RuleMessage::new(
        "literalOverridden",
        format!("{literal} is overridden by {primitive} in this union type."),
    )
}

fn overridden_message(type_name: &str, container: Container) -> RuleMessage {
    RuleMessage::new(
        "overridden",
        format!(
            "'{type_name}' is overridden by other types in this {} type.",
            container.name()
        ),
    )
}

fn overrides_message(type_name: &str, container: Container) -> RuleMessage {
    RuleMessage::new(
        "overrides",
        format!(
            "'{type_name}' overrides all other types in this {} type.",
            container.name()
        ),
    )
}

fn primitive_overridden_message(literal: &str, primitive: &str) -> RuleMessage {
    RuleMessage::new(
        "primitiveOverridden",
        format!("{primitive} is overridden by the {literal} in this intersection type."),
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    Listeners::new(())
        .on(SyntaxKind::IntersectionType, check_intersection)
        .on(SyntaxKind::UnionType, check_union)
        .into()
}

/// A part of a constituent: a keyword or literal type node read from the
/// syntax, or a type part from the checker.
#[derive(Clone, Copy)]
struct TypePart {
    flags: TypeFlags,
    source: PartSource,
}

#[derive(Clone, Copy)]
enum PartSource {
    Node(Node),
    Type(TypeId),
}

impl TypePart {
    fn name(&self, checker: &mut Checker) -> String {
        match self.source {
            PartSource::Node(node) => node_part_name(node),
            PartSource::Type(t) => {
                let name = checker.type_to_string(t);
                if is_type_flag_set(checker, t, TypeFlags::STRING_LITERAL) {
                    quote(&name)
                } else {
                    name
                }
            }
        }
    }
}

fn node_part_name(node: Node) -> String {
    let name = match node.kind() {
        SyntaxKind::AnyKeyword => "any",
        SyntaxKind::BooleanKeyword => "boolean",
        SyntaxKind::NeverKeyword => "never",
        SyntaxKind::NumberKeyword => "number",
        SyntaxKind::StringKeyword => "string",
        SyntaxKind::UnknownKeyword => "unknown",
        SyntaxKind::LiteralType => {
            let literal = node.literal();
            match literal.kind() {
                SyntaxKind::TemplateLiteralType | SyntaxKind::NoSubstitutionTemplateLiteral => {
                    "template literal type"
                }
                SyntaxKind::StringLiteral
                | SyntaxKind::NumericLiteral
                | SyntaxKind::BigIntLiteral => literal.text(),
                _ => "literal type",
            }
        }
        _ => "literal type",
    };
    name.to_owned()
}

fn joined_names(checker: &mut Checker, parts: &[TypePart]) -> String {
    parts
        .iter()
        .map(|part| part.name(checker))
        .collect::<Vec<_>>()
        .join(" | ")
}

/// The parts of a constituent type node. Keywords and literal types are read
/// from the syntax; unions are flattened; other nodes use the members of
/// their type (`boolean` stays whole).
fn type_node_parts(checker: &mut Checker, node: Node) -> Vec<TypePart> {
    let node = skip_parentheses(node);
    let keyword_flags = match node.kind() {
        SyntaxKind::AnyKeyword => TypeFlags::ANY,
        SyntaxKind::BigIntKeyword => TypeFlags::BIG_INT,
        SyntaxKind::BooleanKeyword => TypeFlags::BOOLEAN,
        SyntaxKind::NeverKeyword => TypeFlags::NEVER,
        SyntaxKind::NumberKeyword => TypeFlags::NUMBER,
        SyntaxKind::StringKeyword => TypeFlags::STRING,
        SyntaxKind::UnknownKeyword => TypeFlags::UNKNOWN,
        _ => TypeFlags::NONE,
    };
    let node_part = |flags| {
        vec![TypePart {
            flags,
            source: PartSource::Node(node),
        }]
    };
    if keyword_flags != TypeFlags::NONE {
        return node_part(keyword_flags);
    }
    if is_literal_type_node(node) {
        let literal_flags = match node.literal().kind() {
            SyntaxKind::BigIntLiteral => TypeFlags::BIG_INT_LITERAL,
            SyntaxKind::TrueKeyword | SyntaxKind::FalseKeyword => TypeFlags::BOOLEAN_LITERAL,
            SyntaxKind::NumericLiteral => TypeFlags::NUMBER_LITERAL,
            SyntaxKind::StringLiteral => TypeFlags::STRING_LITERAL,
            _ => TypeFlags::NONE,
        };
        if literal_flags != TypeFlags::NONE {
            return node_part(literal_flags);
        }
    }
    if node.kind() == SyntaxKind::UnionType {
        return node
            .types()
            .nodes()
            .into_iter()
            .flat_map(|member| type_node_parts(checker, member))
            .collect();
    }

    let t = checker.get_type_at_location(node);
    let parts = if t == checker.boolean_type {
        vec![t]
    } else {
        union_type_parts(checker, t).to_vec()
    };
    parts
        .into_iter()
        .map(|part| TypePart {
            flags: checker.ty(part).flags,
            source: PartSource::Type(part),
        })
        .collect()
}

/// The type that a reported constituent is part of.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Container {
    Union,
    Intersection,
}

impl Container {
    fn name(self) -> &'static str {
        match self {
            Self::Union => "union",
            Self::Intersection => "intersection",
        }
    }
}

/// A primitive whose literals the rule compares with it.
#[derive(Clone, Copy)]
enum Primitive {
    BigInt,
    Boolean,
    Number,
    String,
}

impl Primitive {
    const ALL: [Self; 4] = [Self::BigInt, Self::Boolean, Self::Number, Self::String];

    fn flag(self) -> TypeFlags {
        match self {
            Self::BigInt => TypeFlags::BIG_INT,
            Self::Boolean => TypeFlags::BOOLEAN,
            Self::Number => TypeFlags::NUMBER,
            Self::String => TypeFlags::STRING,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::BigInt => "bigint",
            Self::Boolean => "boolean",
            Self::Number => "number",
            Self::String => "string",
        }
    }

    /// The primitive of a literal part; a template literal is a string.
    fn of_literal(flags: TypeFlags) -> Option<Self> {
        if flags == TypeFlags::BIG_INT_LITERAL {
            Some(Self::BigInt)
        } else if flags == TypeFlags::BOOLEAN_LITERAL {
            Some(Self::Boolean)
        } else if flags == TypeFlags::NUMBER_LITERAL {
            Some(Self::Number)
        } else if flags == TypeFlags::STRING_LITERAL || flags == TypeFlags::TEMPLATE_LITERAL {
            Some(Self::String)
        } else {
            None
        }
    }

    /// The primitive that a part is.
    fn of_primitive(flags: TypeFlags) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|primitive| flags == primitive.flag())
    }
}

/// The message for an `any`, `never` or `unknown` part, if it is one.
fn bottom_or_top_message(
    checker: &mut Checker,
    part: &TypePart,
    container: Container,
    never_allowed: bool,
) -> Option<RuleMessage> {
    let intersection = container == Container::Intersection;
    if part.flags == TypeFlags::ANY {
        let name = part.name(checker);
        return Some(if name == "any" {
            overrides_message(&name, container)
        } else {
            error_type_overrides_message(&name, container)
        });
    }
    if part.flags == TypeFlags::NEVER {
        if intersection {
            return Some(overrides_message(&part.name(checker), container));
        }
        if never_allowed {
            return None;
        }
        return Some(overridden_message("never", container));
    }
    if part.flags == TypeFlags::UNKNOWN {
        let name = part.name(checker);
        return Some(if intersection {
            overridden_message(&name, container)
        } else {
            overrides_message(&name, container)
        });
    }
    None
}

fn check_intersection(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    // Indexed by `Primitive`.
    let mut seen_literals: [Vec<TypePart>; 4] = Default::default();
    let mut seen_primitives: [Vec<Node>; 4] = Default::default();
    let mut seen_unions: Vec<(Vec<TypePart>, Node)> = Vec::new();

    for type_node in node.types().nodes() {
        let parts = type_node_parts(ctx.checker, type_node);
        // More than one part means the constituent is a union.
        let is_union = parts.len() >= 2;
        for part in &parts {
            if let Some(message) =
                bottom_or_top_message(ctx.checker, part, Container::Intersection, false)
            {
                ctx.report_node(type_node, message);
                continue;
            }
            // The union check below does not need the literals.
            if !is_union
                && seen_unions.is_empty()
                && let Some(primitive) = Primitive::of_literal(part.flags)
            {
                seen_literals[primitive as usize].push(*part);
            }
            if let Some(primitive) = Primitive::of_primitive(part.flags) {
                seen_primitives[primitive as usize].push(type_node);
            }
        }
        if is_union {
            seen_unions.push((parts, type_node));
        }
    }

    if !seen_unions.is_empty() {
        if seen_primitives.iter().any(|nodes| !nodes.is_empty()) {
            // tsgolint joins the parts of the first reported union only and
            // reuses that text for every later report.
            let mut literal_text = String::new();
            for (parts, type_node) in &seen_unions {
                // tsgolint looks at every part and keeps the result of the
                // last one, stopping early at the first part that is not a
                // literal of a seen primitive.
                let mut primitive = None;
                for part in parts {
                    primitive = Primitive::of_literal(part.flags)
                        .filter(|&primitive| !seen_primitives[primitive as usize].is_empty());
                    if primitive.is_none() {
                        break;
                    }
                }
                let Some(primitive) = primitive else {
                    continue;
                };
                if literal_text.is_empty() {
                    literal_text = joined_names(ctx.checker, parts);
                }
                ctx.report_node(
                    *type_node,
                    primitive_overridden_message(primitive.name(), &literal_text),
                );
            }
        }
        return;
    }

    for primitive in Primitive::ALL {
        let literals = &seen_literals[primitive as usize];
        if literals.is_empty() {
            continue;
        }
        let literal_text = joined_names(ctx.checker, literals);
        for &type_node in &seen_primitives[primitive as usize] {
            ctx.report_node(
                type_node,
                primitive_overridden_message(&literal_text, primitive.name()),
            );
        }
    }
}

fn check_union(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    // `never` in a return type union is allowed.
    let never_allowed = is_function_like(node.parent());
    // The literal parts of each constituent, by `Primitive`, in source order.
    let mut overridden: [Vec<(Node, Vec<TypePart>)>; 4] = Default::default();
    let mut seen_primitive_flags = TypeFlags::NONE;

    for type_node in node.types().nodes() {
        for part in type_node_parts(ctx.checker, type_node) {
            if let Some(message) =
                bottom_or_top_message(ctx.checker, &part, Container::Union, never_allowed)
            {
                ctx.report_node(type_node, message);
                continue;
            }
            if let Some(primitive) = Primitive::of_literal(part.flags) {
                let entries = &mut overridden[primitive as usize];
                match entries.iter_mut().find(|(n, _)| *n == type_node) {
                    Some((_, parts)) => parts.push(part),
                    None => entries.push((type_node, vec![part])),
                }
            }
            seen_primitive_flags |= part.flags
                & (TypeFlags::BIG_INT | TypeFlags::BOOLEAN | TypeFlags::NUMBER | TypeFlags::STRING);
        }
    }

    // tsgolint iterates a map here, so its report order within one primitive
    // is random; source order is one of its orders.
    for primitive in Primitive::ALL {
        if !seen_primitive_flags.intersects(primitive.flag()) {
            continue;
        }
        for (type_node, parts) in &overridden[primitive as usize] {
            let literal_text = joined_names(ctx.checker, parts);
            ctx.report_node(
                *type_node,
                literal_overridden_message(&literal_text, primitive.name()),
            );
        }
    }
}
