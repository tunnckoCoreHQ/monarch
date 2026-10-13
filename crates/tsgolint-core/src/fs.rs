//! File systems on ts-rust's `Fs` trait.
//!
//! ts-rust file systems are `Rc<dyn Fs>`: one value per thread. A program
//! reads its files through its host on the loading thread, but rules run on
//! checker threads and sometimes read files too (a `package.json` for a
//! package specifier). So a file system is described by an `FsFactory`,
//! which is `Send + Sync` and makes the `Rc<dyn Fs>` of the calling thread.
//! Every value a factory makes shares the same data (an `Arc` of the virtual
//! files, the process read cache).

use std::cell::{OnceCell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use goport_core::frontend::bundled;
use goport_core::frontend::tspath;
use goport_core::frontend::vfs::{
    Entries, FileInfo, FileMode, Fs, FsError, cachedvfs_from, osvfs_fs,
};
use rustc_hash::FxHashMap;

/// Makes the file system of the calling thread.
#[derive(Clone)]
pub struct FsFactory {
    make: Arc<dyn Fn() -> Rc<dyn Fs> + Send + Sync>,
    /// `base()`: the OS file system with nothing in front of it.
    base: bool,
}

impl FsFactory {
    pub fn new(make: impl Fn() -> Rc<dyn Fs> + Send + Sync + 'static) -> Self {
        Self {
            make: Arc::new(make),
            base: false,
        }
    }

    /// The base file system: the OS file system with bundled libs and caches
    /// (Go `bundled.WrapFS(cachedvfs.From(osvfs.FS()))`, see `base_fs`).
    pub fn base() -> Self {
        Self {
            make: Arc::new(base_fs),
            base: true,
        }
    }

    /// The rule tester's overlay of `virtual_files` (absolute paths, exact
    /// keys) over `under` (`OverlayFs::exact`).
    pub fn exact_overlay(under: FsFactory, virtual_files: Arc<FxHashMap<String, String>>) -> Self {
        Self::new(move || {
            Rc::new(OverlayFs::exact(under.make(), virtual_files.clone())) as Rc<dyn Fs>
        })
    }

    /// The headless file system: `overrides` (keyed with
    /// `OverlayFs::canonical_key`) over the OS file system, with the read
    /// cache, lookup caches and bundled libs on top (Go
    /// `bundled.WrapFS(cachedvfs.From(overlayFS(osvfs.FS())))`). Without
    /// overrides it is `base()`. Each thread makes its value once, so the
    /// programs and checker jobs of a thread share the lookup caches.
    pub fn source_overrides(overrides: Arc<FxHashMap<String, String>>) -> Self {
        if overrides.is_empty() {
            return Self::base();
        }
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        Self::new(move || {
            PER_THREAD_FS.with(|made| {
                made.borrow_mut()
                    .entry(id)
                    .or_insert_with(|| {
                        bundled_and_cached(Rc::new(OverlayFs::canonical(
                            os_fs(),
                            overrides.clone(),
                        )))
                    })
                    .clone()
            })
        })
    }

    /// The file system of this thread.
    pub fn make(&self) -> Rc<dyn Fs> {
        (self.make)()
    }

    /// For `base()`: a file system for a compiler host on this thread, and
    /// the file system under its lookup caches, which is ts-rust's OS file
    /// system (`bundled::wrap_fs(osvfs_fs())`). ts-rust knows that one
    /// (`bundled::is_wrapped_os_fs`): the parse workers of a program load
    /// then read the files and resolve their imports in parallel, and the
    /// loader takes what they found. Behind the process read cache of
    /// `base_fs`, the loading thread reads and resolves every file itself,
    /// one after the other (h3: the parse workers were idle two thirds of
    /// the load). The host skips the read cache, which only saves reads
    /// (patch 0005): a worker reads each file of a load once.
    pub(crate) fn host_fs(&self) -> Option<(Rc<dyn Fs>, Rc<dyn Fs>)> {
        if !self.base {
            return None;
        }
        let os = bundled::wrap_fs(osvfs_fs());
        let cached = HOST_FS.with(|fs| fs.get_or_init(|| cachedvfs_from(os.clone())).clone());
        Some((cached, os))
    }
}

impl std::fmt::Debug for FsFactory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FsFactory")
    }
}

