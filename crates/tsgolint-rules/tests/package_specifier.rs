//! `{"from": "package"}` specifiers read the nearest `package.json` through
//! the program host's file system, overlays included (Go
//! `findPackageNameFromNearestPackageJSON` reads `program.Host().FS()`).
//!
//! The expectations are what the Go binary reports for the same files: a
//! project on disk with `node_modules/semver/package.json` named
//! `renamed-semver`, linted with `tsgolint headless`, with and without a
//! `source_overrides` entry that renames the package to `overridden`.

use std::sync::Arc;

use rustc_hash::FxHashMap;
use serde_json::json;
use tsgolint_core::{
    ConfiguredRule, CreatedProgram, FsFactory, LintEvent, LintFile, LintSettings, OverlayFs,
    ProgramSettings, create_program, lint_program,
};

const CODE: &str =
    r#"import type { ErrorLike } from "semver"; declare const error: ErrorLike; throw error;"#;
const PACKAGE_JSON: &str =
    r#"{"name": "renamed-semver", "version": "1.0.0", "types": "lib/index.d.ts"}"#;
const INDEX_D_TS: &str = "export interface ErrorLike { message: string }";

/// Runs `f` on a thread with ts-rust's stack size.
fn on_loading_thread<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
    std::thread::Builder::new()
        .stack_size(goport_core::gostd::stack::max_stack_size())
        .spawn(f)
        .unwrap()
        .join()
        .unwrap_or_else(|payload| std::panic::resume_unwind(payload))
}

/// The `(message id, pos, end)` of each `only-throw-error` report on
/// `file_name` when only `ErrorLike` from `package` is allowed.
fn only_throw_error(
    fs: &FsFactory,
    cwd: &str,
    tsconfig: &str,
    file_name: &str,
    package: &str,
) -> Vec<(String, i32, i32)> {
    let settings = ProgramSettings {
        single_threaded: true,
        suppress_program_diagnostics: false,
    };
    let program = match create_program(fs, cwd, tsconfig, settings) {
        Ok(CreatedProgram::Program(program)) => program,
        Ok(CreatedProgram::Invalid(diagnostics)) => panic!("invalid: {diagnostics:?}"),
        Err(error) => panic!("{error}"),
    };
    let rules: Arc<[ConfiguredRule]> = Arc::new([ConfiguredRule {
        name: "only-throw-error".to_owned(),
        definition: tsgolint_rules::find_rule("only-throw-error").unwrap(),
        options: json!({
            "allow": [{"from": "package", "package": package, "name": ["ErrorLike"]}],
        }),
    }]);
    let file = program.source_file(file_name).expect("source file");
    let mut reports = Vec::new();
    lint_program(
        &program,
        &[LintFile { file, rules }],
        LintSettings::default(),
        &mut |event| match event {
            LintEvent::Rule(d) => reports.push((d.message.id, d.range.pos(), d.range.end())),
            LintEvent::Internal(d) => panic!("internal diagnostic: {d:?}"),
        },
    );
    reports
}

fn thrown_object() -> Vec<(String, i32, i32)> {
    vec![("object".to_owned(), 79, 84)]
}

/// The rule tester's virtual files: `package.json` exists only in the
/// overlay, and its name differs from its directory.
#[test]
fn rule_tester_overlay_package_json() {
    on_loading_thread(|| {
        let fixtures = format!("{}/tests/data/fixtures", env!("CARGO_MANIFEST_DIR"));
        let files: FxHashMap<String, String> = [
            ("file.ts", CODE),
            ("node_modules/semver/package.json", PACKAGE_JSON),
            ("node_modules/semver/lib/index.d.ts", INDEX_D_TS),
        ]
        .into_iter()
        .map(|(path, text)| (format!("{fixtures}/{path}"), text.to_owned()))
        .collect();
        let fs = FsFactory::exact_overlay(FsFactory::base(), Arc::new(files));
        let lint =
            |package| only_throw_error(&fs, &fixtures, "tsconfig.minimal.json", "file.ts", package);
        assert_eq!(lint("renamed-semver"), []);
        assert_eq!(lint("semver"), thrown_object());
    });
}

/// Headless `source_overrides` over a project on disk: the override of
/// `package.json` wins over the file on disk.
#[test]
fn source_overrides_package_json() {
    on_loading_thread(|| {
        let dir =
            std::env::temp_dir().join(format!("tsgolint-package-specifier-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("node_modules/semver/lib")).unwrap();
        let write = |path: &str, text: &str| std::fs::write(dir.join(path), text).unwrap();
        write(
            "tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"target":"esnext","module":"commonjs","types":[]},"files":["a.ts"]}"#,
        );
        write("a.ts", CODE);
        write("node_modules/semver/package.json", PACKAGE_JSON);
        write("node_modules/semver/lib/index.d.ts", INDEX_D_TS);
        let cwd = dir.to_str().unwrap().to_owned();

        let lint = |fs: &FsFactory, package| {
            only_throw_error(fs, &cwd, "tsconfig.json", &format!("{cwd}/a.ts"), package)
        };
        let on_disk = FsFactory::source_overrides(Arc::default());
        assert_eq!(lint(&on_disk, "renamed-semver"), []);
        assert_eq!(lint(&on_disk, "semver"), thrown_object());

        let key =
            OverlayFs::canonical_key(&format!("{cwd}/node_modules/semver/package.json"), true);
        let text = r#"{"name":"overridden","types":"lib/index.d.ts"}"#.to_owned();
        let overridden = FsFactory::source_overrides(Arc::new([(key, text)].into_iter().collect()));
        assert_eq!(lint(&overridden, "overridden"), []);
        assert_eq!(lint(&overridden, "renamed-semver"), thrown_object());
        assert_eq!(lint(&overridden, "semver"), thrown_object());

        let _ = std::fs::remove_dir_all(&dir);
    });
}
