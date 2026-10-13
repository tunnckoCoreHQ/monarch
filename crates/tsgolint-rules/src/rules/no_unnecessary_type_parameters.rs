//! `no-unnecessary-type-parameters`: disallows type parameters that are used
//! only once in their signature or class.

use goport_core::ast::{
    NodeSlice, TextRange, for_each_child_and_js_doc, is_call_signature_declaration, is_class_like,
    is_constructor_declaration, is_function_like, is_identifier, is_type_node,
    is_type_parameter_declaration, source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::{Checker, TypeAliasExt};
use goport_core::core::{Node, SignatureId, SymbolId, TypeId};
use goport_core::flags::{ObjectFlags, TypeFlags};
use goport_core::scanner_util::get_source_text_of_node_from_source_file;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::Value;
use tsgolint_core::text::token_range_at;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    RuleSuggestion,
};

use crate::utils::{
    get_heritage_clauses, is_intersection_type, is_object_type, is_type_parameter, is_union_type,
    trim_node_text_range,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unnecessary-type-parameters",
    create,
};

fn sole_report(
    range: TextRange,
    reference_range: TextRange,
    name: &str,
    uses: &str,
    descriptor: &str,
) -> Report {
    Report::new(
        range,
        RuleMessage::new(
            "sole",
            format!("Type parameter {name} is {uses} in the {descriptor} signature."),
        ),
    )
    .with_label(
        format!("This is the only usage of type parameter {name} in the signature."),
        reference_range,
    )
}

