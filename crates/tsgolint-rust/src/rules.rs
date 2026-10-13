//! The rules of each payload file (Go `fileConfigs` and `GetRulesForFile`
//! in `cmd/tsgolint/headless.go`).

use std::sync::Arc;

use goport_util::frontend::tspath::{normalize_slashes, to_path};
use rustc_hash::FxHashMap;
use serde_json::Value;
use tsgolint_core::{ConfiguredRule, RuleContext, RuleDefinition, RuleListeners};

use crate::payload::{Payload, PayloadRule};

/// The configured rules of each file, keyed by canonical path. Shared with
/// the checker threads.
#[derive(Debug, Default)]
pub struct FileRules {
    by_path: FxHashMap<String, Arc<[ConfiguredRule]>>,
    none: Arc<[ConfiguredRule]>,
}

/// Stands in for a config with a name the registry does not know. tsgolint
/// panics with `unknown rule: <name>` when it gets the rules of a file to
/// lint it, after the TypeScript diagnostics and before any rule of the
/// file runs. This rule is the only one of such a file, and panics in the
/// same place, on the checker thread; the panic reaches the loading thread.
static UNKNOWN_RULE: RuleDefinition = RuleDefinition {
    name: "",
    create: unknown_rule,
};

fn unknown_rule(ctx: &mut RuleContext<'_>, _options: &Value) -> RuleListeners {
    panic!("unknown rule: {}", ctx.rule_name())
}

/// The rules of one config, in payload order, each with its options
/// (`null` when the payload has none).
fn configured_rules(
    rules: &[PayloadRule],
    find: &impl Fn(&str) -> Option<&'static RuleDefinition>,
) -> Arc<[ConfiguredRule]> {
    let mut configured = Vec::with_capacity(rules.len());
    for rule in rules {
        let Some(definition) = find(&rule.name) else {
            return Arc::new([ConfiguredRule {
                name: rule.name.clone(),
                definition: &UNKNOWN_RULE,
                options: Value::Null,
            }]);
        };
        configured.push(ConfiguredRule {
            name: definition.name.to_owned(),
            definition,
            options: rule.options.clone().unwrap_or(Value::Null),
        });
    }
    configured.into()
}

impl FileRules {
    /// The payload files with slashes normalized (every occurrence, in
    /// payload order), and the rules of each file. A file listed by several
    /// configs gets the rules of the last one (Go map assignment). `find`
    /// looks up a rule by name.
    pub fn from_payload(
        payload: &Payload,
        cwd: &str,
        case_sensitive: bool,
        find: impl Fn(&str) -> Option<&'static RuleDefinition>,
    ) -> (Vec<String>, FileRules) {
        let mut files = Vec::new();
        let mut by_path = FxHashMap::default();
        for config in &payload.configs {
            let rules = configured_rules(&config.rules, &find);
            for file_path in &config.file_paths {
                let normalized = normalize_slashes(file_path);
                by_path.insert(
                    to_path(&normalized, cwd, case_sensitive).0,
                    Arc::clone(&rules),
                );
                files.push(normalized);
            }
        }
        (
            files,
            FileRules {
                by_path,
                none: Arc::new([]),
            },
        )
    }

    /// The registry's rules (`tsgolint_rules::find_rule`).
    pub fn from_payload_with_registry(
        payload: &Payload,
        cwd: &str,
        case_sensitive: bool,
    ) -> (Vec<String>, FileRules) {
        Self::from_payload(payload, cwd, case_sensitive, tsgolint_rules::find_rule)
    }

    /// The configured rules of the file with canonical path `path`, in
    /// payload order. A file the payload does not list has none.
    pub fn rules_for_path(&self, path: &str) -> Arc<[ConfiguredRule]> {
        Arc::clone(self.by_path.get(path).unwrap_or(&self.none))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::PayloadConfig;

    fn rule(name: &str) -> PayloadRule {
        PayloadRule {
            name: name.into(),
            options: None,
        }
    }

    fn names(rules: &FileRules, path: &str) -> Vec<String> {
        rules
            .rules_for_path(path)
            .iter()
            .map(|r| r.name.clone())
            .collect()
    }

    #[test]
    fn last_config_wins_and_paths_are_canonical() {
        let payload = Payload {
            configs: vec![
                PayloadConfig {
                    file_paths: vec!["/p/a.ts".into(), "/p/b.ts".into()],
                    rules: vec![rule("no-array-delete")],
                },
                PayloadConfig {
                    file_paths: vec!["/p/./a.ts".into(), "C:\\p\\c.ts".into()],
                    rules: vec![rule("require-array-sort-compare"), rule("no-array-delete")],
                },
                PayloadConfig {
                    file_paths: vec!["/P/B.ts".into()],
                    rules: vec![],
                },
            ],
            ..Payload::default()
        };
        let (files, rules) = FileRules::from_payload_with_registry(&payload, "/p", true);
        assert_eq!(
            files,
            ["/p/a.ts", "/p/b.ts", "/p/./a.ts", "C:/p/c.ts", "/P/B.ts"]
        );
        assert_eq!(
            names(&rules, "/p/a.ts"),
            ["require-array-sort-compare", "no-array-delete"]
        );
        assert_eq!(names(&rules, "/p/b.ts"), ["no-array-delete"]);
        assert!(names(&rules, "c:/p/c.ts").is_empty());
        assert_eq!(names(&rules, "C:/p/c.ts").len(), 2);
        assert!(names(&rules, "/P/B.ts").is_empty());
        assert!(names(&rules, "/nope.ts").is_empty());

        // Case-insensitive: keys are lowercased.
        let (_, rules) = FileRules::from_payload_with_registry(&payload, "/p", false);
        assert!(names(&rules, "/p/b.ts").is_empty());
        assert_eq!(names(&rules, "c:/p/c.ts").len(), 2);
    }

    #[test]
    fn keeps_payload_order_and_options() {
        let mut with_options = rule("no-array-delete");
        with_options.options = Some(serde_json::json!({"x": 1}));
        let payload = Payload {
            configs: vec![PayloadConfig {
                file_paths: vec!["/a.ts".into()],
                rules: vec![
                    rule("require-array-sort-compare"),
                    with_options,
                    rule("require-array-sort-compare"),
                ],
            }],
            ..Payload::default()
        };
        let (_, rules) = FileRules::from_payload_with_registry(&payload, "/", true);
        let found = rules.rules_for_path("/a.ts");
        assert_eq!(
            found
                .iter()
                .map(|r| (r.name.as_str(), r.options.to_string()))
                .collect::<Vec<_>>(),
            [
                ("require-array-sort-compare", "null".into()),
                ("no-array-delete", r#"{"x":1}"#.into()),
                ("require-array-sort-compare", "null".into())
            ]
        );
    }

    #[test]
    fn unknown_rule_is_the_only_rule_of_its_files() {
        let payload = Payload {
            configs: vec![PayloadConfig {
                file_paths: vec!["/a.ts".into()],
                rules: vec![rule("no-array-delete"), rule("nope"), rule("nope2")],
            }],
            ..Payload::default()
        };
        let (_, rules) = FileRules::from_payload_with_registry(&payload, "/", true);
        let found = rules.rules_for_path("/a.ts");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "nope");
        assert!(std::ptr::eq(found[0].definition, &UNKNOWN_RULE));
    }
}
