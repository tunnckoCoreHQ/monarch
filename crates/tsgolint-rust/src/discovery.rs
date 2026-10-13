//! Which tsconfig lints each file (Go `internal/utils/find_tsconfig.go`).
//!
//! tsgolint runs typescript-go's project-service lookup
//! (`ConfigFileRegistryBuilder`, `findOrCreateDefaultConfiguredProjectWorker`)
//! for each file. This module does the same on goport_core's tsoptions:
//!
//! 1. The nearest `tsconfig.json`, then `jsconfig.json`, in the file's
//!    directory and its ancestors; the walk stops after a directory that
//!    ends in `/node_modules`.
//! 2. A breadth-first search from that config through `references`. A
//!    config matches when its file names include the file. Configs with no
//!    file names do not match but their references are searched (solution
//!    configs). A `composite` config that cannot match the file name is
//!    skipped early. One visited set, keyed by config file name, spans the
//!    whole search of a file.
//! 3. Without a match, the same search from the next ancestor config. From a
//!    `tsconfig.json`, the `jsconfig.json` beside it still counts as an
//!    ancestor.
//! 4. Otherwise the file is unmatched and goes to the inferred program.
//!
//! Parsed configs are cached for the whole run, as the registry does.

use std::cell::RefCell;
use std::rc::Rc;

use goport_core::frontend::tsoptions::{
    ExtendedConfigCache, ExtendedConfigCacheEntry, ParseConfigHost, ParsedCommandLine,
    get_parsed_command_line_of_config_file_path, parse_extended_config,
};
use goport_core::gostd::strconv;
use goport_core::options::Tristate;
use goport_util::frontend::tspath::{
    Path, combine_paths, for_each_ancestor_directory, get_directory_path, get_encoded_root_length,
    normalize_path, to_path,
};
use goport_util::frontend::vfs::Fs;
use rustc_hash::{FxHashMap, FxHashSet};

/// Files grouped by the tsconfig that lints them, in first-seen order.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Workload {
    /// (config file name, files). Each file appears once.
    pub programs: Vec<(String, Vec<String>)>,
    /// Files that no tsconfig claims (the inferred program).
    pub unmatched_files: Vec<String>,
}

/// Go `TsConfigResolver`.
pub struct TsConfigResolver {
    host: ResolverHost,
    case_sensitive: bool,
    /// Parsed configs by canonical path. `None`: the file could not be read.
    configs: RefCell<FxHashMap<Path, Option<Rc<ParsedCommandLine>>>>,
    extended_configs: ExtendedConfigs,
}

/// The parse host of the registry: the run's file system and the process
/// working directory.
struct ResolverHost {
    fs: Rc<dyn Fs>,
    current_directory: String,
}

impl ParseConfigHost for ResolverHost {
    fn fs(&self) -> Rc<dyn Fs> {
        Rc::clone(&self.fs)
    }

    fn get_current_directory(&self) -> String {
        self.current_directory.clone()
    }
}

/// Extended configs (`extends`) parsed once per run.
#[derive(Default)]
struct ExtendedConfigs {
    entries: RefCell<FxHashMap<Path, Rc<ExtendedConfigCacheEntry>>>,
}

impl ExtendedConfigCache for ExtendedConfigs {
    fn get_extended_config(
        &self,
        file_name: &str,
        path: &Path,
        resolution_stack: &[Path],
        host: &dyn ParseConfigHost,
    ) -> Rc<ExtendedConfigCacheEntry> {
        if let Some(entry) = self.entries.borrow().get(path) {
            return Rc::clone(entry);
        }
        let entry = Rc::new(parse_extended_config(
            file_name,
            path.clone(),
            resolution_stack,
            host,
            Some(self),
        ));
        self.entries
            .borrow_mut()
            .insert(path.clone(), Rc::clone(&entry));
        entry
    }
}

impl TsConfigResolver {
    pub fn new(fs: Rc<dyn Fs>, current_directory: &str) -> Self {
        let case_sensitive = fs.use_case_sensitive_file_names();
        Self {
            host: ResolverHost {
                fs,
                current_directory: current_directory.to_string(),
            },
            case_sensitive,
            configs: RefCell::default(),
            extended_configs: ExtendedConfigs::default(),
        }
    }

    fn to_path(&self, file_name: &str) -> Path {
        to_path(file_name, &self.host.current_directory, self.case_sensitive)
    }

