//! `switch-exhaustiveness-check`: requires a switch over a union of
//! literal types to handle every member, and optionally reports default
//! cases of exhaustive switches and switches over other types without one.

use goport_core::ast::{TextRange, is_default_clause};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, TypeId};
use goport_core::flags::{LanguageVariant, TypeFlags};
use goport_core::printer::CommentRange;
use goport_core::scanner_util::{
    get_ecma_line_and_utf16_character_of_position, is_identifier_text,
};
use regress::Regex;
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage, RuleSuggestion,
    decode_options,
};

use crate::utils::{
    get_comments_in_range, get_constrained_type_at_location, intersection_type_parts,
    is_type_flag_set, quote_single_string_literal, trim_node_text_range, type_recurser,
    union_type_parts,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "switch-exhaustiveness-check",
    create,
};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    allow_default_case_for_exhaustive_switch: bool,
    consider_default_exhaustive_for_unions: bool,
    default_case_comment_pattern: Option<String>,
    require_default_for_non_union: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            allow_default_case_for_exhaustive_switch: true,
            consider_default_exhaustive_for_unions: false,
            default_case_comment_pattern: None,
            require_default_for_non_union: false,
        }
    }
}

fn add_missing_cases_message() -> RuleMessage {
    RuleMessage::new("addMissingCases", "Add branches for missing cases.")
}

fn dangerous_default_case_message() -> RuleMessage {
    RuleMessage::new(
        "dangerousDefaultCase",
        "The switch statement is exhaustive, so the default case is unnecessary.",
    )
}

fn switch_is_not_exhaustive_message(missing_branches: &str) -> RuleMessage {
    RuleMessage::new(
        "switchIsNotExhaustive",
        format!("Switch is not exhaustive. Cases not matched: {missing_branches}"),
    )
}

struct State {
    options: Options,
    comment_pattern: Regex,
}

/// Compiles an ECMAScript pattern, panicking like regexp2's `MustCompile`.
fn must_compile(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags)
        .unwrap_or_else(|error| panic!("regexp2: Compile({pattern:?}): {error}"))
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let comment_pattern = match &options.default_case_comment_pattern {
        Some(pattern) => must_compile(pattern, "u"),
        None => must_compile("^no default$", "iu"),
    };
    Listeners::new(State {
        options,
        comment_pattern,
    })
    .on(SyntaxKind::SwitchStatement, check_switch)
    .into()
}

struct SwitchMetadata {
    contains_non_literal_type: bool,
    /// The `default` clause.
    default_case: Option<Node>,
    /// The comment that stands for a default case, when there is no clause.
    default_case_comment: Option<CommentRange>,
    missing_literal_branch_types: Vec<TypeId>,
    symbol_name: String,
}

impl SwitchMetadata {
    fn has_default_case(&self) -> bool {
        self.default_case.is_some() || self.default_case_comment.is_some()
    }
}

fn is_literal_like_type(checker: &Checker, t: TypeId) -> bool {
    is_type_flag_set(
        checker,
        t,
        TypeFlags::LITERAL | TypeFlags::UNDEFINED | TypeFlags::NULL | TypeFlags::UNIQUE_ES_SYMBOL,
    )
}

/// Whether a union member is not a literal (`"foo" | number`) or is an
/// intersection without a literal (`"foo" & { bar: 1 }` has one). Default
/// cases are never superfluous for such types.
fn does_type_contain_non_literal_type(checker: &Checker, t: TypeId) -> bool {
    union_type_parts(checker, t).iter().any(|&part| {
        intersection_type_parts(checker, part)
            .iter()
            .all(|&t| !is_literal_like_type(checker, t))
    })
}

fn symbol_name(checker: &Checker, t: TypeId) -> String {
    let symbol = checker.ty(t).symbol;
    if symbol.is_nil() {
        String::new()
    } else {
        checker.sym(symbol).name.as_str().to_string()
    }
}

