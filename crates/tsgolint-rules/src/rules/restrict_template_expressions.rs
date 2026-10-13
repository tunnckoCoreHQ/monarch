//! `restrict-template-expressions`: requires the expressions of a template
//! literal to have an allowed type.

use goport_core::ast::is_tagged_template_expression;
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use goport_core::frontend::vfs::Fs;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleListeners, RuleMessage, decode_options,
};

use crate::utils::{
    TypeOrValueSpecifier, TypeOrValueSpecifierFrom, get_constrained_type_at_location,
    get_number_index_type, intersection_type_parts, is_type_flag_set, matches_type_or_base_type,
    type_matches_some_specifier, union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "restrict-template-expressions",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow: Vec<TypeOrValueSpecifier>,
    allow_any: bool,
    allow_array: bool,
    allow_boolean: bool,
    allow_never: bool,
    allow_nullish: bool,
    allow_number: bool,
    #[serde(rename = "allowRegExp")]
    allow_reg_exp: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow: vec![TypeOrValueSpecifier {
                from: TypeOrValueSpecifierFrom::Lib,
                name: vec!["Error".into(), "URL".into(), "URLSearchParams".into()],
                ..Default::default()
            }],
            allow_any: true,
            allow_array: false,
            allow_boolean: true,
            allow_never: false,
            allow_nullish: true,
            allow_number: true,
            allow_reg_exp: true,
        }
    }
}

struct State {
    options: Options,
    allowed_flags: TypeFlags,
}

fn invalid_type_message() -> RuleMessage {
    RuleMessage::new(
        "invalidType",
        "Invalid type used in template literal expression.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut allowed_flags = TypeFlags::STRING_LIKE;
    for (enabled, flags) in [
        (options.allow_any, TypeFlags::ANY),
        (options.allow_boolean, TypeFlags::BOOLEAN_LIKE),
        (options.allow_nullish, TypeFlags::NULLABLE),
        (
            options.allow_number,
            TypeFlags::NUMBER_LIKE | TypeFlags::BIG_INT_LIKE,
        ),
        (options.allow_never, TypeFlags::NEVER),
    ] {
        if enabled {
            allowed_flags |= flags;
        }
    }
    Listeners::new(State {
        options,
        allowed_flags,
    })
    .on(SyntaxKind::TemplateExpression, check_template)
    .into()
}

fn check_template(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    if is_tagged_template_expression(node.parent()) {
        return;
    }
    for span in node.template_spans().nodes() {
        let expression = span.expression();
        let expression_type = get_constrained_type_at_location(ctx.checker, expression);
        if is_type_allowed(state, ctx.checker, &*ctx.fs(), expression_type) {
            continue;
        }
        let range = ctx.trim_node_text_range(expression);
        let label = format!("Type: {}", ctx.checker.type_to_string(expression_type));
        ctx.report_diagnostic(Report::new(range, invalid_type_message()).with_label(label, range));
    }
}

fn is_type_allowed(state: &State, checker: &mut Checker, fs: &dyn Fs, t: TypeId) -> bool {
    union_type_parts(checker, t).into_iter().all(|part| {
        intersection_type_parts(checker, part)
            .into_iter()
            .any(|t| is_part_allowed(state, checker, fs, t))
    })
}

fn is_part_allowed(state: &State, checker: &mut Checker, fs: &dyn Fs, t: TypeId) -> bool {
    let options = &state.options;
    is_type_flag_set(checker, t, state.allowed_flags)
        || (options.allow_reg_exp && t == checker.global_reg_exp_type)
        || (!options.allow.is_empty()
            && matches_type_or_base_type(checker, t, |checker, t| {
                type_matches_some_specifier(checker, fs, t, &options.allow)
            }))
        || (options.allow_array && checker.is_array_or_tuple_type(t) && {
            let element = get_number_index_type(checker, t);
            is_type_allowed(state, checker, fs, element)
        })
}