fn replace_usages_with_constraint_message() -> RuleMessage {
    RuleMessage::new(
        "replaceUsagesWithConstraint",
        "Replace all usages of type parameter with its constraint.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    let mut listeners = Listeners::new(());
    for kind in [
        SyntaxKind::ArrowFunction,
        SyntaxKind::FunctionDeclaration,
        SyntaxKind::FunctionExpression,
        SyntaxKind::CallSignature,
        SyntaxKind::ConstructSignature,
        SyntaxKind::ConstructorType,
        SyntaxKind::FunctionType,
        SyntaxKind::MethodSignature,
        SyntaxKind::MethodDeclaration,
    ] {
        listeners = listeners.on(kind, |_, ctx, node| check_node(ctx, node, "function"));
    }
    listeners
        .on(SyntaxKind::ClassDeclaration, |_, ctx, node| {
            check_node(ctx, node, "class");
        })
        .on(SyntaxKind::ClassExpression, |_, ctx, node| {
            check_node(ctx, node, "class");
        })
        .into()
}

struct Candidate {
    node: Node,
    name: Node,
    symbol: SymbolId,
    references: Vec<Node>,
}

fn check_node(ctx: &mut RuleContext<'_>, node: Node, descriptor: &str) {
    let type_parameters = node.type_parameters();
    if type_parameters.is_empty() {
        return;
    }
    let start_of_body = start_of_body(node);

    let mut candidates = Vec::new();
    for type_parameter in type_parameters {
        if !is_type_parameter_declaration(type_parameter) {
            continue;
        }
        let name = type_parameter.name();
        let symbol = ctx.checker.get_symbol_at_location_exported(name);
        if symbol.is_nil() {
            continue;
        }
        let references = reference_nodes(ctx, node, symbol, name);
        if is_repeated_in_ast(type_parameter, &references, start_of_body) {
            continue;
        }
        candidates.push(Candidate {
            node: type_parameter,
            name,
            symbol,
            references,
        });
    }
    if candidates.is_empty() {
        return;
    }

    let targets: FxHashSet<SymbolId> = candidates.iter().map(|c| c.symbol).collect();
    let counts = count_usages(ctx, node, &targets);
    for candidate in candidates {
        let Some(&count) = counts.get(&candidate.symbol) else {
            continue;
        };
        if count > 2 {
            continue;
        }
        let uses = if count == 1 {
            "never used"
        } else {
            "used only once"
        };
        let reference = candidate
            .references
            .first()
            .copied()
            .unwrap_or(candidate.name);
        let report = sole_report(
            ctx.trim_node_text_range(candidate.node),
            ctx.trim_node_text_range(reference),
            candidate.name.text(),
            uses,
            descriptor,
        );
        ctx.report_diagnostic_with_suggestions(report, |ctx| {
            vec![RuleSuggestion {
                message: replace_usages_with_constraint_message(),
                fixes: replace_with_constraint_fixes(ctx.source_file, type_parameters, &candidate),
            }]
        });
    }
}

fn replace_with_constraint_fixes(
    source_file: Node,
    type_parameters: NodeSlice,
    candidate: &Candidate,
) -> Vec<RuleFix> {
    let constraint = candidate.node.constraint();
    let constraint_text = if constraint.is_nil() || constraint.kind() == SyntaxKind::AnyKeyword {
        "unknown".to_owned()
    } else {
        get_source_text_of_node_from_source_file(source_file, constraint, false)
    };
    let removal = removal_range(source_file, type_parameters, candidate.node);

    let mut fixes = Vec::with_capacity(candidate.references.len() + 1);
    for &reference in &candidate.references {
        let range = trim_node_text_range(source_file, reference);
        if range.pos() < removal.end() && range.end() > removal.pos() {
            continue;
        }
        let replacement = if is_weak_precedence_constraint(constraint)
            && is_weak_precedence_type_parent(reference)
        {
            format!("({constraint_text})")
        } else {
            constraint_text.clone()
        };
        fixes.push(RuleFix::replace(
            source_file,
            reference.parent(),
            replacement,
        ));
    }
    fixes.push(RuleFix::remove_range(removal));
    fixes
}

fn is_weak_precedence_constraint(node: Node) -> bool {
    node.is_some()
        && matches!(
            node.kind(),
            SyntaxKind::UnionType
                | SyntaxKind::IntersectionType
                | SyntaxKind::ConditionalType
                | SyntaxKind::TypeOperator
                | SyntaxKind::FunctionType
                | SyntaxKind::ConstructorType
        )
}

fn is_weak_precedence_type_parent(reference: Node) -> bool {
    let parent = reference.parent();
    if parent.is_nil() {
        return false;
    }
    let grandparent = parent.parent();
    grandparent.is_some()
        && matches!(
            grandparent.kind(),
            SyntaxKind::ArrayType
                | SyntaxKind::IndexedAccessType
                | SyntaxKind::IntersectionType
                | SyntaxKind::UnionType
                | SyntaxKind::ConditionalType
                | SyntaxKind::TypeOperator
        )
}

/// The identifiers in type nodes under `node` (and its JSDoc) that refer to
/// `symbol`, in source order, without the declaration's own name.
fn reference_nodes(
    ctx: &mut RuleContext<'_>,
    node: Node,
    symbol: SymbolId,
    declaration_name: Node,
) -> Vec<Node> {
    fn walk(
        ctx: &mut RuleContext<'_>,
        current: Node,
        symbol: SymbolId,
        declaration_name: Node,
        references: &mut Vec<Node>,
    ) {
        if is_identifier(current)
            && current != declaration_name
            && current.parent().is_some()
            && is_type_node(current.parent())
            && ctx.checker.get_symbol_at_location_exported(current) == symbol
        {
            references.push(current);
        }
        let source_file = ctx.source_file;
        for_each_child_and_js_doc(current, source_file, &mut |child| {
            walk(ctx, child, symbol, declaration_name, references);
            false
        });
    }

    let mut references = Vec::new();
    walk(ctx, node, symbol, declaration_name, &mut references);
    references.sort_by_key(|reference| reference.pos());
    references
}

/// Whether the type parameter is referenced at least twice before the body,
/// so the checker walk is not needed.
fn is_repeated_in_ast(type_parameter: Node, references: &[Node], start_of_body: i32) -> bool {
    references
        .iter()
        .filter(|reference| {
            // References inside the declaration itself and in the body do
            // not count.
            let in_declaration =
                reference.pos() < type_parameter.end() && reference.end() > type_parameter.pos();
            !in_declaration && reference.pos() <= start_of_body
        })
        .nth(1)
        .is_some()
}

fn start_of_body(node: Node) -> i32 {
    let type_end = |node: Node| {
        let type_node = node.type_();
        if type_node.is_some() {
            type_node.end()
        } else {
            i32::MAX
        }
    };
    match node.kind() {
        SyntaxKind::ClassDeclaration | SyntaxKind::ClassExpression => node.member_list().pos(),
        SyntaxKind::FunctionDeclaration
        | SyntaxKind::FunctionExpression
        | SyntaxKind::MethodDeclaration => {
            let body = node.body();
            if body.is_some() {
                body.pos()
            } else {
                type_end(node)
            }
        }
        SyntaxKind::ArrowFunction => {
            let body = node.body();
            if body.is_some() {
                // A returned function contributes to the inferred return type.
                if is_function_like(body) {
                    i32::MAX
                } else {
                    body.pos()
                }
            } else {
                type_end(node)
            }
        }
        SyntaxKind::CallSignature
        | SyntaxKind::ConstructSignature
        | SyntaxKind::ConstructorType
        | SyntaxKind::FunctionType
        | SyntaxKind::MethodSignature => type_end(node),
        _ => i32::MAX,
    }
}

/// The range that removes `target` from the type parameter list (the whole
/// `<...>` when it is the only one).
fn removal_range(source_file: Node, type_parameters: NodeSlice, target: Node) -> TextRange {
    let Some(index) = type_parameters.iter().position(|p| p == target) else {
        return target.loc();
    };
    let text = source_file_text(source_file);
    let bytes = text.as_bytes();

    if type_parameters.len() == 1 {
        let first = type_parameters.get(0);
        let start = if first.pos() - 1 < 0 {
            first.pos()
        } else {
            first.pos() - 1
        };
        let mut end = first.end() as usize;
        while end < bytes.len() && bytes[end] != b'>' {
            end += 1;
        }
        if end < bytes.len() && bytes[end] == b'>' {
            end += 1;
        }
        let mut end = end as i32;
        if end <= start {
            end = first.end();
        }
        return TextRange::new(start, end);
    }

    if index == 0 {
        let mut end = type_parameters.get(1).pos();
        let token = token_range_at(source_file, end);
        if token.pos() > target.pos() {
            end = token.pos();
        }
        return TextRange::new(target.pos(), end);
    }

    let previous_end = type_parameters.get(index - 1).end();
    let comma = (previous_end..target.pos())
        .take_while(|&i| (i as usize) < bytes.len())
        .find(|&i| bytes[i as usize] == b',');
    TextRange::new(comma.unwrap_or(previous_end), target.end())
}

/// How often each target type parameter is used, from the checker's view of
/// the signature or class. A count above 2 means "used more than once".
fn count_usages(
    ctx: &mut RuleContext<'_>,
    node: Node,
    targets: &FxHashSet<SymbolId>,
) -> FxHashMap<SymbolId, i32> {
    let mut counter = UsageCounter {
        targets,
        counts: FxHashMap::default(),
        remaining: targets.len(),
    };
    if is_class_like(node) {
        let mut roots: Vec<Node> = node.type_parameters().to_vec();
        let heritage_clauses = get_heritage_clauses(node);
        for clause in heritage_clauses.nodes() {
            roots.extend(clause.types().nodes());
        }
        roots.extend(node.members());
        for root in roots {
            if counter.remaining == 0 {
                break;
            }
            counter.count_in(ctx.checker, root, true);
        }
    } else {
        counter.count_in(ctx.checker, node, false);
    }
    counter.counts
}

struct UsageCounter<'a> {
    targets: &'a FxHashSet<SymbolId>,
    counts: FxHashMap<SymbolId, i32>,
    /// Targets not yet seen more than once; the walk stops at zero.
    remaining: usize,
}

