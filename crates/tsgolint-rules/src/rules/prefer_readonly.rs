//! `prefer-readonly`: requires private members that are never reassigned
//! outside the constructor to be `readonly`.

use goport_core::ast::{
    is_array_literal_expression, is_arrow_function, is_assignment_expression, is_binary_expression,
    is_computed_property_name, is_object_literal_expression, is_prefix_unary_expression,
    is_property_access_expression, is_property_declaration, is_spread_assignment,
    is_spread_element,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ModifierFlags, ObjectFlags, SymbolFlags, TypeFlags};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listener, Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    TextRange, decode_options,
};

use crate::utils::{is_intersection_type, is_object_type, is_union_type};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "prefer-readonly",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    only_inline_lambdas: bool,
}

fn prefer_readonly_message(name: &str) -> RuleMessage {
    RuleMessage::new(
        "preferReadonly",
        format!("Member '{name}' is never reassigned."),
    )
    .with_help("Mark it as `readonly`.")
}

/// How a type relates to the class being checked.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClassRelation {
    ClassAndInstance,
    Class,
    Instance,
    None,
}

/// Where the walk is relative to the constructor of the innermost class.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ConstructorDepth {
    Outside,
    /// Inside the constructor, under this many nested functions.
    Inside(u32),
}

/// A report built when a class ends; reports of nested classes wait for the
/// outermost class, as in tsgolint.
struct PreparedReport {
    range: TextRange,
    message: RuleMessage,
    fixes: Vec<RuleFix>,
}

/// Declarations by name in first-declaration order (a later declaration of
/// a name replaces the node).
#[derive(Default)]
struct OrderedDeclarations {
    entries: Vec<(String, Node)>,
}

impl OrderedDeclarations {
    fn set(&mut self, name: &str, node: Node) {
        match self.entries.iter_mut().find(|(n, _)| n == name) {
            Some(entry) => entry.1 = node,
            None => self.entries.push((name.to_owned(), node)),
        }
    }

    fn values_without<'a>(
        &'a self,
        skipped: &'a FxHashSet<String>,
    ) -> impl Iterator<Item = Node> + 'a {
        self.entries
            .iter()
            .filter(|(name, _)| !skipped.contains(name))
            .map(|&(_, node)| node)
    }
}

struct ClassScope {
    class_type: TypeId,
    constructor_depth: ConstructorDepth,
    member_modifications: FxHashSet<String>,
    member_modifications_in_constructor: FxHashSet<String>,
    private_members: OrderedDeclarations,
    private_statics: OrderedDeclarations,
    static_modifications: FxHashSet<String>,
    deferred_reports: Vec<PreparedReport>,
}

struct State {
    only_inline_lambdas: bool,
    classes: Vec<ClassScope>,
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let state = State {
        only_inline_lambdas: options.only_inline_lambdas,
        classes: Vec::new(),
    };
    let mut listeners = Listeners::new(state)
        .on(SyntaxKind::ClassDeclaration, enter_class)
        .on(SyntaxKind::ClassExpression, enter_class)
        .on(Listener::exit(SyntaxKind::ClassDeclaration), exit_class)
        .on(Listener::exit(SyntaxKind::ClassExpression), exit_class)
        .on(SyntaxKind::Constructor, enter_constructor)
        .on(Listener::exit(SyntaxKind::Constructor), |state, _, _| {
            if let Some(scope) = state.classes.last_mut() {
                scope.constructor_depth = ConstructorDepth::Outside;
            }
        })
        .on(SyntaxKind::PropertyAccessExpression, check_property_access);
    for kind in [
        SyntaxKind::ArrowFunction,
        SyntaxKind::FunctionDeclaration,
        SyntaxKind::FunctionExpression,
        SyntaxKind::MethodDeclaration,
        SyntaxKind::GetAccessor,
        SyntaxKind::SetAccessor,
    ] {
        listeners = listeners
            .on(kind, |state, _, _| {
                if let Some(scope) = state.classes.last_mut()
                    && let ConstructorDepth::Inside(depth) = &mut scope.constructor_depth
                {
                    *depth += 1;
                }
            })
            .on(Listener::exit(kind), |state, _, _| {
                if let Some(scope) = state.classes.last_mut()
                    && let ConstructorDepth::Inside(depth) = &mut scope.constructor_depth
                {
                    // tsgolint steps out to `Outside` when the depth drops
                    // below zero.
                    scope.constructor_depth = match depth.checked_sub(1) {
                        Some(depth) => ConstructorDepth::Inside(depth),
                        None => ConstructorDepth::Outside,
                    };
                }
            });
    }
    listeners.into()
}

