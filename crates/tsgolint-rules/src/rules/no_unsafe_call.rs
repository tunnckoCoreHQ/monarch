//! `no-unsafe-call`: disallows calling, constructing or tagging a template
//! with a value typed `any` (or an untyped `Function`).

use goport_core::astdata::SyntaxKind;
use goport_core::core::Node;
use serde_json::Value;
use tsgolint_core::{Listeners, RuleContext, RuleDefinition, RuleListeners, RuleMessage};

use crate::utils::{
    any_typed_this_expression, get_call_signatures, get_constrained_type_at_location,
    get_construct_signatures, is_builtin_symbol_like, is_intrinsic_error_type,
    is_intrinsic_void_type, is_type_any_type,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-unsafe-call",
    create,
};

/// How the checked value is invoked.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CallKind {
    Call,
    New,
    TemplateTag,
}

impl CallKind {
    fn message(self, type_name: &str) -> RuleMessage {
        match self {
            Self::Call => unsafe_call_message(type_name),
            Self::New => unsafe_new_message(type_name),
            Self::TemplateTag => unsafe_template_tag_message(type_name),
        }
    }
}

fn unsafe_call_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeCall",
        format!("Unsafe call of a(n) {type_name} typed value."),
    )
}

fn unsafe_call_this_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeCallThis",
        format!(
            "Unsafe call of a(n) {type_name} typed value. `this` is typed as {type_name}.\n"
        ),
    )
    .with_help(
        "You can try to fix this by turning on the `noImplicitThis` compiler option, or adding a `this` parameter to the function.",
    )
}

fn unsafe_new_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeNew",
        format!("Unsafe construction of a(n) {type_name} typed value."),
    )
}

fn unsafe_template_tag_message(type_name: &str) -> RuleMessage {
    RuleMessage::new(
        "unsafeTemplateTag",
        format!("Unsafe use of a(n) {type_name} typed template tag."),
    )
}

struct State {
    no_implicit_this: bool,
}

fn create(ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    let options = ctx.compiler_options();
    let no_implicit_this = options.get_strict_option_value(options.no_implicit_this);
    Listeners::new(State { no_implicit_this })
        .on(SyntaxKind::CallExpression, |state, ctx, node| {
            let callee = node.expression();
            if callee.kind() == SyntaxKind::ImportKeyword {
                return;
            }
            check_call(state, ctx, callee, callee, CallKind::Call);
        })
        .on(SyntaxKind::NewExpression, |state, ctx, node| {
            check_call(state, ctx, node.expression(), node, CallKind::New);
        })
        .on(SyntaxKind::TaggedTemplateExpression, |state, ctx, node| {
            let tag = node.tag();
            check_call(state, ctx, tag, tag, CallKind::TemplateTag);
        })
        .into()
}

fn check_call(
    state: &State,
    ctx: &mut RuleContext<'_>,
    node: Node,
    reporting_node: Node,
    kind: CallKind,
) {
    let t = get_constrained_type_at_location(ctx.checker, node);

    if is_type_any_type(ctx.checker, t) {
        // `this()`, `this.foo()` or `this.foo[bar]()`, for every kind.
        let this_is_any =
            !state.no_implicit_this && any_typed_this_expression(ctx.checker, node).is_some();
        let type_name = if is_intrinsic_error_type(ctx.checker, t) {
            "`error` type"
        } else {
            "`any`"
        };
        let message = if this_is_any {
            unsafe_call_this_message(type_name)
        } else {
            kind.message(type_name)
        };
        ctx.report_node(reporting_node, message);
        return;
    }

    // Also matches subtypes of `Function`, like `interface Foo extends Function {}`.
    if is_builtin_symbol_like(ctx.checker, t, &["Function"]) {
        // A construct signature makes it safe to call and construct. A call
        // signature makes it safe to call, and safe to construct when it
        // does not return void.
        if !get_construct_signatures(ctx.checker, t).is_empty() {
            return;
        }
        let call_signatures = get_call_signatures(ctx.checker, t);
        let safe = if kind == CallKind::New {
            call_signatures.iter().any(|&signature| {
                let return_type = ctx.checker.get_return_type_of_signature(signature);
                !is_intrinsic_void_type(ctx.checker, return_type)
            })
        } else {
            !call_signatures.is_empty()
        };
        if !safe {
            ctx.report_node(reporting_node, kind.message("`Function`"));
        }
    }
}