/// A comment after the last clause that matches the default case pattern.
fn comment_default_case(
    ctx: &RuleContext<'_>,
    node: Node,
    pattern: &Regex,
) -> Option<CommentRange> {
    let case_block = node.case_block();
    let last = case_block.clauses().nodes().last()?;
    let range = TextRange::new(last.end(), case_block.end());
    let text = ctx.source_text();
    get_comments_in_range(ctx.source_file, range)
        .into_iter()
        .find(|comment| {
            let mut comment_text = &text[comment.pos() as usize..comment.end() as usize];
            match comment.kind {
                SyntaxKind::SingleLineCommentTrivia => {
                    comment_text = comment_text.strip_prefix("//").unwrap_or(comment_text);
                }
                SyntaxKind::MultiLineCommentTrivia => {
                    comment_text = comment_text.strip_prefix("/*").unwrap_or(comment_text);
                    comment_text = comment_text.strip_suffix("*/").unwrap_or(comment_text);
                }
                _ => {}
            }
            pattern.find(comment_text.trim()).is_some()
        })
}

fn switch_metadata(ctx: &mut RuleContext<'_>, node: Node, pattern: &Regex) -> SwitchMetadata {
    let clauses = node.case_block().clauses().nodes();
    let default_case = clauses.iter().find(|&clause| is_default_clause(clause));
    let default_case_comment = if default_case.is_none() {
        comment_default_case(ctx, node, pattern)
    } else {
        None
    };

    let discriminant_type = get_constrained_type_at_location(ctx.checker, node.expression());
    let symbol_name = symbol_name(ctx.checker, discriminant_type);

    let mut case_types = FxHashSet::default();
    let mut has_undefined_case = false;
    for clause in clauses.iter() {
        if clause.kind() == SyntaxKind::DefaultClause {
            continue;
        }
        let case_type = get_constrained_type_at_location(ctx.checker, clause.expression());
        case_types.insert(case_type);
        if is_type_flag_set(ctx.checker, case_type, TypeFlags::UNDEFINED) {
            has_undefined_case = true;
        }
    }

    let contains_non_literal_type =
        does_type_contain_non_literal_type(ctx.checker, discriminant_type);

    let mut missing_literal_branch_types = Vec::new();
    type_recurser(ctx.checker, discriminant_type, |checker, t| {
        if case_types.contains(&t) || !is_literal_like_type(checker, t) {
            return false;
        }
        // "missing", "optional" and "undefined" are different types that
        // all have the undefined flag.
        if has_undefined_case && is_type_flag_set(checker, t, TypeFlags::UNDEFINED) {
            return false;
        }
        missing_literal_branch_types.push(t);
        false
    });

    SwitchMetadata {
        contains_non_literal_type,
        default_case,
        default_case_comment,
        missing_literal_branch_types,
        symbol_name,
    }
}

fn requires_quoting(text: &str) -> bool {
    !is_identifier_text(text, LanguageVariant::STANDARD)
}

/// Spaces up to the UTF-16 column where `node` starts.
fn node_indent(source_file: Node, node: Node) -> String {
    let trimmed = trim_node_text_range(source_file, node);
    let (_, column) = get_ecma_line_and_utf16_character_of_position(source_file, trimmed.pos());
    " ".repeat(column.max(0) as usize)
}

fn case_test(checker: &mut Checker, missing_branch_type: TypeId, symbol_name: &str) -> String {
    let missing_branch_name = self::symbol_name(checker, missing_branch_type);
    if !symbol_name.is_empty() && requires_quoting(&missing_branch_name) {
        return format!(
            "{symbol_name}[{}]",
            quote_single_string_literal(&missing_branch_name)
        );
    }
    if is_type_flag_set(checker, missing_branch_type, TypeFlags::ES_SYMBOL_LIKE) {
        missing_branch_name
    } else {
        checker.type_to_string(missing_branch_type)
    }
}

/// A case that the fix adds.
#[derive(Clone, Copy)]
enum MissingCase {
    /// `case <literal>:` for a missing literal type.
    Literal(TypeId),
    /// `default:` for a type that is not a union of literals.
    Default,
}

/// A `case` or `default` clause that throws.
fn missing_case_line(
    checker: &mut Checker,
    missing_case: MissingCase,
    symbol_name: &str,
) -> String {
    let MissingCase::Literal(missing_branch_type) = missing_case else {
        return "default: { throw new Error('default case') }".to_string();
    };
    let test = case_test(checker, missing_branch_type, symbol_name);
    let escaped = test.replace('\\', "\\\\").replace('\'', "\\'");
    format!("case {test}: {{ throw new Error('Not implemented yet: {escaped} case') }}")
}

