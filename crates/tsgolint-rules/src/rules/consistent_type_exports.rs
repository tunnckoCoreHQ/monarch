//! `consistent-type-exports`: requires `export type` for exports that are
//! only types.

use goport_core::ast::{
    TextRange, is_named_exports, is_namespace_export, is_type_only_import_or_export_declaration,
    source_file_text,
};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId};
use goport_core::flags::SymbolFlags;
use goport_core::frontend::scanner::scanner_ls::get_scanner_for_source_file;
use rustc_hash::FxHashSet;
use serde::Deserialize;
use serde_json::Value;
use tsgolint_core::{
    Listeners, Report, RuleContext, RuleDefinition, RuleFix, RuleListeners, RuleMessage,
    decode_options, node_text, trim_node_text_range,
};

pub static RULE: RuleDefinition = RuleDefinition {
    name: "consistent-type-exports",
    create,
};

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    fix_mixed_exports_with_inline_type_specifier: bool,
}

fn type_over_value_message() -> RuleMessage {
    RuleMessage::new(
        "typeOverValue",
        "All exports in the declaration are only used as types.",
    )
    .with_help("Use `export type`.")
}

fn single_export_is_type_message(export_name: &str) -> RuleMessage {
    RuleMessage::new(
        "singleExportIsType",
        format!(
            "Type export {export_name} is not a value and should be exported using `export type`."
        ),
    )
    .with_help(format!(
        "Try adding the `type` keyword: `type {export_name}`"
    ))
}

fn multiple_exports_are_types_message(export_names: &str) -> RuleMessage {
    RuleMessage::new(
        "multipleExportsAreTypes",
        format!(
            "Type exports {export_names} are not values and should be exported using `export type`."
        ),
    )
}

fn create(_ctx: &mut RuleContext<'_>, options: &Value) -> RuleListeners {
    let options: Options = decode_options(options, RULE.name);
    Listeners::new(options)
        .on(SyntaxKind::ExportDeclaration, |options, ctx, node| {
            let clause = node.export_clause();
            if clause.is_nil() || is_namespace_export(clause) {
                check_star_export(ctx, node);
            } else if is_named_exports(clause) {
                check_named_export(options, ctx, node);
            }
        })
        .into()
}

fn check_star_export(ctx: &mut RuleContext<'_>, node: Node) {
    let module_specifier = node.module_specifier();
    if node.is_type_only() || module_specifier.is_nil() {
        return;
    }
    let module_symbol = ctx
        .checker
        .get_symbol_at_location_exported(module_specifier);
    if module_symbol.is_nil() {
        return;
    }
    let module_type = ctx.checker.get_type_of_symbol(module_symbol);
    if module_type.is_nil() {
        return;
    }
    let properties = ctx.checker.get_properties_of_type(module_type);
    let has_exported_value = properties.iter().any(|&property| {
        let name = ctx.checker.sym(property).name.as_str();
        ctx.checker
            .get_property_of_type(module_type, name)
            .is_some()
    });
    if has_exported_value {
        return;
    }

    let report = Report::new(
        export_keyword_range(ctx.source_file, node),
        type_over_value_message(),
    );
    ctx.report_diagnostic_with_fixes(report, |ctx| {
        let text = source_file_text(ctx.source_file);
        let mut scanner = get_scanner_for_source_file(ctx.source_file, &text, node.pos());
        loop {
            if scanner.token() == SyntaxKind::AsteriskToken {
                let token = scanner.token_range();
                return vec![RuleFix::replace_range(token.with_end(token.pos()), "type ")];
            }
            if scanner.token() == SyntaxKind::EndOfFile || scanner.token_range().pos() >= node.end()
            {
                return Vec::new();
            }
            scanner.scan();
        }
    });
}

/// The specifiers of a named export, sorted by kind.
#[derive(Default)]
struct NamedExport {
    /// Texts of the type-only and type-based specifiers.
    type_texts: Vec<String>,
    /// The type-based specifiers without a `type` modifier, and their texts.
    type_based: Vec<(Node, String)>,
    value_texts: Vec<String>,
    module_source: String,
}

fn analyze_named_export(checker: &mut Checker, source_file: Node, node: Node) -> NamedExport {
    let mut export = NamedExport::default();
    let module_specifier = node.module_specifier();
    if module_specifier.is_some() {
        export.module_source = node_text(source_file, module_specifier).trim().to_owned();
    }
    for specifier in node.export_clause().elements() {
        let text = export_specifier_text(source_file, specifier);
        if specifier.is_type_only() {
            export.type_texts.push(text);
            continue;
        }
        let property_name = specifier.property_name();
        let local = if property_name.is_some() {
            property_name
        } else {
            specifier.name()
        };
        let symbol = checker.get_symbol_at_location_exported(local);
        match symbol_export_kind(checker, symbol) {
            Some(ExportKind::Type) => {
                export.type_texts.push(text.clone());
                export.type_based.push((specifier, text));
            }
            Some(ExportKind::Value) => export.value_texts.push(text),
            None => {}
        }
    }
    export
}

