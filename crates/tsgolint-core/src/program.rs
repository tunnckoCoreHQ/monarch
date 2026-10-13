//! Program creation with tsgolint's rules (Go `utils.CreateProgram` and
//! `utils.CreateInferredProjectProgram`).
//!
//! A ts-rust program is per-thread state: the thread that creates it (the
//! loading thread) keeps its frontend and its checker pool. Create, lint and
//! drop a `Program` on that thread.

use std::marker::PhantomData;
use std::rc::Rc;
use std::time::SystemTime;

use goport_core::core::{Diagnostic, GoProgram, Node, ProgramScope, enter_program};
use goport_core::effect::is_effect_code;
use goport_core::flags::{JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget};
use goport_core::frontend::compiler::{CompilerHost, ProgramOptions, new_program};
use goport_core::frontend::parser::parsed_source_file_diagnostics;
use goport_core::frontend::tsoptions::{
    ParseConfigHost, ParsedCommandLine, get_parsed_command_line_of_config_file,
    new_parsed_command_line,
};
use goport_core::frontend::tspath::{self, ComparePathsOptions};
use goport_core::frontend::vfs::{Entries, FileInfo, Fs, FsError};
use goport_core::locale;
use goport_core::options::{CompilerOptions, Tristate};
use goport_core::program as tsprogram;

use crate::diagnostic::{InternalDiagnostic, diagnostic_range};
use crate::fs::FsFactory;

/// A bound program. Dropping it releases the ts-rust program version (its
/// checker pool and tables). It is `!Send`: it lives on its loading thread.
pub struct Program {
    go: &'static GoProgram,
    fs: FsFactory,
    _not_send: PhantomData<Rc<()>>,
}

impl Program {
    fn new(go: &'static GoProgram, fs: FsFactory) -> Self {
        Self {
            go,
            fs,
            _not_send: PhantomData,
        }
    }

    /// Makes this program current on this thread while the scope lives.
    /// Node reads and the `goport_core::program` functions need it.
    pub fn enter(&self) -> ProgramScope {
        enter_program(Some(self.go))
    }

    /// The file system of the program's host.
    pub fn fs(&self) -> &FsFactory {
        &self.fs
    }

    /// The source files in program order.
    pub fn source_files(&self) -> Vec<Node> {
        let _scope = self.enter();
        tsprogram::source_files()
    }

    /// The source file named `file_name` (made absolute against the
    /// program's current directory), as Go `Program.GetSourceFile`.
    pub fn source_file(&self, file_name: &str) -> Option<Node> {
        let _scope = self.enter();
        tsprogram::get_source_file(file_name).get()
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        tsprogram::release_program(self.go);
    }
}