thread_local! {
    static BASE_FS: OnceCell<Rc<dyn Fs>> = const { OnceCell::new() };
    /// The lookup caches of the compiler hosts of `FsFactory::host_fs`.
    static HOST_FS: OnceCell<Rc<dyn Fs>> = const { OnceCell::new() };
    /// The file systems of `FsFactory::source_overrides` made on this
    /// thread, by factory id.
    static PER_THREAD_FS: RefCell<FxHashMap<u64, Rc<dyn Fs>>> = RefCell::default();
}

/// The base file system of this thread: the OS file system (or the
/// installed OS override) behind the process read cache, the lookup caches
/// and the bundled libs (`bundled:///libs/...`).
fn base_fs() -> Rc<dyn Fs> {
    BASE_FS.with(|fs| fs.get_or_init(|| bundled_and_cached(os_fs())).clone())
}

/// The OS file system of this thread behind the process read cache.
fn os_fs() -> Rc<dyn Fs> {
    Rc::new(ReadCacheFs { fs: osvfs_fs() })
}

/// `fs` with the lookup caches and the bundled libs (Go
/// `bundled.WrapFS(cachedvfs.From(fs))`).
fn bundled_and_cached(fs: Rc<dyn Fs>) -> Rc<dyn Fs> {
    bundled::wrap_fs(cachedvfs_from(fs))
}

type ReadCache = Mutex<FxHashMap<String, Option<CachedText>>>;

/// File contents read in this process, by path (tsgolint patch 0005: each
/// file is read once; later changes on disk are not seen).
fn read_cache() -> &'static ReadCache {
    static CACHE: OnceLock<ReadCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A text in the read cache: the cache's own copy, or the same text that a
/// parse of the file leaked (`share_parsed_text`), so it is kept once.
enum CachedText {
    Read(Box<str>),
    Parsed(&'static str),
}

impl std::ops::Deref for CachedText {
    type Target = str;

