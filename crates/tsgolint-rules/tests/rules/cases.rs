//! The test cases dumped from tsgolint's Go rule tests
//! (`tests/data/cases/*.json`, Go `rule_tester/dump_cases.go`).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The cases of one Go test function.
#[derive(Deserialize)]
pub struct Suite {
    /// The Go test name (`TestNoArrayDelete`, or a subtest path).
    pub test: String,
    pub rule: String,
    /// The default tsconfig, relative to the fixtures.
    pub tsconfig: String,
    pub valid: Vec<Case>,
    pub invalid: Vec<Case>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub index: usize,
    pub code: String,
    #[serde(default)]
    pub only: bool,
    #[serde(default)]
    pub skip: bool,
    #[serde(default)]
    pub file_name: String,
    /// The options as the rule receives them; `null` for none.
    #[serde(default)]
    pub options: Value,
    #[serde(default)]
    pub tsconfig: String,
    #[serde(default)]
    pub tsx: bool,
    /// Extra files, relative to the fixtures.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// The code after each fix pass (invalid cases).
    #[serde(default)]
    pub output: Vec<String>,
    #[serde(default)]
    pub errors: Vec<ExpectedError>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedError {
    pub message_id: String,
    /// 1-based; 0 means "not checked".
    #[serde(default)]
    pub line: i32,
    #[serde(default)]
    pub column: i32,
    #[serde(default)]
    pub end_line: i32,
    #[serde(default)]
    pub end_column: i32,
    #[serde(default)]
    pub suggestions: Vec<ExpectedSuggestion>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedSuggestion {
    pub message_id: String,
    pub output: String,
}

pub fn load_suites(dir: &Path) -> Vec<Suite> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
        })
        .collect()
}
