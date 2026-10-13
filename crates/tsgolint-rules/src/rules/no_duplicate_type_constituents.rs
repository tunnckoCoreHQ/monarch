//! `no-duplicate-type-constituents`: disallows duplicate constituents of
//! union and intersection types, and an explicit `undefined` on an optional
//! parameter.

use goport_core::ast::{
    TextRange, is_parameter_declaration, is_parameter_property_declaration, skip_type_parentheses,
    source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::core::{Node, TypeId};
use goport_core::flags::TypeFlags;
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use rustc_hash::FxHashMap;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    decode_options,
};

use crate::utils::{is_intrinsic_error_type, is_type_flag_set, trim_node_text_range};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "no-duplicate-type-constituents",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    ignore_intersections: bool,
    ignore_unions: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Composite {
    Union,
    Intersection,
}

impl Composite {
    fn kind(self) -> SyntaxKind {
        match self {
            Composite::Union => SyntaxKind::UnionType,
            Composite::Intersection => SyntaxKind::IntersectionType,
        }
    }
}

fn duplicate_message(composite: Composite, previous: &str) -> RuleMessage {
    let name = match composite {
        Composite::Union => "Union",
        Composite::Intersection => "Intersection",
    };
    RuleMessage::new(
        "duplicate",
        format!("{name} type constituent is duplicated with {previous}."),
    )
}

