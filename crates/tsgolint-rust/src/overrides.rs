//! `source_overrides` (Go `cmd/tsgolint/overlayfs.go`). The overlay is
//! tsgolint-core's canonical `OverlayFs`: only `file_exists` and `read_file`
//! see the overrides, and override text is returned as it is (no BOM
//! stripping or UTF-16 decoding, unlike disk reads).

use std::sync::Arc;

use goport_util::scanner_util::go_string_from_utf8;
use rustc_hash::FxHashMap;
use tsgolint_core::{FsFactory, OverlayFs};

/// The file system of a headless run: the payload's `source_overrides`
/// (paths and valid UTF-8 texts) over the OS file system. Two paths with
/// one canonical form keep the later text.
pub fn headless_fs(overrides: &[(String, String)], case_sensitive: bool) -> FsFactory {
    let by_path: FxHashMap<String, String> = overrides
        .iter()
        .map(|(path, text)| {
            (
                OverlayFs::canonical_key(path, case_sensitive),
                go_string_from_utf8(text.clone()),
            )
        })
        .collect();
    FsFactory::source_overrides(Arc::new(by_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_only_exists_and_read() {
        let dir = std::env::temp_dir().join(format!("tsgolint-overlay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.to_str().unwrap().replace('\\', "/");
        let on_disk = format!("{dir}/disk.ts");
        std::fs::write(&on_disk, "\u{feff}disk text").unwrap();
        std::fs::write(format!("{dir}/other.ts"), "\u{feff}other").unwrap();

        let virtual_file = format!("{dir}/virtual.ts");
        let fs = headless_fs(
            &[
                (format!("{dir}/sub/../disk.ts"), "\u{feff}override".into()),
                (virtual_file.clone(), "v".into()),
            ],
            true,
        )
        .make();

        // Keys are normalized; the BOM of override text stays.
        assert_eq!(
            fs.read_file(&on_disk),
            ("\u{feff}override".to_string(), true)
        );
        assert!(fs.file_exists(&virtual_file));
        assert_eq!(
            fs.read_file(&format!("{dir}/./virtual.ts")),
            ("v".to_string(), true)
        );
        // Listings do not see overrides.
        let entries = fs.get_accessible_entries(&dir);
        assert!(entries.files.iter().any(|f| f == "disk.ts"));
        assert!(!entries.files.iter().any(|f| f == "virtual.ts"));
        assert!(fs.stat(&virtual_file).is_none());
        // Other files fall through to the disk, where the BOM is stripped.
        assert_eq!(
            fs.read_file(&format!("{dir}/other.ts")),
            ("other".to_string(), true)
        );
        assert!(!fs.file_exists(&format!("{dir}/missing.ts")));
        // Case matters on a case-sensitive file system.
        assert!(!fs.file_exists(&format!("{dir}/VIRTUAL.ts")));

        // Other threads see the same overrides.
        let factory = headless_fs(&[(virtual_file.clone(), "v".into())], true);
        let read = std::thread::spawn(move || factory.make().read_file(&virtual_file))
            .join()
            .unwrap();
        assert_eq!(read, ("v".to_string(), true));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn case_insensitive_keys() {
        let key = |path: &str, case_sensitive| OverlayFs::canonical_key(path, case_sensitive);
        assert_eq!(key("/P/Original.ts", false), key("/p/original.TS", false));
        assert_ne!(key("/P/Original.ts", true), key("/p/original.ts", true));
    }
}