fn enter_class(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let mut class_type = ctx.checker.get_type_at_location(node);
    if is_intersection_type(ctx.checker, class_type)
        && let Some(&first) = ctx.checker.ty(class_type).types().first()
    {
        class_type = first;
    }
    let mut scope = ClassScope {
        class_type,
        constructor_depth: ConstructorDepth::Outside,
        member_modifications: FxHashSet::default(),
        member_modifications_in_constructor: FxHashSet::default(),
        private_members: OrderedDeclarations::default(),
        private_statics: OrderedDeclarations::default(),
        static_modifications: FxHashSet::default(),
        deferred_reports: Vec::new(),
    };
    for member in node.members() {
        if is_property_declaration(member) {
            scope.add_declared_variable(member, state.only_inline_lambdas);
        }
    }
    state.classes.push(scope);
}

fn exit_class(state: &mut State, ctx: &mut RuleContext<'_>, _node: Node) {
    let Some(scope) = state.classes.pop() else {
        return;
    };
    let mut reports = build_reports(ctx, &scope);
    reports.extend(scope.deferred_reports);
    if let Some(parent) = state.classes.last_mut() {
        parent.deferred_reports.extend(reports);
        return;
    }
    for report in reports {
        ctx.report_diagnostic_with_fixes(Report::new(report.range, report.message), |_| {
            report.fixes
        });
    }
}

fn enter_constructor(state: &mut State, _ctx: &mut RuleContext<'_>, node: Node) {
    let only_inline_lambdas = state.only_inline_lambdas;
    let Some(scope) = state.classes.last_mut() else {
        return;
    };
    scope.constructor_depth = ConstructorDepth::Inside(0);
    for parameter in node.parameters() {
        if parameter
            .modifier_flags()
            .intersects(ModifierFlags::PRIVATE)
        {
            scope.add_declared_variable(parameter, only_inline_lambdas);
        }
    }
}

impl ClassScope {
    fn add_declared_variable(&mut self, node: Node, only_inline_lambdas: bool) {
        let name_node = node.name();
        if name_node.is_nil() {
            return;
        }
        let modifiers = node.modifier_flags();
        let is_private = modifiers.intersects(ModifierFlags::PRIVATE)
            || name_node.kind() == SyntaxKind::PrivateIdentifier;
        if !is_private
            || modifiers.intersects(ModifierFlags::ACCESSOR | ModifierFlags::READONLY)
            || is_computed_property_name(name_node)
        {
            return;
        }
        let initializer = node.initializer();
        if only_inline_lambdas && (initializer.is_nil() || !is_arrow_function(initializer)) {
            return;
        }
        let name = name_node.text();
        if name.is_empty() {
            return;
        }
        if modifiers.intersects(ModifierFlags::STATIC) {
            self.private_statics.set(name, node);
        } else {
            self.private_members.set(name, node);
        }
    }

    fn add_variable_modification(&mut self, checker: &mut Checker, node: Node) {
        if !is_property_access_expression(node) {
            return;
        }
        let modifier_type = checker.get_type_at_location(node.expression());
        let relation = self.type_to_class_relation(checker, modifier_type);
        let name = node.name().text();
        if relation == ClassRelation::Instance
            && self.constructor_depth == ConstructorDepth::Inside(0)
        {
            self.member_modifications_in_constructor
                .insert(name.to_owned());
            return;
        }
        if matches!(
            relation,
            ClassRelation::Instance | ClassRelation::ClassAndInstance
        ) {
            self.member_modifications.insert(name.to_owned());
        }
        if matches!(
            relation,
            ClassRelation::Class | ClassRelation::ClassAndInstance
        ) {
            self.static_modifications.insert(name.to_owned());
        }
    }

