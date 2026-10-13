//! `no-base-to-string`: reports stringification of values whose type only
//! has `Object.prototype.toString` (`[object Object]`).

use goport_core::ast::{
    is_identifier, is_interface_declaration, is_literal_expression, is_property_access_expression,
    is_tagged_template_expression,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use goport_core::scanner_util::get_source_text_of_node_from_source_file;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    get_constrained_type_at_location, get_number_index_type, get_type_name,
    intersection_type_parts, is_builtin_symbol_like, is_intersection_type, is_type_flag_set,
    is_type_parameter, is_union_type, matches_type_or_base_type, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-base-to-string",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    check_unknown: bool,
    ignored_type_names: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            check_unknown: false,
            ignored_type_names: ["Error", "RegExp", "URL", "URLSearchParams"]
                .map(String::from)
                .to_vec(),
        }
    }
}

/// Whether stringifying a type gives something useful.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Usefulness {
    Always,
    Never,
    Sometimes,
}

impl Usefulness {
    fn certainty(self) -> &'static str {
        match self {
            Usefulness::Always => "always",
            Usefulness::Never => "will",
            Usefulness::Sometimes => "may",
        }
    }
}

fn base_to_string_message(name: &str, certainty: Usefulness) -> RuleMessage {
    RuleMessage::new(
        "baseToString",
        format!(
            "'{name}' {} use Object's default stringification format ('[object Object]') when stringified.",
            certainty.certainty()
        ),
    )
    .with_help(
        "Consider picking a property (e.g. `user.name`), using a formatter (or `JSON.stringify`), or implementing a custom `toString()`/`toLocaleString()` on the type.",
    )
}

fn base_array_join_message(name: &str, certainty: Usefulness) -> RuleMessage {
    RuleMessage::new(
        "baseArrayJoin",
        format!(
            "Using `join()` for {name} {} use Object's default stringification format ('[object Object]') when stringified.",
            certainty.certainty()
        ),
    )
    .with_help(
        "Consider mapping the values to a meaningful string (e.g. pick a property or call a formatter) before calling `join()`, or implementing a custom `toString()`/`toLocaleString()` on the element type.",
    )
}

/// Results per type, kept for the whole file as in tsgolint. A type met
/// again while its result is being computed counts as `Always`.
#[derive(Default)]
struct Memo {
    values: FxHashMap<TypeId, Usefulness>,
    resolving: FxHashSet<TypeId>,
}

struct State {
    options: Options,
    to_string_memo: Memo,
    join_memo: Memo,
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(State {
        options,
        to_string_memo: Memo::default(),
        join_memo: Memo::default(),
    })
    .on(SyntaxKind::BinaryExpression, check_binary)
    .on(SyntaxKind::CallExpression, check_call)
    .on(SyntaxKind::TemplateExpression, check_template)
    .into()
}

fn check_binary(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let operator = node.operator_token().kind();
    if operator != SyntaxKind::PlusToken && operator != SyntaxKind::PlusEqualsToken {
        return;
    }
    let left = node.left();
    let right = node.right();
    let left_type = ctx.checker.get_type_at_location(left);
    let right_type = ctx.checker.get_type_at_location(right);
    if get_type_name(ctx.checker, left_type) == "string" {
        check_expression(state, ctx, right, right_type);
    } else if get_type_name(ctx.checker, right_type) == "string"
        && left.kind() != SyntaxKind::PrivateIdentifier
    {
        check_expression(state, ctx, left, left_type);
    }
}

fn check_call(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let callee = node.expression();
    let arguments = node.arguments();
    if is_builtin_string_call(ctx.checker, callee, arguments.len())
        && arguments.get(0).kind() != SyntaxKind::SpreadElement
    {
        check_expression(state, ctx, arguments.get(0), TypeId::NIL);
        return;
    }
    if !is_property_access_expression(callee) {
        return;
    }
    let object = callee.expression();
    match callee.name().text() {
        "join" => {
            let t = get_constrained_type_at_location(ctx.checker, object);
            let certainty = Collector::new(state, ctx.checker).join_certainty(t, &mut Vec::new());
            if certainty != Usefulness::Always {
                let name = get_source_text_of_node_from_source_file(ctx.source_file, object, false);
                ctx.report_node(object, base_array_join_message(&name, certainty));
            }
        }
        "toLocaleString" | "toString" => check_expression(state, ctx, object, TypeId::NIL),
        _ => {}
    }
}

