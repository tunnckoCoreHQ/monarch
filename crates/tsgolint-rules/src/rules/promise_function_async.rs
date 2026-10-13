//! `promise-function-async`: requires functions that return promises to be
//! `async`.

use goport_core::ast::{is_function_declaration, is_method_declaration};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{ObjectFlags, TypeFlags};
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    decode_options,
};

use crate::utils::{
    get_call_signatures, includes_modifier, is_intersection_type, is_type_flag_set, is_union_type,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "promise-function-async",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_any: bool,
    allowed_promise_names: Vec<String>,
    check_arrow_functions: bool,
    check_function_declarations: bool,
    check_function_expressions: bool,
    check_method_declarations: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_any: true,
            allowed_promise_names: Vec::new(),
            check_arrow_functions: true,
            check_function_declarations: true,
            check_function_expressions: true,
            check_method_declarations: true,
        }
    }
}

struct State {
    allow_any: bool,
    /// `Promise` and the configured `allowedPromiseNames`.
    promise_names: FxHashSet<String>,
}

fn missing_async_message() -> RuleMessage {
    RuleMessage::new(
        "missingAsync",
        "Functions that return promises must be async.",
    )
}

fn missing_async_hybrid_return_message() -> RuleMessage {
    RuleMessage::new(
        "missingAsyncHybridReturn",
        "Functions that return promises must be async.",
    )
    .with_help(
        "Consider adding an explicit return type annotation if the function is intended to return a union of promise and non-promise types.",
    )
}

fn missing_async_hybrid_return_suggestion_message() -> RuleMessage {
    RuleMessage::new(
        "missingAsyncHybridReturnSuggestion",
        "Add `async` keyword to the function.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut promise_names: FxHashSet<String> = options.allowed_promise_names.into_iter().collect();
    promise_names.insert("Promise".to_owned());
    let mut listeners = Listeners::new(State {
        allow_any: options.allow_any,
        promise_names,
    });
    if options.check_arrow_functions {
        listeners = listeners.on(SyntaxKind::ArrowFunction, validate_node);
    }
    if options.check_function_declarations {
        listeners = listeners.on(SyntaxKind::FunctionDeclaration, validate_node);
    }
    if options.check_function_expressions {
        listeners = listeners.on(SyntaxKind::FunctionExpression, validate_node);
    }
    if options.check_method_declarations {
        listeners = listeners.on(SyntaxKind::MethodDeclaration, |state, ctx, node| {
            // An abstract method cannot be async.
            if !includes_modifier(node, SyntaxKind::AbstractKeyword) {
                validate_node(state, ctx, node);
            }
        });
    }
    listeners.into()
}

fn validate_node(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if includes_modifier(node, SyntaxKind::AsyncKeyword) || node.body().is_nil() {
        return;
    }
    let t = ctx.checker.get_type_at_location(node);
    let signatures = get_call_signatures(ctx.checker, t);
    if signatures.is_empty() {
        return;
    }
    let has_explicit_return_type = node.type_().is_some();

    let mut every_signature_returns_promise = true;
    for &signature in signatures.iter() {
        let return_type = ctx.checker.get_return_type_of_signature(signature);
        if !state.allow_any && is_type_flag_set(ctx.checker, return_type, TypeFlags::ANY_OR_UNKNOWN)
        {
            // No fix: the return type is unknown. tsgolint reports the whole
            // node, not the function head.
            ctx.report_node(node, missing_async_message());
            return;
        }
        // Without an annotation, some part of the return type must be a
        // promise; with one, all of it. Later signatures are still checked
        // for `any` above.
        if every_signature_returns_promise {
            every_signature_returns_promise = contains_all_types_by_name(
                ctx.checker,
                &state.promise_names,
                return_type,
                has_explicit_return_type,
            );
        }
    }
    if !every_signature_returns_promise {
        return;
    }

    // A union return type that mixes promises and other types gets a
    // suggestion instead of a fix, when there is no annotation.
    let is_hybrid_return_type = !has_explicit_return_type
        && signatures.iter().any(|&signature| {
            let return_type = ctx.checker.get_return_type_of_signature(signature);
            is_union_type(ctx.checker, return_type)
                && !ctx
                    .checker
                    .ty(return_type)
                    .types_list()
                    .iter()
                    .all(|&part| {
                        contains_all_types_by_name(ctx.checker, &state.promise_names, part, true)
                    })
        });

    let insert_async = move |ctx: &mut RuleContext<'_>| {
        if is_method_declaration(node) {
            return ctx.fix_insert_before(node.name(), " async ");
        }
        if is_function_declaration(node) {
            let modifiers = node.modifiers();
            if let Some(last) = modifiers.nodes().last() {
                return RuleFix::insert_after(last, " async");
            }
        }
        ctx.fix_insert_before(node, " async ")
    };
    if is_hybrid_return_type {
        ctx.report_node_with_suggestions(node, missing_async_hybrid_return_message(), |ctx| {
            vec![RuleSuggestion {
                message: missing_async_hybrid_return_suggestion_message(),
                fixes: vec![insert_async(ctx)],
            }]
        });
    } else {
        ctx.report_node_with_fixes(node, missing_async_message(), |ctx| vec![insert_async(ctx)]);
    }
}

/// Whether `t` is one of the promise types, or is built from them: with
/// `match_any_instead`, every union or intersection member and some base
/// type match; else some member and every base type (at least one).
fn contains_all_types_by_name(
    checker: &mut Checker,
    promise_names: &FxHashSet<String>,
    t: TypeId,
    match_any_instead: bool,
) -> bool {
    if is_type_flag_set(checker, t, TypeFlags::ANY_OR_UNKNOWN) {
        return false;
    }
    let mut t = t;
    if is_type_flag_set(checker, t, TypeFlags::OBJECT)
        && checker
            .ty(t)
            .object_flags
            .intersects(ObjectFlags::REFERENCE)
    {
        t = checker.ty(t).target();
    }
    let symbol = checker.ty(t).symbol;
    if symbol.is_some() && promise_names.contains(checker.sym(symbol).name.as_str()) {
        return true;
    }

    let predicate = |checker: &mut Checker, t: TypeId| {
        contains_all_types_by_name(checker, promise_names, t, match_any_instead)
    };

    if is_union_type(checker, t) || is_intersection_type(checker, t) {
        let parts = checker.ty(t).types_list();
        return if match_any_instead {
            parts.iter().all(|&part| predicate(checker, part))
        } else {
            parts.iter().any(|&part| predicate(checker, part))
        };
    }
    if !checker
        .ty(t)
        .object_flags
        .intersects(ObjectFlags::CLASS_OR_INTERFACE)
    {
        return false;
    }
    let bases = checker.get_base_types(t);
    if match_any_instead {
        bases.iter().any(|&base| predicate(checker, base))
    } else {
        !bases.is_empty() && bases.iter().all(|&base| predicate(checker, base))
    }
}