/// The state of one walk from a root node.
struct Walk {
    from_class: bool,
    type_visits: FxHashMap<TypeId, u32>,
    visited_constraints: FxHashSet<Node>,
    visited_default: bool,
}

impl UsageCounter<'_> {
    fn count_in(&mut self, c: &mut Checker, node: Node, from_class: bool) {
        let mut walk = Walk {
            from_class,
            type_visits: FxHashMap::default(),
            visited_constraints: FxHashSet::default(),
            visited_default: false,
        };
        if is_call_signature_declaration(node) || is_constructor_declaration(node) {
            let signature = c.get_signature_from_declaration_exported(node);
            self.visit_signature(c, &mut walk, signature);
        } else {
            let t = c.get_type_at_location(node);
            self.visit_type(c, &mut walk, t, false, false);
        }
    }

    fn increment_identifier(&mut self, symbol: SymbolId, assume_multiple_uses: bool) {
        if self.remaining == 0 || symbol.is_nil() || !self.targets.contains(&symbol) {
            return;
        }
        let count = self.counts.entry(symbol).or_insert(0);
        if *count > 2 {
            return;
        }
        *count += if assume_multiple_uses { 2 } else { 1 };
        if *count > 2 {
            self.remaining -= 1;
        }
    }

    fn visit_types(
        &mut self,
        c: &mut Checker,
        walk: &mut Walk,
        types: &[TypeId],
        assume_multiple_uses: bool,
    ) {
        for &t in types {
            if self.remaining == 0 {
                return;
            }
            self.visit_type(c, walk, t, assume_multiple_uses, false);
        }
    }

    fn visit_signature(&mut self, c: &mut Checker, walk: &mut Walk, signature: SignatureId) {
        if signature.is_nil() || self.remaining == 0 {
            return;
        }
        let this_parameter = c.sig(signature).this_parameter();
        if this_parameter.is_some() {
            let t = c.get_type_of_symbol(this_parameter);
            self.visit_type(c, walk, t, false, false);
        }
        let parameters = c.sig(signature).parameters().to_vec();
        for parameter in parameters {
            if self.remaining == 0 {
                return;
            }
            let t = c.get_type_of_symbol(parameter);
            self.visit_type(c, walk, t, false, false);
        }
        let type_parameters = c.sig(signature).type_parameters().to_vec();
        for type_parameter in type_parameters {
            if self.remaining == 0 {
                return;
            }
            self.visit_type(c, walk, type_parameter, false, false);
        }

        let mut return_type = c.get_return_type_of_signature_exported(signature);
        let predicate = c.get_type_predicate_of_signature_exported(signature);
        if predicate.is_some() {
            let predicate_type = c.pred(predicate).t;
            if predicate_type.is_some() {
                return_type = predicate_type;
            }
        }
        self.visit_type(c, walk, return_type, false, true);
    }

    fn visit_type(
        &mut self,
        c: &mut Checker,
        walk: &mut Walk,
        t: TypeId,
        assume_multiple_uses: bool,
        is_return_type: bool,
    ) {
        if t.is_nil() || self.remaining == 0 {
            return;
        }
        let visits = walk.type_visits.entry(t).or_insert(0);
        *visits += 1;
        if *visits > 9 {
            return;
        }

        if is_type_parameter(c, t) {
            let symbol = c.ty(t).symbol;
            if symbol.is_nil() {
                return;
            }
            let Some(&declaration) = c.sym(symbol).declarations.first() else {
                return;
            };
            if !is_type_parameter_declaration(declaration) {
                return;
            }
            self.increment_identifier(symbol, assume_multiple_uses);
            let constraint = declaration.constraint();
            if constraint.is_some() && walk.visited_constraints.insert(constraint) {
                let constraint_type = c.get_type_at_location(constraint);
                self.visit_type(c, walk, constraint_type, false, false);
            }
            let default = declaration.default_type();
            if default.is_some() && !walk.visited_default {
                walk.visited_default = true;
                let default_type = c.get_type_at_location(default);
                self.visit_type(c, walk, default_type, false, false);
            }
            return;
        }

        let alias_arguments = c.ty(t).alias.type_arguments().to_vec();
        if !alias_arguments.is_empty() {
            self.visit_types(c, walk, &alias_arguments, true);
            return;
        }

        if is_union_type(c, t) || is_intersection_type(c, t) {
            let types = c.ty(t).types_list();
            self.visit_types(c, walk, &types, assume_multiple_uses);
            return;
        }

        let flags = c.ty(t).flags;
        if flags.intersects(TypeFlags::INDEXED_ACCESS) {
            let access = c.ty(t).as_indexed_access_type();
            let (object_type, index_type) = (access.object_type, access.index_type);
            self.visit_type(c, walk, object_type, assume_multiple_uses, false);
            self.visit_type(c, walk, index_type, assume_multiple_uses, false);
            return;
        }

        if flags.intersects(TypeFlags::OBJECT)
            && c.ty(t).object_flags.intersects(ObjectFlags::REFERENCE)
        {
            let type_arguments = c.get_type_arguments(t);
            if !type_arguments.is_empty() {
                let target = c.ty(t).target();
                for type_argument in type_arguments.iter().copied() {
                    let mut this_assume = walk.from_class || assume_multiple_uses;
                    if c.is_tuple_type(target) {
                        this_assume = this_assume
                            || (is_return_type && !c.ty(target).as_tuple_type().readonly);
                    } else if c.is_array_type(target) {
                        let symbol = c.ty(t).symbol;
                        let is_array = symbol.is_some() && c.sym(symbol).name.as_str() == "Array";
                        this_assume = this_assume || (is_return_type && is_array);
                    } else {
                        this_assume = true;
                    }
                    self.visit_type(c, walk, type_argument, this_assume, is_return_type);
                }
            }
            return;
        }

        if flags.intersects(TypeFlags::TEMPLATE_LITERAL) {
            let types = c.ty(t).types_list();
            self.visit_types(c, walk, &types, assume_multiple_uses);
            return;
        }

        if flags.intersects(TypeFlags::CONDITIONAL) {
            let conditional = c.ty(t).as_conditional_type();
            let (check_type, extends_type) = (conditional.check_type, conditional.extends_type);
            self.visit_type(c, walk, check_type, assume_multiple_uses, false);
            self.visit_type(c, walk, extends_type, assume_multiple_uses, false);
            return;
        }

        if is_object_type(c, t) {
            let properties = c.get_properties_of_type(t);
            for &property in properties.iter() {
                if self.remaining == 0 {
                    break;
                }
                let property_type = c.get_type_of_symbol(property);
                self.visit_type(c, walk, property_type, false, false);
            }

            if c.ty(t).object_flags.intersects(ObjectFlags::MAPPED) {
                let mapped = c.ty(t).as_mapped_type();
                let (type_parameter, template_type, constraint_type) = (
                    mapped.type_parameter,
                    mapped.template_type,
                    mapped.constraint_type,
                );
                self.visit_type(c, walk, type_parameter, false, false);
                if properties.is_empty() {
                    let inner = if template_type.is_some() {
                        template_type
                    } else {
                        constraint_type
                    };
                    self.visit_type(c, walk, inner, false, false);
                }
            }

            let number_index = c.get_number_index_type(t);
            self.visit_type(c, walk, number_index, true, false);
            let string_index = c.get_string_index_type(t);
            self.visit_type(c, walk, string_index, true, false);

            for signature in c.get_call_signatures(t) {
                if self.remaining == 0 {
                    return;
                }
                self.visit_signature(c, walk, signature);
            }
            for signature in c.get_construct_signatures(t) {
                if self.remaining == 0 {
                    return;
                }
                self.visit_signature(c, walk, signature);
            }
            return;
        }

        if flags.intersects(TypeFlags::INDEX | TypeFlags::STRING_MAPPING) {
            let target = c.ty(t).target();
            self.visit_type(c, walk, target, assume_multiple_uses, false);
        }
    }
}