fn check_template(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if is_tagged_template_expression(node.parent()) {
        return;
    }
    for span in node.template_spans().nodes() {
        check_expression(state, ctx, span.expression(), TypeId::NIL);
    }
}

/// `String(value)` where `String` is the global `String`.
fn is_builtin_string_call(checker: &mut Checker, callee: Node, argument_count: usize) -> bool {
    if !is_identifier(callee) || callee.text() != "String" || argument_count == 0 {
        return false;
    }
    // tsgolint does not look for a local `String` in scope as
    // typescript-eslint does.
    let t = checker.get_type_at_location(callee);
    is_builtin_symbol_like(checker, t, &["String"])
        || is_builtin_symbol_like(checker, t, &["StringConstructor"])
}

/// Reports `node` when its type (`t`, or the type at `node` when nil) may
/// stringify as `[object Object]`.
fn check_expression(state: &mut State, ctx: &mut RuleContext<'_>, node: Node, t: TypeId) {
    // tsgolint does not skip `true`, `null` and other literal keywords.
    if is_literal_expression(node) {
        return;
    }
    let t = if t.is_some() {
        t
    } else {
        ctx.checker.get_type_at_location(node)
    };
    let certainty = Collector::new(state, ctx.checker).stringify_certainty(t, &mut Vec::new());
    if certainty == Usefulness::Always {
        return;
    }
    let name = get_source_text_of_node_from_source_file(ctx.source_file, node, false);
    ctx.report_node(node, base_to_string_message(&name, certainty));
}

struct Collector<'a> {
    checker: &'a mut Checker,
    options: &'a Options,
    to_string_memo: &'a mut Memo,
    join_memo: &'a mut Memo,
}

#[derive(Clone, Copy)]
enum Walk {
    ToString,
    Join,
}

impl<'a> Collector<'a> {
    fn new(state: &'a mut State, checker: &'a mut Checker) -> Self {
        Collector {
            checker,
            options: &state.options,
            to_string_memo: &mut state.to_string_memo,
            join_memo: &mut state.join_memo,
        }
    }

    fn memo(&mut self, walk: Walk) -> &mut Memo {
        match walk {
            Walk::ToString => self.to_string_memo,
            Walk::Join => self.join_memo,
        }
    }

    fn memoized(
        &mut self,
        walk: Walk,
        t: TypeId,
        visited: &mut Vec<TypeId>,
        compute: fn(&mut Self, TypeId, &mut Vec<TypeId>) -> Usefulness,
    ) -> Usefulness {
        let memo = self.memo(walk);
        if let Some(&certainty) = memo.values.get(&t) {
            return certainty;
        }
        if !memo.resolving.insert(t) {
            return Usefulness::Always;
        }
        let certainty = compute(self, t, visited);
        let memo = self.memo(walk);
        memo.resolving.remove(&t);
        memo.values.insert(t, certainty);
        certainty
    }

    fn sub_certainty(&mut self, walk: Walk, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        match walk {
            Walk::ToString => self.stringify_certainty(t, visited),
            Walk::Join => self.join_certainty(t, visited),
        }
    }

    fn union_certainty(&mut self, walk: Walk, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        let (mut all_never, mut all_always) = (true, true);
        for part in union_type_parts(self.checker, t) {
            let certainty = self.sub_certainty(walk, part, visited);
            all_never &= certainty == Usefulness::Never;
            all_always &= certainty == Usefulness::Always;
        }
        if all_never {
            Usefulness::Never
        } else if all_always {
            Usefulness::Always
        } else {
            Usefulness::Sometimes
        }
    }

    fn intersection_certainty(
        &mut self,
        walk: Walk,
        t: TypeId,
        visited: &mut Vec<TypeId>,
    ) -> Usefulness {
        let any_always = intersection_type_parts(self.checker, t)
            .into_iter()
            .any(|part| self.sub_certainty(walk, part, visited) == Usefulness::Always);
        if any_always {
            Usefulness::Always
        } else {
            Usefulness::Never
        }
    }

