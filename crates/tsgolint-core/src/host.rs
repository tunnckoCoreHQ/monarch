//! The compiler host (Go `utils/host.go`): ts-rust's compiler host plus
//! tsgolint's cache of parsed source files. Programs of one thread share a
//! parse when the file name, path, parse options and text are the same, so
//! the libs and shared files are parsed (and leaked) once, as Go shares the
//! `*ast.SourceFile`.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use goport_core::contentmapper::{Mapper, Project, SourceFiles};
use goport_core::diagnostics::Message;
use goport_core::frontend::bundled;
use goport_core::frontend::compiler::{
    CompilerHost, FileRefs, new_compiler_host, new_compiler_host_over,
};
use goport_core::frontend::parser::{ParsedSourceFile, SourceFileParseOptions};
use goport_core::frontend::tsoptions::ParsedCommandLine;
use goport_core::frontend::tspath::Path;
use goport_core::frontend::vfs::Fs;
use goport_core::gostd::GoError;
use rustc_hash::FxHashMap;

use crate::fs::FsFactory;

#[derive(PartialEq, Eq, Hash)]
struct ParseKey {
    file_name: String,
    path: String,
    jsx: bool,
    force: bool,
}

impl ParseKey {
    fn new(opts: &SourceFileParseOptions) -> Self {
        Self {
            file_name: opts.file_name.clone(),
            path: opts.path.0.clone(),
            jsx: opts.external_module_indicator_options.jsx,
            force: opts.external_module_indicator_options.force,
        }
    }
}

thread_local! {
    /// The parses of this thread, by key; one entry per text.
    static PARSE_CACHE: RefCell<FxHashMap<ParseKey, Vec<Rc<ParsedSourceFile>>>> =
        RefCell::default();
}

/// A compiler host over `fs` with the current directory `cwd`.
pub(crate) fn new_host(cwd: &str, fs: &FsFactory) -> Rc<dyn CompilerHost> {
    let (inner, os_texts) = match fs.host_fs() {
        Some((fs, os)) => (
            new_compiler_host_over(cwd, fs, &os, &bundled::lib_path()),
            true,
        ),
        None => (
            new_compiler_host(cwd, fs.make(), &bundled::lib_path(), None, None, None),
            false,
        ),
    };
    Rc::new(CachingHost { inner, os_texts })
}

struct CachingHost {
    inner: Rc<dyn CompilerHost>,
    /// The host reads the OS file system (`FsFactory::host_fs`).
    os_texts: bool,
}

impl CompilerHost for CachingHost {
    fn fs(&self) -> Rc<dyn Fs> {
        self.inner.fs()
    }

    fn default_library_path(&self) -> String {
        self.inner.default_library_path()
    }

    fn get_current_directory(&self) -> String {
        self.inner.get_current_directory()
    }

    fn trace(&self, msg: &'static Message, args: Vec<String>) {
        self.inner.trace(msg, args);
    }

    // A file that the cache does not have is not read here: the inner host
    // reads it (or takes a parse worker's read). On the OS file system the
    // text of a path does not change in a run (each file is read once, Go
    // patch 0005), so a cached parse with the same options is the file's;
    // other file systems (the rule tester's overlays) can give a path other
    // texts, so their cached parses are compared with the file's text.
    fn get_source_file(&self, opts: &SourceFileParseOptions) -> Option<Rc<ParsedSourceFile>> {
        let key = ParseKey::new(opts);
        if PARSE_CACHE.with(|cache| cache.borrow().contains_key(&key)) {
            let text = if self.os_texts {
                None
            } else {
                let (text, ok) = self.inner.fs().read_file(&opts.file_name);
                if !ok {
                    return None;
                }
                Some(text)
            };
            let cached = PARSE_CACHE.with(|cache| {
                cache.borrow().get(&key).and_then(|parses| {
                    parses
                        .iter()
                        .find(|parse| {
                            text.as_ref().is_none_or(|text| *parse.text == **text)
                                && parse.parse_options == *opts
                        })
                        .cloned()
                })
            });
            if cached.is_some() {
                return cached;
            }
        }
        let parse = self.inner.get_source_file(opts)?;
        if let Some(parsed) = parse.text.as_static() {
            crate::fs::share_parsed_text(&opts.file_name, parsed);
        }
        PARSE_CACHE.with(|cache| {
            cache
                .borrow_mut()
                .entry(key)
                .or_default()
                .push(parse.clone())
        });
        Some(parse)
    }

    fn get_content_mapped_source_files(
        &self,
        parse_options: &SourceFileParseOptions,
        mapper: &Rc<Mapper>,
    ) -> Result<SourceFiles, GoError> {
        self.inner
            .get_content_mapped_source_files(parse_options, mapper)
    }

    fn content_mapper_project(&self) -> Option<Rc<dyn Project>> {
        self.inner.content_mapper_project()
    }

    fn get_resolved_project_reference(
        &self,
        file_name: &str,
        path: &Path,
    ) -> Option<Rc<ParsedCommandLine>> {
        self.inner.get_resolved_project_reference(file_name, path)
    }

    fn is_plain_os_fs(&self) -> bool {
        self.inner.is_plain_os_fs()
    }

    fn prefetch_parses(&self) -> bool {
        self.inner.prefetch_parses()
    }

    // The parse workers of a load skip the files of this cache. Without
    // this, every load after the first parses them again for nothing, and
    // the unused parses stay in the workers' AST arenas. A wrong guess only
    // costs time: the loader checks each parse.
    fn cached_source_file_refs(&self) -> FxHashMap<String, Arc<FileRefs>> {
        PARSE_CACHE.with(|cache| {
            cache
                .borrow()
                .iter()
                .filter_map(|(key, parses)| {
                    let parse = parses.last()?;
                    Some((
                        key.file_name.clone(),
                        Arc::new(FileRefs::of_kept_parse(parse)),
                    ))
                })
                .collect()
        })
    }
}