/// The result of `create_program` when the config could be read.
pub enum CreatedProgram {
    Program(Program),
    /// The config or the program has errors: no program, and these
    /// `tsconfig-error` diagnostics.
    Invalid(Vec<InternalDiagnostic>),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProgramSettings {
    /// One checker (the rule tester). Otherwise the checker count comes from
    /// ts-rust's defaults, and the tsconfig's `singleThreaded` is ignored,
    /// as in tsgolint.
    pub single_threaded: bool,
    /// Ignore config parse errors and program diagnostics
    /// (`OXLINT_TSGOLINT_DANGEROUSLY_SUPPRESS_PROGRAM_DIAGNOSTICS`). File read
    /// errors of the config are never suppressed.
    pub suppress_program_diagnostics: bool,
}

/// Go `utils.CreateProgram`: parses the tsconfig at `tsconfig_path` (relative
/// to `cwd`) and creates and binds its program. `Err` is a fatal error
/// (`couldn't read tsconfig at <path>`).
pub fn create_program(
    fs: &FsFactory,
    cwd: &str,
    tsconfig_path: &str,
    settings: ProgramSettings,
) -> Result<CreatedProgram, String> {
    let host_fs = fs.make();
    let resolved_config_path = tspath::resolve_path(cwd, &[tsconfig_path]);
    if !host_fs.file_exists(&resolved_config_path) {
        return Err(format!("couldn't read tsconfig at {resolved_config_path}"));
    }
    let host = crate::host::new_host(cwd, fs);

    // The config parse makes node stores too. They are published with the
    // program, or on their own when there is no program, so the next load
    // of any thread starts clean.
    let load = load_lock();
    let no_program = enter_program(None);
    let loaded = load_configured(&host, cwd, tsconfig_path, &resolved_config_path, settings);
    if !matches!(loaded, ConfiguredLoad::Program(_)) {
        tsprogram::publish_parsed_files(cwd);
    }
    drop(no_program);
    drop(load);
    let program = match loaded {
        ConfiguredLoad::Program(program) => program,
        ConfiguredLoad::Invalid(diagnostics) => return Ok(CreatedProgram::Invalid(diagnostics)),
        ConfiguredLoad::Failed => return Err("couldn't create program".to_owned()),
    };

    let program = Program::new(program, fs.clone());
    let scope = program.enter();
    let program_diagnostics = tsprogram::get_program_diagnostics();
    if !program_diagnostics.is_empty() && !settings.suppress_program_diagnostics {
        let diagnostics = tsconfig_errors(&program_diagnostics, &resolved_config_path, true);
        drop(scope);
        return Ok(CreatedProgram::Invalid(diagnostics));
    }
    tsprogram::bind_all();
    drop(scope);
    Ok(CreatedProgram::Program(program))
}

/// What [`load_configured`] made of a tsconfig.
enum ConfiguredLoad {
    Program(&'static GoProgram),
    /// Config errors, reported instead of the program.
    Invalid(Vec<InternalDiagnostic>),
    /// The config parse gave neither a config nor an error.
    Failed,
}

/// Parses the tsconfig and builds its program, under the load lock.
fn load_configured(
    host: &Rc<dyn CompilerHost>,
    cwd: &str,
    tsconfig_path: &str,
    resolved_config_path: &str,
    settings: ProgramSettings,
) -> ConfiguredLoad {
    let config_host = ConfigHost {
        fs: host.fs(),
        cwd: cwd.to_owned(),
    };
    let (parsed, fatal) = parse_config(tsconfig_path, &config_host);
    if !fatal.is_empty() {
        return ConfiguredLoad::Invalid(tsconfig_errors(&fatal, resolved_config_path, false));
    }
    let Some(mut parsed) = parsed else {
        return ConfiguredLoad::Failed;
    };
    if !parsed.errors.is_empty() && !settings.suppress_program_diagnostics {
        return ConfiguredLoad::Invalid(tsconfig_errors(
            &parsed.errors,
            resolved_config_path,
            false,
        ));
    }

    let single_threaded = tristate(settings.single_threaded);
    // The checker pool reads the compiler option; Go reads
    // ProgramOptions, which overrides the tsconfig's value.
    let mut options = (**parsed.compiler_options()).clone();
    options.single_threaded = single_threaded;
    parsed.set_compiler_options(Rc::new(options));
    ConfiguredLoad::Program(build_program(host.clone(), parsed, true, single_threaded))
}

fn tsconfig_errors(
    diagnostics: &[Diagnostic],
    resolved_config_path: &str,
    enhance: bool,
) -> Vec<InternalDiagnostic> {
    diagnostics
        .iter()
        .map(|d| tsconfig_error(d, resolved_config_path, enhance))
        .collect()
}

/// Go `utils.CreateInferredProjectProgram`: the program of the files that no
/// tsconfig includes, with tsgolint's fixed options. Its program diagnostics
/// are never reported.
pub fn create_inferred_program(
    fs: &FsFactory,
    cwd: &str,
    file_names: Vec<String>,
    single_threaded: bool,
) -> Program {
    let options = CompilerOptions {
        allow_js: Tristate::True,
        module: ModuleKind::ES_NEXT,
        module_resolution: ModuleResolutionKind::BUNDLER,
        target: ScriptTarget::ES2022,
        jsx: JsxEmit::REACT_JSX,
        allow_importing_ts_extensions: Tristate::True,
        strict_null_checks: Tristate::True,
        strict_function_types: Tristate::True,
        source_map: Tristate::True,
        es_module_interop: Tristate::True,
        allow_non_ts_extensions: Tristate::True,
        resolve_json_module: Tristate::True,
        single_threaded: tristate(single_threaded),
        ..Default::default()
    };
    let parsed = new_parsed_command_line(
        Rc::new(options),
        file_names,
        None,
        ComparePathsOptions::default(),
    );
    let host = crate::host::new_host(cwd, fs);
    let program = {
        let _load = load_lock();
        let _no_program = enter_program(None);
        build_program(host, parsed, false, tristate(single_threaded))
    };
    let program = Program::new(program, fs.clone());
    {
        let _scope = program.enter();
        tsprogram::bind_all();
    }
    program
}

fn tristate(value: bool) -> Tristate {
    if value {
        Tristate::True
    } else {
        Tristate::False
    }
}

fn build_program(
    host: Rc<dyn CompilerHost>,
    config: ParsedCommandLine,
    use_source_of_project_reference: bool,
    single_threaded: Tristate,
) -> &'static GoProgram {
    let np = Rc::new(new_program(ProgramOptions {
        host,
        config: Rc::new(config),
        use_source_of_project_reference,
        single_threaded,
        typings_location: String::new(),
        project_name: String::new(),
        create_module_resolver: None,
        skip_module_resolution: false,
    }));
    tsprogram::new_program_version(&np, None)
}

/// A `tsconfig-error` for a config or program diagnostic. `enhance` adds
/// tsgolint's note to "Please remove it" messages (program diagnostics
/// only).
fn tsconfig_error(d: &Diagnostic, resolved_config_path: &str, enhance: bool) -> InternalDiagnostic {
    let mut help = d.localize(&locale::DEFAULT);
    if enhance && help.contains("Please remove it from your configuration.") {
        help.push_str(
            "\nSee https://github.com/oxc-project/tsgolint/issues/351 for more information.",
        );
    }
    let file_name = if d.file.is_some() {
        goport_core::ast::source_file_file_name(d.file)
    } else {
        ""
    };
    InternalDiagnostic {
        range: diagnostic_range(d.pos, d.end),
        id: "tsconfig-error".to_owned(),
        description: "Invalid tsconfig".to_owned(),
        help,
        file_path: if file_name.is_empty() {
            resolved_config_path.to_owned()
        } else {
            file_name.to_owned()
        },
    }
}

/// Go `tsoptions.GetParsedCommandLineOfConfigFile` with tsgolint's patch
/// 0003: a tsconfig with JSON syntax errors gives only its first parse error
/// and is read as an empty object. ts-rust also reports the Effect plugin's
/// config warnings, which tsgolint's TypeScript does not know; they are
/// dropped.
fn parse_config(
    tsconfig_path: &str,
    host: &ConfigHost,
) -> (Option<ParsedCommandLine>, Vec<Diagnostic>) {
    let (parsed, fatal) = get_parsed_command_line_of_config_file(
        tsconfig_path,
        Some(&CompilerOptions::default()),
        None,
        host,
        None,
    );
    let Some(mut parsed) = parsed else {
        return (None, fatal);
    };
    let first_parse_error = parsed.config_file.as_ref().and_then(|config| {
        parsed_source_file_diagnostics(config.source_file)
            .first()
            .cloned()
    });
    if let Some(first) = first_parse_error {
        let config_file_name = tspath::get_normalized_absolute_path(tsconfig_path, &host.cwd);
        let empty = ConfigHost {
            fs: Rc::new(ReplaceFileFs {
                fs: host.fs.clone(),
                path: config_file_name,
                text: "{}",
            }),
            cwd: host.cwd.clone(),
        };
        let (reparsed, _) = get_parsed_command_line_of_config_file(
            tsconfig_path,
            Some(&CompilerOptions::default()),
            None,
            &empty,
            None,
        );
        if let Some(reparsed) = reparsed {
            parsed = reparsed;
        }
        parsed.errors.insert(0, first);
    }
    parsed.errors.retain(|d| !is_effect_code(d.code));
    (Some(parsed), fatal)
}

/// The config parse host (Go passes the compiler host).
struct ConfigHost {
    fs: Rc<dyn Fs>,
    cwd: String,
}

impl ParseConfigHost for ConfigHost {
    fn fs(&self) -> Rc<dyn Fs> {
        self.fs.clone()
    }
    fn get_current_directory(&self) -> String {
        self.cwd.clone()
    }
}

/// `fs` where the file `path` reads as `text`.
struct ReplaceFileFs {
    fs: Rc<dyn Fs>,
    path: String,
    text: &'static str,
}

impl Fs for ReplaceFileFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        path == self.path || self.fs.file_exists(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if path == self.path {
            return (self.text.to_owned(), true);
        }
        self.fs.read_file(path)
    }
    fn write_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.fs.write_file(path, data)
    }
    fn append_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        self.fs.append_file(path, data)
    }
    fn remove(&self, path: &str) -> Result<(), FsError> {
        self.fs.remove(path)
    }
    fn chtimes(
        &self,
        path: &str,
        a: Option<SystemTime>,
        m: Option<SystemTime>,
    ) -> Result<(), FsError> {
        self.fs.chtimes(path, a, m)
    }
    fn directory_exists(&self, path: &str) -> bool {
        self.fs.directory_exists(path)
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        self.fs.get_accessible_entries(path)
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        self.fs.stat(path)
    }
    fn realpath(&self, path: &str) -> String {
        self.fs.realpath(path)
    }
}

/// Runs a parse that is not a program load, such as reading a tsconfig for
/// discovery, under the load lock, and publishes the node stores it made, so
/// the next load of any thread starts clean.
pub fn parse_outside_program<T>(cwd: &str, parse: impl FnOnce() -> T) -> T {
    let _load = load_lock();
    let _no_program = enter_program(None);
    let result = parse();
    tsprogram::publish_parsed_files(cwd);
    result
}

/// Serializes program loads and other parses in the process. ts-rust gives
/// the node stores of one load consecutive file ids, so two threads must not
/// parse at the same time; loaded programs can be checked and linted in
/// parallel.
fn load_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOAD.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