    /// Go `FindTsConfigParallel` plus the workload grouping of
    /// `runHeadless`. tsgolint returns a map, so its order is random; this
    /// keeps the order in which files and configs first appear.
    pub fn resolve(&self, files: &[String]) -> Workload {
        // Files of one directory share the nearest-config lookup.
        let mut directories: Vec<(String, Vec<&str>)> = Vec::new();
        let mut directory_index: FxHashMap<String, usize> = FxHashMap::default();
        let mut seen: FxHashSet<&str> = FxHashSet::default();
        let mut order: Vec<&str> = Vec::new();
        for file in files {
            // The result is keyed by file name, so duplicates collapse.
            if !seen.insert(file) {
                continue;
            }
            order.push(file);
            let directory = get_directory_path(file);
            let index = *directory_index.entry(directory.clone()).or_insert_with(|| {
                directories.push((directory, Vec::new()));
                directories.len() - 1
            });
            directories[index].1.push(file);
        }

        let mut config_of: FxHashMap<&str, String> = FxHashMap::default();
        for (_, group) in &directories {
            for (file, config) in self.resolve_directory(group) {
                config_of.insert(file, config);
            }
        }

        let mut workload = Workload::default();
        let mut program_index: FxHashMap<String, usize> = FxHashMap::default();
        for file in order {
            let config = config_of.remove(file).unwrap_or_default();
            if config.is_empty() {
                workload.unmatched_files.push(file.to_string());
            } else {
                let index = *program_index.entry(config.clone()).or_insert_with(|| {
                    workload.programs.push((config, Vec::new()));
                    workload.programs.len() - 1
                });
                workload.programs[index].1.push(file.to_string());
            }
        }
        workload
    }