    fn type_to_class_relation(&self, checker: &mut Checker, t: TypeId) -> ClassRelation {
        if t.is_nil() {
            return ClassRelation::None;
        }
        if is_intersection_type(checker, t) {
            let mut result = ClassRelation::None;
            for part in checker.ty(t).types_list().iter().copied() {
                match self.type_to_class_relation(checker, part) {
                    ClassRelation::Class => {
                        if result == ClassRelation::Instance {
                            return ClassRelation::ClassAndInstance;
                        }
                        result = ClassRelation::Class;
                    }
                    ClassRelation::Instance => {
                        if result == ClassRelation::Class {
                            return ClassRelation::ClassAndInstance;
                        }
                        result = ClassRelation::Instance;
                    }
                    _ => {}
                }
            }
            return result;
        }
        if is_union_type(checker, t) {
            // A union with anything but the class or its instances cannot
            // access private members, so the first member decides.
            return match checker.ty(t).types().first() {
                Some(&first) => self.type_to_class_relation(checker, first),
                None => ClassRelation::None,
            };
        }
        if checker.ty(t).symbol.is_nil() || !type_is_or_has_base_type(checker, t, self.class_type) {
            return ClassRelation::None;
        }
        if is_object_type(checker, t)
            && checker
                .ty(t)
                .object_flags
                .intersects(ObjectFlags::ANONYMOUS)
        {
            ClassRelation::Class
        } else {
            ClassRelation::Instance
        }
    }

    fn unmodified_private_non_readonlys(&self) -> Vec<Node> {
        self.private_members
            .values_without(&self.member_modifications)
            .chain(
                self.private_statics
                    .values_without(&self.static_modifications),
            )
            .collect()
    }
}

/// `t` or one of its base classes or interfaces has the symbol of
/// `base_type`.
fn type_is_or_has_base_type(checker: &mut Checker, t: TypeId, base_type: TypeId) -> bool {
    if base_type.is_nil() {
        return false;
    }
    let base_symbol = checker.ty(base_type).symbol;
    if base_symbol.is_nil() {
        return false;
    }
    let mut stack = vec![t];
    let mut seen = FxHashSet::default();
    while let Some(current) = stack.pop() {
        if current.is_nil() || !seen.insert(current) {
            continue;
        }
        if checker.ty(current).symbol == base_symbol {
            return true;
        }
        if !is_object_type(checker, current)
            || !checker
                .ty(current)
                .object_flags
                .intersects(ObjectFlags::CLASS_OR_INTERFACE)
        {
            continue;
        }
        stack.extend(checker.get_base_types(current));
    }
    false
}

/// `node` is a target in the pattern on the left of a plain `=`.
fn is_destructuring_assignment(node: Node) -> bool {
    let mut current = node.parent();
    while current.is_some() {
        let parent = current.parent();
        if parent.is_nil() {
            break;
        }
        if is_object_literal_expression(parent)
            || is_array_literal_expression(parent)
            || is_spread_assignment(parent)
            || (is_spread_element(parent)
                && parent.parent().is_some()
                && is_array_literal_expression(parent.parent()))
        {
            current = parent;
            continue;
        }
        if is_binary_expression(parent) && !is_property_access_expression(current) {
            return parent.left() == current
                && parent.operator_token().kind() == SyntaxKind::EqualsToken;
        }
        break;
    }
    false
}

