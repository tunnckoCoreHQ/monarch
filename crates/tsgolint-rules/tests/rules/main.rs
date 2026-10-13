//! tsgolint's rule tests: every case of `tests/data/cases` against
//! tsgolint's expectations and its snapshots in `tests/data/snapshots`.
//!
//! `cargo test -p tsgolint-rules --test rules [-- <filter>]`. A trial is
//! named `<rule>::<GoTest>/valid-<i>` or `.../invalid-<i>`; the filter
//! matches any part of it. Cases that tsgolint skips are ignored.
//!
//! An accepted divergence (`tests/data/divergences/<rule>.json`, explained
//! in `tests/data/divergences.md`) pins the Rust result of a case; the case
//! then passes when it produces exactly that result. Set
//! `TSGOLINT_PRINT_RESULT=1` to print the result of each failing case in the
//! pinned form.

mod cases;
mod pool;
mod runner;
mod snapshot;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use libtest_mimic::{Arguments, Failed, Trial};
use rustc_hash::{FxHashMap, FxHashSet};

use cases::{Case, load_suites};
use runner::{CaseSetup, Divergences, Observed};
use snapshot::parse_snapshot_file;

struct Shared {
    fixtures: String,
    /// Snapshot entries by rule name.
    snapshots: FxHashMap<String, FxHashMap<String, String>>,
    /// Accepted divergences by rule name.
    divergences: FxHashMap<String, Divergences>,
    print_result: bool,
    loading: pool::LoadingThreads,
}

fn data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data")
}

/// The files of `dir` that end in `ext`, parsed, by name without `ext`.
fn load_dir<T>(dir: &Path, ext: &str, parse: impl Fn(&str) -> T) -> FxHashMap<String, T> {
    std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            let name = path.file_name()?.to_str()?.strip_suffix(ext)?.to_owned();
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            Some((name, parse(&text)))
        })
        .collect()
}

/// Panics when a divergence entry names a rule or a case that does not
/// exist, so that a renamed case cannot leave a stale entry behind.
fn check_divergence_keys(divergences: &FxHashMap<String, Divergences>, cases: &FxHashSet<String>) {
    let mut unknown: Vec<String> = divergences
        .iter()
        .flat_map(|(rule, entries)| entries.keys().map(move |key| format!("{rule}::{key}")))
        .filter(|name| !cases.contains(name))
        .collect();
    unknown.sort();
    assert!(
        unknown.is_empty(),
        "divergence entries without a case: {}",
        unknown.join(", ")
    );
}

fn main() {
    let args = Arguments::from_args();
    let data = data_dir();
    let shared = Arc::new(Shared {
        fixtures: data.join("fixtures").to_str().unwrap().to_owned(),
        snapshots: load_dir(&data.join("snapshots"), ".snap", parse_snapshot_file),
        divergences: load_dir(&data.join("divergences"), ".json", |text| {
            serde_json::from_str(text).expect("divergences file")
        }),
        print_result: std::env::var_os("TSGOLINT_PRINT_RESULT").is_some(),
        loading: pool::LoadingThreads::new(
            args.test_threads
                .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, usize::from)),
        ),
    });

    let mut trials = Vec::new();
    let mut case_names = FxHashSet::default();
    for suite in load_suites(&data.join("cases")) {
        let rule = tsgolint_rules::find_rule(&suite.rule)
            .unwrap_or_else(|| panic!("unknown rule {}", suite.rule));
        let only_mode = suite
            .valid
            .iter()
            .chain(&suite.invalid)
            .any(|case| case.only);
        let suite_tsconfig: Arc<str> = suite.tsconfig.as_str().into();
        let kinds = [(false, suite.valid), (true, suite.invalid)];
        for (invalid, cases) in kinds {
            for case in cases {
                let kind = if invalid { "invalid" } else { "valid" };
                let key = format!("{}/{kind}-{}", suite.test, case.index);
                let ignored = case.skip || (only_mode && !case.only);
                let name = format!("{}::{key}", suite.rule);
                case_names.insert(name.clone());
                let job = CaseJob {
                    shared: shared.clone(),
                    rule,
                    tsconfig: suite_tsconfig.clone(),
                    key,
                    invalid,
                    case,
                };
                trials.push(Trial::test(name, move || job.run()).with_ignored_flag(ignored));
            }
        }
    }
    check_divergence_keys(&shared.divergences, &case_names);
    libtest_mimic::run(&args, trials).exit();
}

struct CaseJob {
    shared: Arc<Shared>,
    rule: &'static tsgolint_core::RuleDefinition,
    tsconfig: Arc<str>,
    /// `<GoTest>/<kind>-<index>`.
    key: String,
    invalid: bool,
    case: Case,
}

impl CaseJob {
    /// Runs the case on a loading thread.
    fn run(self) -> Result<(), Failed> {
        let shared = self.shared.clone();
        shared
            .loading
            .run(move || self.check())
            .map_err(|message| Failed::from(format!("panic: {message}")))?
    }

    fn check(&self) -> Result<(), Failed> {
        let setup = CaseSetup {
            fixtures: &self.shared.fixtures,
            default_tsconfig: &self.tsconfig,
            rule: self.rule,
        };
        let (observed, failures) = if self.invalid {
            let snapshot_key = format!("[{} - 1]", self.key);
            let snapshot = self
                .shared
                .snapshots
                .get(self.rule.name)
                .and_then(|entries| entries.get(&snapshot_key));
            setup.run_invalid(&self.case, snapshot.map(String::as_str), &snapshot_key)?
        } else {
            setup.run_valid(&self.case)?
        };
        let divergence = self
            .shared
            .divergences
            .get(self.rule.name)
            .and_then(|entries| entries.get(&self.key));
        match divergence {
            None if failures.is_empty() => Ok(()),
            None => Err(self.failed(&failures, &observed)),
            Some(_) if failures.is_empty() => Err(Failed::from(format!(
                "{} matches tsgolint now: remove its divergence entry",
                self.key
            ))),
            Some(divergence) if divergence.result == observed => Ok(()),
            Some(divergence) => Err(self.failed(
                &[format!(
                    "the result differs from the pinned divergence ({})",
                    divergence.reason
                )],
                &observed,
            )),
        }
    }

    fn failed(&self, failures: &[String], observed: &Observed) -> Failed {
        let mut message = failures.join("\n\n");
        if self.shared.print_result {
            message.push_str("\n\n--- Result ---\n");
            message.push_str(&serde_json::to_string_pretty(observed).unwrap());
        }
        Failed::from(message)
    }
}