    /// Go `resolveDirectory`: the files of one directory and their configs
    /// (`""` for none).
    fn resolve_directory<'f>(&self, files: &[&'f str]) -> Vec<(&'f str, String)> {
        let config_name = self.compute_config_file_name(files[0], false);
        if config_name.is_empty() {
            return files.iter().map(|&f| (f, String::new())).collect();
        }
        // A file that the nearest config includes cannot be claimed by a
        // reference or an ancestor; only the others need the full search.
        let nearest = self.config(&config_name);
        files
            .iter()
            .map(|&file| {
                let path = self.to_path(file);
                let included = nearest
                    .as_ref()
                    .is_some_and(|c| c.file_names_by_path().contains_key(&path));
                let config = if included {
                    config_name.clone()
                } else {
                    self.find_config_with_references(
                        file,
                        &path,
                        &config_name,
                        &mut FxHashSet::default(),
                    )
                };
                (file, config)
            })
            .collect()
    }

    /// Go `ComputeConfigFileName` without a custom config file name.
    /// `skip_search_in_directory_of_file` is set when looking for the
    /// ancestor of the config `file_name`: a `tsconfig.json` skips only the
    /// `tsconfig.json` of its own directory, a `jsconfig.json` skips both.
    pub fn compute_config_file_name(
        &self,
        file_name: &str,
        skip_search_in_directory_of_file: bool,
    ) -> String {
        let fs = &self.host.fs;
        let mut skip_tsconfig = skip_search_in_directory_of_file;
        let mut skip_jsconfig =
            skip_search_in_directory_of_file && !file_name.ends_with("/tsconfig.json");
        let (result, _) =
            for_each_ancestor_directory(&get_directory_path(file_name), |directory| {
                if !skip_tsconfig {
                    let tsconfig = combine_paths(directory, &["tsconfig.json"]);
                    if fs.file_exists(&tsconfig) {
                        return (tsconfig, true);
                    }
                }
                if !skip_jsconfig {
                    let jsconfig = combine_paths(directory, &["jsconfig.json"]);
                    if fs.file_exists(&jsconfig) {
                        return (jsconfig, true);
                    }
                }
                if directory.ends_with("/node_modules") {
                    return (String::new(), true);
                }
                skip_tsconfig = false;
                skip_jsconfig = false;
                (String::new(), false)
            });
        result
    }

    /// Go `FindOrAcquireConfigForFile(..., ProjectLoadKindCreate)`: the
    /// parsed config, parsed once per run.
    ///
    /// # Panics
    ///
    /// When `config_file_name` is not normalized and absolute (from a
    /// payload path such as `/p/./a.ts`): typescript-go's `NewSourceFile`
    /// panics on such a name.
    fn config(&self, config_file_name: &str) -> Option<Rc<ParsedCommandLine>> {
        let path = self.to_path(config_file_name);
        if let Some(config) = self.configs.borrow().get(&path) {
            return config.clone();
        }
        if get_encoded_root_length(config_file_name) == 0
            || config_file_name != normalize_path(config_file_name)
        {
            panic!(
                "fileName should be normalized and absolute: {}",
                strconv::quote(config_file_name)
            );
        }
        let (parsed, _) =
            tsgolint_core::program::parse_outside_program(&self.host.current_directory, || {
                get_parsed_command_line_of_config_file_path(
                    config_file_name,
                    path.clone(),
                    None,
                    None,
                    &self.host,
                    Some(&self.extended_configs),
                )
            });
        let parsed = parsed.map(Rc::new);
        self.configs.borrow_mut().insert(path, parsed.clone());
        parsed
    }

    /// Go `findConfigWithReferences`: the config that includes `file`, or
    /// `""`.
    ///
    /// tsgolint also threads a "fallback" through this search, and returns
    /// it when the nearest config has `disableSolutionSearching`. Its BFS
    /// visit never reports a non-stopping result, so the fallback is never
    /// set and `disableSolutionSearching` never changes the result; this
    /// port leaves that dead branch out.
    fn find_config_with_references(
        &self,
        file: &str,
        path: &Path,
        config_file_name: &str,
        visited: &mut FxHashSet<String>,
    ) -> String {
        if let Some(found) = self.search_references(file, path, config_file_name, visited) {
            return found;
        }
        // The common case of a solution tsconfig.json higher up that holds
        // every project of a workspace.
        let ancestor = self.compute_config_file_name(config_file_name, true);
        if ancestor.is_empty() {
            return String::new();
        }
        self.find_config_with_references(file, path, &ancestor, visited)
    }

    /// The breadth-first search through `references` from `start`. Each
    /// level is visited in insertion order; a config is marked visited
    /// before it is checked, so one reached twice is checked once.
    fn search_references(
        &self,
        file: &str,
        path: &Path,
        start: &str,
        visited: &mut FxHashSet<String>,
    ) -> Option<String> {
        let mut level: Vec<String> = vec![start.to_string()];
        while !level.is_empty() {
            let mut next_level: Vec<String> = Vec::new();
            let mut next_seen: FxHashSet<String> = FxHashSet::default();
            for config_file_name in level {
                if !visited.insert(config_file_name.clone()) {
                    continue;
                }
                let Some(config) = self.config(&config_file_name) else {
                    continue;
                };
                if self.matches(&config, file, path) {
                    return Some(config_file_name);
                }
                if !config.project_references().is_empty() {
                    for reference in config.resolved_project_reference_paths() {
                        if next_seen.insert(reference.clone()) {
                            next_level.push(reference.clone());
                        }
                    }
                }
            }
            level = next_level;
        }
        None
    }

    fn matches(&self, config: &ParsedCommandLine, file: &str, path: &Path) -> bool {
        if config.file_names().is_empty() {
            return false;
        }
        // A composite project gives an early negative.
        if config.compiler_options().composite == Tristate::True
            && !config.possibly_matches_file_name(file)
        {
            return false;
        }
        config.file_names_by_path().contains_key(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goport_util::frontend::bundled;
    use goport_util::frontend::vfs::{cachedvfs_from, osvfs_fs};

    fn fixtures() -> String {
        format!(
            "{}/e2e/fixtures",
            env!("CARGO_MANIFEST_DIR").replace('\\', "/")
        )
    }

    fn resolver() -> TsConfigResolver {
        let fs: Rc<dyn Fs> = bundled::wrap_fs(cachedvfs_from(osvfs_fs()));
        TsConfigResolver::new(fs, &fixtures())
    }

    fn relative(workload: Workload) -> (Vec<(String, Vec<String>)>, Vec<String>) {
        let base = format!("{}/", fixtures());
        let strip = |s: &str| s.strip_prefix(&base).unwrap_or(s).to_string();
        (
            workload
                .programs
                .into_iter()
                .map(|(c, files)| (strip(&c), files.iter().map(|f| strip(f)).collect()))
                .collect(),
            workload.unmatched_files.iter().map(|f| strip(f)).collect(),
        )
    }

    fn resolve(files: &[&str]) -> (Vec<(String, Vec<String>)>, Vec<String>) {
        let files: Vec<String> = files
            .iter()
            .map(|f| format!("{}/{f}", fixtures()))
            .collect();
        relative(resolver().resolve(&files))
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn project_references_pick_the_first_including_reference() {
        let (programs, unmatched) = resolve(&[
            "project-references/img/typescript/subdir/index.ts",
            "project-references/img/typescript/subdir/enum.ts",
        ]);
        assert_eq!(
            programs,
            vec![(
                "project-references/img/typescript/tsconfig.app.json".to_string(),
                strings(&[
                    "project-references/img/typescript/subdir/index.ts",
                    "project-references/img/typescript/subdir/enum.ts"
                ])
            )]
        );
        assert!(unmatched.is_empty());
    }

    #[test]
    fn circular_references_terminate() {
        let (programs, unmatched) = resolve(&[
            "circular-project-references/project1/src/demo/index.ts",
            "circular-project-references/project2/src/demo/index.ts",
        ]);
        assert_eq!(
            programs,
            vec![
                (
                    "circular-project-references/project1/tsconfig.json".to_string(),
                    strings(&["circular-project-references/project1/src/demo/index.ts"])
                ),
                (
                    "circular-project-references/project2/tsconfig.json".to_string(),
                    strings(&["circular-project-references/project2/src/demo/index.ts"])
                ),
            ]
        );
        assert!(unmatched.is_empty());
    }

    /// `tests/data/discovery`: one tree per lookup rule, with the configs
    /// that the Go binary picked (`OXC_LOG=debug` "Got tsconfig for file"
    /// lines) in `expected-go.txt`.
    #[test]
    fn matches_go_on_discovery_scenarios() {
        let base = format!(
            "{}/tests/data/discovery",
            env!("CARGO_MANIFEST_DIR").replace('\\', "/")
        );
        fn walk(dir: &std::path::Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "ts") {
                    out.push(path.to_str().unwrap().replace('\\', "/"));
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new(&base), &mut files);
        files.sort();
        let fs: Rc<dyn Fs> = bundled::wrap_fs(cachedvfs_from(osvfs_fs()));
        let workload = TsConfigResolver::new(fs, &base).resolve(&files);
        let strip = |s: &str| s.strip_prefix(&format!("{base}/")).unwrap().to_string();
        let mut got: Vec<String> = Vec::new();
        for (config, files) in &workload.programs {
            for file in files {
                got.push(format!(
                    "Got tsconfig for file {}: {}",
                    strip(file),
                    strip(config)
                ));
            }
        }
        for file in &workload.unmatched_files {
            got.push(format!("Got tsconfig for file {}: <none>", strip(file)));
        }
        got.sort();
        let expected = std::fs::read_to_string(format!("{base}/expected-go.txt")).unwrap();
        assert_eq!(got.join("\n"), expected.trim_end());
    }

    #[test]
    fn ancestor_config_when_the_nearest_excludes_the_file() {
        let (programs, unmatched) = resolve(&["issue-vp-1443/packages/cli/src/utils/terminal.ts"]);
        assert_eq!(
            programs,
            vec![(
                "issue-vp-1443/tsconfig.json".to_string(),
                strings(&["issue-vp-1443/packages/cli/src/utils/terminal.ts"])
            )]
        );
        assert!(unmatched.is_empty());
    }

    #[test]
    fn unmatched_files_and_duplicates() {
        let (programs, unmatched) = resolve(&[
            "with-unmatched-files/test.ts",
            "with-unmatched-files/src/index.ts",
            "with-unmatched-files/test.ts",
        ]);
        assert_eq!(
            programs,
            vec![(
                "with-unmatched-files/tsconfig.json".to_string(),
                strings(&["with-unmatched-files/src/index.ts"])
            )]
        );
        assert_eq!(unmatched, strings(&["with-unmatched-files/test.ts"]));
    }

    #[test]
    fn no_config_anywhere() {
        let resolver = resolver();
        let workload = resolver.resolve(&strings(&[
            "/nonexistent-tsgolint-dir/a.ts",
            "/nonexistent-tsgolint-dir/b.ts",
        ]));
        assert!(workload.programs.is_empty());
        assert_eq!(
            workload.unmatched_files,
            strings(&[
                "/nonexistent-tsgolint-dir/a.ts",
                "/nonexistent-tsgolint-dir/b.ts"
            ])
        );
    }
}