fn check_property_access(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let Some(scope) = state.classes.last_mut() else {
        return;
    };
    let parent = node.parent();
    if is_binary_expression(parent) {
        if parent.left() == node && is_assignment_expression(parent, false) {
            scope.add_variable_modification(ctx.checker, node);
        }
        return;
    }
    if parent.kind() == SyntaxKind::DeleteExpression || is_destructuring_assignment(node) {
        scope.add_variable_modification(ctx.checker, node);
        return;
    }
    let is_update = |operator: SyntaxKind| {
        matches!(
            operator,
            SyntaxKind::PlusPlusToken | SyntaxKind::MinusMinusToken
        )
    };
    if (parent.kind() == SyntaxKind::PostfixUnaryExpression || is_prefix_unary_expression(parent))
        && is_update(parent.operator())
    {
        let operand = parent.operand();
        if is_property_access_expression(operand) {
            scope.add_variable_modification(ctx.checker, operand);
        }
    }
}

fn build_reports(ctx: &mut RuleContext<'_>, scope: &ClassScope) -> Vec<PreparedReport> {
    let mut reports = Vec::new();
    for violating in scope.unmodified_private_non_readonlys() {
        let name_node = violating.name();
        if name_node.is_nil() {
            continue;
        }
        let name_text = ctx.node_text(name_node);
        // tsgolint reports a synthetic node from the declaration's start to
        // the end of its name.
        let range = ctx
            .trim_node_text_range(violating)
            .with_end(name_node.end());

        let mut fixes = vec![ctx.fix_insert_before(name_node, "readonly ")];
        if let Some(annotation) = type_annotation_fix(ctx, scope, violating, name_node) {
            fixes.push(RuleFix::insert_after(name_node, format!(": {annotation}")));
        }
        reports.push(PreparedReport {
            range,
            message: prefer_readonly_message(&name_text),
            fixes,
        });
    }
    reports
}

/// The type annotation that keeps the widened type of a property assigned
/// in the constructor and initialized with a literal.
fn type_annotation_fix(
    ctx: &mut RuleContext<'_>,
    scope: &ClassScope,
    violating: Node,
    name_node: Node,
) -> Option<String> {
    if !is_property_declaration(violating) {
        return None;
    }
    let initializer = violating.initializer();
    if violating.type_().is_some()
        || initializer.is_nil()
        || name_node.kind() != SyntaxKind::Identifier
        || !scope
            .member_modifications_in_constructor
            .contains(name_node.text())
    {
        return None;
    }
    let violating_type = ctx.checker.get_type_at_location(violating);
    let initializer_type = ctx.checker.get_type_at_location(initializer);
    if violating_type.is_nil()
        || initializer_type.is_nil()
        || violating_type == initializer_type
        || !ctx
            .checker
            .ty(initializer_type)
            .flags
            .intersects(TypeFlags::LITERAL)
    {
        return None;
    }
    type_annotation_for_violating_node(ctx.checker, violating, violating_type, initializer_type)
}

/// The type text to annotate with. None when an enum literal's type name
/// does not resolve to the same enum here.
fn type_annotation_for_violating_node(
    checker: &mut Checker,
    node: Node,
    violating_type: TypeId,
    initializer_type: TypeId,
) -> Option<String> {
    let annotation = checker.type_to_string(violating_type);
    if annotation.is_empty() {
        return None;
    }
    if !checker
        .ty(initializer_type)
        .flags
        .intersects(TypeFlags::ENUM_LITERAL)
    {
        return Some(annotation);
    }
    let symbol = checker.resolve_name_exported(&annotation, node, SymbolFlags::TYPE, false);
    if symbol.is_nil() {
        return None;
    }
    let mut value_symbol =
        checker.resolve_name_exported(&annotation, node, SymbolFlags::VALUE, false);
    if value_symbol.is_some() {
        value_symbol = checker.skip_alias(value_symbol);
    }
    let symbol = checker.skip_alias(symbol);
    if value_symbol.is_some() && value_symbol != symbol {
        return None;
    }
    if checker.get_declared_type_of_symbol(symbol) != violating_type {
        return None;
    }
    Some(annotation)
}