fn fix_switch(
    ctx: &mut RuleContext<'_>,
    node: Node,
    missing: impl Iterator<Item = MissingCase>,
    default_case: Option<Node>,
    symbol_name: &str,
) -> Vec<RuleFix> {
    let missing_cases: Vec<String> = missing
        .map(|missing_case| missing_case_line(ctx.checker, missing_case, symbol_name))
        .collect();

    let case_block = node.case_block();
    let last_case = case_block.clauses().nodes().last();
    let case_indent = node_indent(ctx.source_file, last_case.unwrap_or(node));
    let fix_string = missing_cases
        .iter()
        .map(|code| format!("{case_indent}{code}"))
        .collect::<Vec<_>>()
        .join("\n");

    match (last_case, default_case) {
        (Some(_), Some(default_case)) => {
            let before: String = missing_cases
                .iter()
                .map(|code| format!("{code}\n{case_indent}"))
                .collect();
            vec![ctx.fix_insert_before(default_case, before)]
        }
        (Some(last_case), None) => {
            vec![RuleFix::insert_after(last_case, format!("\n{fix_string}"))]
        }
        (None, _) => vec![ctx.fix_replace(
            case_block,
            ["{", &fix_string, &format!("{case_indent}}}")].join("\n"),
        )],
    }
}

fn report_not_exhaustive(
    ctx: &mut RuleContext<'_>,
    node: Node,
    missing_branches: &str,
    missing: impl Iterator<Item = MissingCase>,
    default_case: Option<Node>,
    symbol_name: &str,
) {
    let message = switch_is_not_exhaustive_message(missing_branches);
    ctx.report_node_with_suggestions(node.expression(), message, |ctx| {
        vec![RuleSuggestion {
            message: add_missing_cases_message(),
            fixes: fix_switch(ctx, node, missing, default_case, symbol_name),
        }]
    });
}

fn check_switch(state: &mut State, ctx: &mut RuleContext<'_>, node: Node) {
    let metadata = switch_metadata(ctx, node, &state.comment_pattern);
    let options = &state.options;

    // Exhaustiveness. With `considerDefaultExhaustiveForUnions`, a default
    // case makes the switch exhaustive.
    let default_is_exhaustive =
        options.consider_default_exhaustive_for_unions && metadata.has_default_case();
    if !default_is_exhaustive && !metadata.missing_literal_branch_types.is_empty() {
        let missing_branches = metadata
            .missing_literal_branch_types
            .iter()
            .map(|&t| {
                let symbol = ctx.checker.ty(t).symbol;
                if is_type_flag_set(ctx.checker, t, TypeFlags::ES_SYMBOL_LIKE) && symbol.is_some() {
                    format!("typeof {}", ctx.checker.sym(symbol).name.as_str())
                } else {
                    ctx.checker.type_to_string(t)
                }
            })
            .collect::<Vec<_>>()
            .join(" | ");
        report_not_exhaustive(
            ctx,
            node,
            &missing_branches,
            metadata
                .missing_literal_branch_types
                .iter()
                .map(|&t| MissingCase::Literal(t)),
            metadata.default_case,
            &metadata.symbol_name,
        );
    }

    // Unnecessary default case.
    if !options.allow_default_case_for_exhaustive_switch
        && metadata.missing_literal_branch_types.is_empty()
        && metadata.has_default_case()
        && !metadata.contains_non_literal_type
    {
        match metadata.default_case_comment {
            Some(comment) => ctx.report_range(comment.text_range, dangerous_default_case_message()),
            None => {
                if let Some(default_case) = metadata.default_case {
                    ctx.report_node(default_case, dangerous_default_case_message());
                }
            }
        }
    }

    // Missing default case for a non-union.
    if options.require_default_for_non_union
        && metadata.contains_non_literal_type
        && !metadata.has_default_case()
    {
        report_not_exhaustive(
            ctx,
            node,
            "default",
            std::iter::once(MissingCase::Default),
            metadata.default_case,
            &metadata.symbol_name,
        );
    }
}