fn unnecessary_message() -> RuleMessage {
    RuleMessage::new(
        "unnecessary",
        "Explicit undefined is unnecessary on an optional parameter.",
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    let mut listeners = Listeners::new(());
    if !options.ignore_intersections {
        listeners = listeners.on(SyntaxKind::IntersectionType, check_intersection);
    }
    if !options.ignore_unions {
        listeners = listeners.on(SyntaxKind::UnionType, check_union);
    }
    listeners.into()
}

fn check_intersection(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if unwound_parent_type(node, SyntaxKind::IntersectionType).is_some() {
        return;
    }
    check_composite(ctx, node, Composite::Intersection, false);
}

fn check_union(_: &mut (), ctx: &mut RuleContext<'_>, node: Node) {
    if unwound_parent_type(node, SyntaxKind::UnionType).is_some() {
        return;
    }
    let parent = node.parent();
    let on_optional_parameter = is_parameter_declaration(parent)
        && parent.question_token().is_some()
        && !is_parameter_property_declaration(parent, parent.parent());
    check_composite(ctx, node, Composite::Union, on_optional_parameter);
}

/// The nearest ancestor of `kind` reached through parenthesized types only.
fn unwound_parent_type(node: Node, kind: SyntaxKind) -> Node {
    let mut current = node.parent();
    while current.is_some() {
        if current.kind() == kind {
            return current;
        }
        if current.kind() != SyntaxKind::ParenthesizedType {
            return Node::NIL;
        }
        current = current.parent();
    }
    Node::NIL
}

struct Walk {
    composite: Composite,
    /// Report explicit `undefined` constituents (the union types an optional
    /// parameter).
    report_undefined: bool,
    seen: FxHashMap<TypeId, Node>,
}

fn check_composite(
    ctx: &mut RuleContext<'_>,
    node: Node,
    composite: Composite,
    report_undefined: bool,
) {
    let mut walk = Walk {
        composite,
        report_undefined,
        seen: FxHashMap::default(),
    };
    for constituent in node.types().nodes() {
        check_constituent(ctx, &mut walk, constituent, true);
    }
}

/// Checks `constituent` and, when it is a nested composite of the same kind,
/// its constituents. Returns whether `constituent` was reported as a
/// duplicate (and so removed by the fix).
fn check_constituent(
    ctx: &mut RuleContext<'_>,
    walk: &mut Walk,
    constituent: Node,
    with_fix: bool,
) -> bool {
    let t = ctx.checker.get_type_at_location(constituent);
    if is_intrinsic_error_type(ctx.checker, t) {
        return false;
    }

    if let Some(&previous) = walk.seen.get(&t) {
        // tsgolint quotes the previous constituent with its leading trivia.
        let previous_text = ctx.range_text(previous.loc());
        let message = duplicate_message(walk.composite, &previous_text);
        report(
            ctx,
            with_fix,
            walk.composite,
            message,
            constituent,
            previous,
        );
        return true;
    }

    if walk.report_undefined && is_type_flag_set(ctx.checker, t, TypeFlags::UNDEFINED) {
        report(
            ctx,
            true,
            Composite::Union,
            unnecessary_message(),
            constituent,
            Node::NIL,
        );
    }
    walk.seen.insert(t, constituent);

    let inner = skip_type_parentheses(constituent);
    if inner.kind() != walk.composite.kind() {
        return false;
    }
    let types = inner.types().nodes();
    let last = types.len().saturating_sub(1);
    let mut all_previous_removed = true;
    for (i, nested) in types.into_iter().enumerate() {
        // The last nested constituent gets no fix when all before it were
        // removed: removing it too would leave nothing.
        if !check_constituent(ctx, walk, nested, i < last || !all_previous_removed) {
            all_previous_removed = false;
        }
    }
    false
}

fn report(
    ctx: &mut RuleContext<'_>,
    with_fix: bool,
    composite: Composite,
    message: RuleMessage,
    constituent: Node,
    first_occurrence: Node,
) {
    let mut diagnostic = Report::new(ctx.trim_node_text_range(constituent), message);
    if first_occurrence.is_some() {
        let first_range = ctx.trim_node_text_range(first_occurrence);
        let first_text = ctx.range_text(first_range);
        diagnostic = diagnostic.with_label(
            format!("Type '{first_text}' is first declared here."),
            first_range,
        );
    }
    if !with_fix {
        ctx.report_diagnostic(diagnostic);
        return;
    }
    ctx.report_diagnostic_with_fixes(diagnostic, |ctx| {
        removal_fixes(ctx.source_file, composite, constituent)
    });
}

fn is_operator(kind: SyntaxKind) -> bool {
    matches!(kind, SyntaxKind::AmpersandToken | SyntaxKind::BarToken)
}

/// Removes `constituent`, the `|` or `&` next to it, and the parentheses
/// that wrap it.
fn removal_fixes(source_file: Node, composite: Composite, constituent: Node) -> Vec<RuleFix> {
    let parent = unwound_parent_type(constituent, composite.kind());
    let text = source_file_text(source_file);
    let mut s = get_scanner_for_source_file(source_file, &text, parent.pos());

    // The last operator before the constituent, and the `(` tokens after it.
    let mut operator_before = None;
    let mut parens_before: Vec<TextRange> = Vec::new();
    while s.token_start() < constituent.pos() {
        if is_operator(s.token()) {
            operator_before = Some(s.token_start());
            parens_before.clear();
        } else if s.token() == SyntaxKind::OpenParenToken {
            parens_before.push(s.token_range());
        }
        s.scan();
    }

    let mut fixes = vec![RuleFix::remove_range(trim_node_text_range(
        source_file,
        constituent,
    ))];
    if let Some(operator) = operator_before {
        fixes.push(RuleFix::remove_range(TextRange::new(
            operator,
            operator + 1,
        )));
        fixes.extend(
            parens_before
                .iter()
                .map(|&paren| RuleFix::remove_range(paren)),
        );
        s.reset_pos(constituent.end());
        for _ in &parens_before {
            s.scan();
            if s.token() != SyntaxKind::CloseParenToken {
                panic!(
                    "expected next scanned token to be ')', got '{}'",
                    s.token().as_str()
                );
            }
            fixes.push(RuleFix::remove_range(s.token_range()));
        }
        return fixes;
    }

    // The first constituent: remove the operator after it instead.
    s.reset_pos(constituent.end());
    let mut closing_parens = 0;
    loop {
        s.scan();
        if s.token_start() >= parent.end() {
            panic!("couldn't find '&' or '|' token");
        }
        if is_operator(s.token()) {
            fixes.push(RuleFix::remove_range(s.token_range()));
            break;
        }
        if s.token() != SyntaxKind::CloseParenToken {
            panic!(
                "expected next scanned token to be ')', got '{}'",
                s.token().as_str()
            );
        }
        closing_parens += 1;
        fixes.push(RuleFix::remove_range(s.token_range()));
    }

    // tsgolint scans at most `closing_parens` tokens from the start of the
    // composite and adds the `(` ranges seen so far on every step, so a
    // range can be listed more than once.
    let mut opening_parens: Vec<TextRange> = Vec::with_capacity(closing_parens);
    s.reset_pos(parent.pos());
    for _ in 0..closing_parens {
        s.scan();
        if s.token() == SyntaxKind::OpenParenToken {
            if opening_parens.len() < closing_parens {
                opening_parens.push(s.token_range());
            }
        } else {
            opening_parens.clear();
        }
        if s.token_start() == constituent.pos() {
            if opening_parens.len() != closing_parens {
                panic!(
                    "expected to find {closing_parens} opening parens, found only {}",
                    opening_parens.len()
                );
            }
            break;
        }
        fixes.extend(
            opening_parens
                .iter()
                .map(|&paren| RuleFix::remove_range(paren)),
        );
    }
    fixes
}