    fn deref(&self) -> &str {
        match self {
            CachedText::Read(text) => text,
            CachedText::Parsed(text) => text,
        }
    }
}

/// Makes the read cache keep `text`, the leaked text of a parse of `path`,
/// in place of its own copy when the two are equal.
pub(crate) fn share_parsed_text(path: &str, text: &'static str) {
    if let Some(Some(cached)) = read_cache().lock().unwrap().get_mut(path)
        && **cached == *text
    {
        *cached = CachedText::Parsed(text);
    }
}

/// Caches `read_file` of the wrapped file system for the whole process.
struct ReadCacheFs {
    fs: Rc<dyn Fs>,
}

impl Fs for ReadCacheFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.fs.use_case_sensitive_file_names()
    }
    fn file_exists(&self, path: &str) -> bool {
        self.fs.file_exists(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        if let Some(cached) = read_cache().lock().unwrap().get(path) {
            return cached
                .as_deref()
                .map_or((String::new(), false), |text| (text.to_owned(), true));
        }
        let (text, ok) = self.fs.read_file(path);
        let entry = ok.then(|| CachedText::Read(text.as_str().into()));
        read_cache().lock().unwrap().insert(path.to_owned(), entry);
        (text, ok)
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

/// How an overlay matches paths to its files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayKeys {
    /// Exact strings. The files also show in directory checks and listings
    /// (Go `utils.OverlayVFS`, used by the rule tester).
    Exact,
    /// Normalized and canonical (lower case on a case-insensitive file
    /// system) paths, for `file_exists` and `read_file` only (Go headless
    /// `overlayFS` for `source_overrides`).
    Canonical,
}

/// Files in memory over another file system.
pub struct OverlayFs {
    under: Rc<dyn Fs>,
    files: Arc<FxHashMap<String, String>>,
    keys: OverlayKeys,
}

impl OverlayFs {
    pub fn exact(under: Rc<dyn Fs>, files: Arc<FxHashMap<String, String>>) -> Self {
        Self {
            under,
            files,
            keys: OverlayKeys::Exact,
        }
    }

    /// `files` must already be keyed with `canonical_key`.
    pub fn canonical(under: Rc<dyn Fs>, files: Arc<FxHashMap<String, String>>) -> Self {
        Self {
            under,
            files,
            keys: OverlayKeys::Canonical,
        }
    }

    /// The key of `path` in a canonical overlay (Go
    /// `GetCanonicalFileName(NormalizePath(path), caseSensitive)`).
    pub fn canonical_key(path: &str, use_case_sensitive_file_names: bool) -> String {
        tspath::get_canonical_file_name(
            &tspath::normalize_path(path),
            use_case_sensitive_file_names,
        )
    }

    fn get(&self, path: &str) -> Option<&String> {
        match self.keys {
            OverlayKeys::Exact => self.files.get(path),
            OverlayKeys::Canonical => self.files.get(&Self::canonical_key(
                path,
                self.under.use_case_sensitive_file_names(),
            )),
        }
    }

    fn lists_files(&self) -> bool {
        self.keys == OverlayKeys::Exact
    }
}

/// `path`, normalized, with a trailing slash.
fn directory_prefix(path: &str) -> String {
    let mut prefix = tspath::normalize_path(path);
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    prefix
}

impl Fs for OverlayFs {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.under.use_case_sensitive_file_names()
    }

    fn file_exists(&self, path: &str) -> bool {
        self.get(path).is_some() || self.under.file_exists(path)
    }

    fn read_file(&self, path: &str) -> (String, bool) {
        match self.get(path) {
            Some(text) => (text.clone(), true),
            None => self.under.read_file(path),
        }
    }

    fn write_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        assert!(
            !self.lists_files() || self.get(path).is_none(),
            "not implemented: cannot write to overlay file system"
        );
        self.under.write_file(path, data)
    }

    fn append_file(&self, path: &str, data: &str) -> Result<(), FsError> {
        assert!(
            !self.lists_files() || self.get(path).is_none(),
            "not implemented: cannot append to overlay file system"
        );
        self.under.append_file(path, data)
    }

    fn remove(&self, path: &str) -> Result<(), FsError> {
        assert!(
            !self.lists_files() || self.get(path).is_none(),
            "not implemented: cannot remove from overlay file system"
        );
        self.under.remove(path)
    }

    fn chtimes(
        &self,
        path: &str,
        a: Option<SystemTime>,
        m: Option<SystemTime>,
    ) -> Result<(), FsError> {
        assert!(
            !self.lists_files() || self.get(path).is_none(),
            "not implemented: cannot change times on overlay file system"
        );
        self.under.chtimes(path, a, m)
    }

    fn directory_exists(&self, path: &str) -> bool {
        if self.lists_files() {
            let prefix = directory_prefix(path);
            if self.files.keys().any(|file| file.starts_with(&prefix)) {
                return true;
            }
        }
        self.under.directory_exists(path)
    }

    fn get_accessible_entries(&self, path: &str) -> Entries {
        let mut entries = self.under.get_accessible_entries(path);
        if !self.lists_files() {
            return entries;
        }
        let prefix = directory_prefix(path);
        // tsgolint appends without removing duplicates of files on disk.
        for file in self.files.keys() {
            let Some(rest) = file.strip_prefix(&prefix) else {
                continue;
            };
            match rest.split_once('/') {
                Some((directory, _)) => entries.directories.push(directory.to_owned()),
                None => entries.files.push(rest.to_owned()),
            }
        }
        entries
    }

    fn stat(&self, path: &str) -> Option<FileInfo> {
        if self.lists_files()
            && let Some(text) = self.get(path)
        {
            return Some(FileInfo {
                name: path.to_owned(),
                size: text.len() as i64,
                mode: FileMode(0),
                mod_time: None,
            });
        }
        self.under.stat(path)
    }

    fn realpath(&self, path: &str) -> String {
        if self.lists_files() && self.get(path).is_some() {
            return path.to_owned();
        }
        self.under.realpath(path)
    }
}