fn check_named_export(options: &Options, ctx: &mut RuleContext<'_>, node: Node) {
    if node.is_type_only() {
        return;
    }
    let export = analyze_named_export(ctx.checker, ctx.source_file, node);
    if export.type_based.is_empty() {
        return;
    }

    if export.value_texts.is_empty() {
        let report = Report::new(
            export_keyword_range(ctx.source_file, node),
            type_over_value_message(),
        );
        ctx.report_diagnostic_with_fixes(report, |ctx| {
            let statement = named_export_statement(true, &export.type_texts, &export.module_source);
            vec![ctx.fix_replace(node, statement)]
        });
        return;
    }

    let report = if let [(specifier, name)] = export.type_based.as_slice() {
        Report::new(
            ctx.trim_node_text_range(*specifier),
            single_export_is_type_message(name),
        )
    } else {
        let names: Vec<&str> = export
            .type_based
            .iter()
            .map(|(_, name)| name.as_str())
            .collect();
        // tsgolint reports at an empty range here and labels each specifier.
        let mut report = Report::new(
            TextRange::new(0, 0),
            multiple_exports_are_types_message(&join_word_list(&names)),
        );
        for (specifier, name) in &export.type_based {
            report = report.with_label(
                format!("{name} is a type export, try `type {name}`"),
                ctx.trim_node_text_range(*specifier),
            );
        }
        report
    };

    let inline_type_specifier = options.fix_mixed_exports_with_inline_type_specifier;
    ctx.report_diagnostic_with_fixes(report, |ctx| {
        if inline_type_specifier {
            return export
                .type_based
                .iter()
                .map(|(specifier, _)| ctx.fix_insert_before(*specifier, "type "))
                .collect();
        }
        let replacement = format!(
            "{}\n{}",
            named_export_statement(true, &export.type_texts, &export.module_source),
            named_export_statement(false, &export.value_texts, &export.module_source)
        );
        vec![ctx.fix_replace(node, replacement)]
    });
}

/// What an exported name refers to.
enum ExportKind {
    Type,
    Value,
}

/// Whether the symbol is only a type or also a value, following aliases.
/// None when the alias chain does not resolve.
fn symbol_export_kind(checker: &mut Checker, mut symbol: SymbolId) -> Option<ExportKind> {
    let mut visited = FxHashSet::default();
    while symbol.is_some() && visited.insert(symbol) {
        let data = checker.sym(symbol);
        if data
            .declarations
            .iter()
            .any(|&declaration| is_type_only_import_or_export_declaration(declaration))
        {
            return Some(ExportKind::Type);
        }
        if data.flags.intersects(SymbolFlags::VALUE) {
            return Some(ExportKind::Value);
        }
        if data.flags.intersects(SymbolFlags::ALIAS) {
            let next = checker.get_immediate_aliased_symbol(symbol);
            if next.is_nil() {
                return None;
            }
            symbol = next;
            continue;
        }
        return Some(ExportKind::Type);
    }
    None
}

/// Drops a leading `type` keyword and the whitespace after it.
fn strip_leading_type_keyword(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("type") else {
        return text;
    };
    let Some(&next) = rest.as_bytes().first() else {
        return "";
    };
    // Go's `unicode.IsSpace` on the byte read as a rune.
    if !matches!(
        next,
        b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ' | 0x85 | 0xA0 | b'/'
    ) {
        return text;
    }
    rest.trim_start_matches([' ', '\t', '\r', '\n'])
}

fn export_specifier_text(source_file: Node, specifier: Node) -> String {
    let text = node_text(source_file, specifier);
    let text = text.trim();
    if specifier.is_type_only() {
        return strip_leading_type_keyword(text).to_owned();
    }
    let exported = specifier.name();
    let property_name = specifier.property_name();
    let local = if property_name.is_some() {
        property_name
    } else {
        exported
    };
    let local_text = node_text(source_file, local).trim().to_owned();
    let exported_text = node_text(source_file, exported);
    let exported_text = exported_text.trim();
    if local_text == exported_text {
        local_text
    } else {
        format!("{local_text} as {exported_text}")
    }
}

/// The `export` keyword of `node`, or the node when it has none.
fn export_keyword_range(source_file: Node, node: Node) -> TextRange {
    let text = source_file_text(source_file);
    let mut scanner = get_scanner_for_source_file(source_file, &text, node.pos());
    loop {
        if scanner.token() == SyntaxKind::ExportKeyword {
            return scanner.token_range();
        }
        if scanner.token() == SyntaxKind::EndOfFile || scanner.token_range().pos() >= node.end() {
            break;
        }
        scanner.scan();
    }
    trim_node_text_range(source_file, node)
}

fn join_word_list(words: &[&str]) -> String {
    match words {
        [] => String::new(),
        [word] => (*word).to_owned(),
        [first, second] => format!("{first} and {second}"),
        [init @ .., last] => format!("{}, and {last}", init.join(", ")),
    }
}

fn named_export_statement(type_only: bool, specifiers: &[String], source: &str) -> String {
    let mut statement = String::from("export ");
    if type_only {
        statement.push_str("type ");
    }
    statement.push_str("{ ");
    statement.push_str(&specifiers.join(", "));
    statement.push_str(" }");
    if !source.is_empty() {
        statement.push_str(" from ");
        statement.push_str(source);
    }
    statement.push(';');
    statement
}