    fn tuple_certainty(&mut self, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        let (mut has_never, mut has_sometimes) = (false, false);
        for argument in self.checker.get_type_arguments(t) {
            let certainty = self.stringify_certainty(argument, visited);
            has_never |= certainty == Usefulness::Never;
            has_sometimes |= certainty == Usefulness::Sometimes;
        }
        if has_never {
            Usefulness::Never
        } else if has_sometimes {
            Usefulness::Sometimes
        } else {
            Usefulness::Always
        }
    }

    fn array_certainty(&mut self, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        let element = get_number_index_type(self.checker, t);
        assert!(element.is_some(), "array should have number index type");
        self.stringify_certainty(element, visited)
    }

    /// Runs `walk` with `t` on the visited path.
    fn with_visited(
        &mut self,
        t: TypeId,
        visited: &mut Vec<TypeId>,
        walk: fn(&mut Self, TypeId, &mut Vec<TypeId>) -> Usefulness,
    ) -> Usefulness {
        visited.push(t);
        let certainty = walk(self, t, visited);
        visited.pop();
        certainty
    }

    fn join_certainty(&mut self, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        self.memoized(Walk::Join, t, visited, |this, t, visited| {
            if is_union_type(this.checker, t) {
                this.union_certainty(Walk::Join, t, visited)
            } else if is_intersection_type(this.checker, t) {
                this.intersection_certainty(Walk::Join, t, visited)
            } else if this.checker.is_tuple_type(t) {
                this.tuple_certainty(t, visited)
            } else if this.checker.is_array_type(t) {
                this.array_certainty(t, visited)
            } else {
                Usefulness::Always
            }
        })
    }

    fn stringify_certainty(&mut self, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        // A self-referencing array or tuple type.
        if visited.contains(&t) {
            return Usefulness::Always;
        }
        self.memoized(
            Walk::ToString,
            t,
            visited,
            Self::compute_stringify_certainty,
        )
    }

    fn compute_stringify_certainty(&mut self, t: TypeId, visited: &mut Vec<TypeId>) -> Usefulness {
        if is_type_parameter(self.checker, t) {
            let constraint = self.checker.get_base_constraint_of_type(t);
            if constraint.is_some() {
                return self.stringify_certainty(constraint, visited);
            }
            // An unconstrained type parameter is `unknown`.
            return if self.options.check_unknown {
                Usefulness::Sometimes
            } else {
                Usefulness::Always
            };
        }

        // `Boolean` does not declare `toString()`.
        if is_type_flag_set(self.checker, t, TypeFlags::BOOLEAN_LIKE) {
            return Usefulness::Always;
        }

        let ignored = &self.options.ignored_type_names;
        if matches_type_or_base_type(self.checker, t, |checker, t| {
            let name = get_type_name(checker, t);
            ignored.contains(&name)
        }) {
            return Usefulness::Always;
        }

        if is_intersection_type(self.checker, t) {
            return self.intersection_certainty(Walk::ToString, t, visited);
        }
        if is_union_type(self.checker, t) {
            return self.union_certainty(Walk::ToString, t, visited);
        }
        if self.checker.is_tuple_type(t) {
            return self.with_visited(t, visited, Self::tuple_certainty);
        }
        if self.checker.is_array_type(t) {
            return self.with_visited(t, visited, Self::array_certainty);
        }

        let mut found_fallback_on_object = false;
        for property_name in ["toString", "toLocaleString", "valueOf"] {
            let property = self.checker.get_property_of_type(t, property_name);
            if property.is_nil() {
                continue;
            }
            let declarations = &self.checker.sym(property).declarations;
            if declarations.is_empty() {
                continue;
            }
            // A declaration outside the `Object` interface is user-defined,
            // also when it overloads the `Object` one.
            if declarations
                .iter()
                .any(|&declaration| !is_object_interface_member(declaration))
            {
                return Usefulness::Always;
            }
            found_fallback_on_object = true;
        }
        if found_fallback_on_object {
            return Usefulness::Never;
        }

        if self.options.check_unknown && is_type_flag_set(self.checker, t, TypeFlags::UNKNOWN) {
            return Usefulness::Sometimes;
        }
        // `any`, for example.
        Usefulness::Always
    }
}

fn is_object_interface_member(declaration: Node) -> bool {
    let parent = declaration.parent();
    is_interface_declaration(parent) && parent.name().text() == "Object"
}
