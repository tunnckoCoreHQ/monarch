//! typescript-eslint's `TypeOrValueSpecifier` (tsgolint
//! `type_matches_specifier.go`): the option shape that names types or
//! values by name and source (`file`, `lib`, `package`), and the matching.
//!
//! The matchers read the current program of the thread
//! (`goport_core::program`), which is the program of the checker on checker
//! threads, and `package.json` files through the program host's file system
//! (`RuleContext::fs`, overlays included).

use std::fmt;

use goport_core::ast::{self, get_source_file_of_node, source_file_file_name};
use goport_core::astdata::SyntaxKind;
use goport_core::checker::Checker;
use goport_core::core::{Node, SymbolId, TypeId};
use goport_core::frontend::tspath::{
    combine_paths, get_directory_path, get_normalized_absolute_path, normalize_slashes,
};
use goport_core::frontend::vfs::Fs;
use goport_core::program;
use rustc_hash::FxHashSet;
use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::builtin_symbols::is_source_file_default_library;
use super::types::{intersection_type_parts, is_intrinsic_error_type, is_intrinsic_type};

/// Where a [`TypeOrValueSpecifier`] says the type or value comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TypeOrValueSpecifierFrom {
    /// `{"from": "file"}` (also a missing or empty `from`): declared in a
    /// file of the project, or in `path` when it is set.
    #[default]
    File,
    /// `{"from": "lib"}`: declared in a default library file.
    Lib,
    /// `{"from": "package"}`: declared in the npm package `package`.
    Package,
    /// A plain string: any declaration with this name.
    Name,
}

/// typescript-eslint `TypeOrValueSpecifier`.
///
/// JSON forms: a string (`From::Name` with that one name), or an object
/// `{"from": "file" | "lib" | "package", "name": string | string[], "path"?:
/// string, "package"?: string}`. As in tsgolint, a missing `from` means
/// `file`, a missing `name` means no names, unknown members are ignored,
/// and `null` decodes as the name `""`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TypeOrValueSpecifier {
    pub from: TypeOrValueSpecifierFrom,
    pub name: Vec<String>,
    /// Used with `From::File`.
    pub path: String,
    /// Used with `From::Package`.
    pub package: String,
}

impl TypeOrValueSpecifier {
    /// A name-only specifier (the JSON string form).
    pub fn from_name(name: impl Into<String>) -> Self {
        TypeOrValueSpecifier {
            from: TypeOrValueSpecifierFrom::Name,
            name: vec![name.into()],
            ..Default::default()
        }
    }
}

impl<'de> Deserialize<'de> for TypeOrValueSpecifier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(SpecifierVisitor)
    }
}

const OBJECT_ERROR: &str = "TypeOrValueSpecifier must be a string or object with 'from' field";

struct SpecifierVisitor;

impl<'de> Visitor<'de> for SpecifierVisitor {
    type Value = TypeOrValueSpecifier;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a string or an object with a 'from' field")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(TypeOrValueSpecifier::from_name(value))
    }

    // tsgolint decodes `null` with its string branch, which gives "".
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(TypeOrValueSpecifier::from_name(""))
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        self.visit_unit()
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(self)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut seen = FxHashSet::default();
        let (mut from, mut name, mut path, mut package) = (None, None, None, None);
        while let Some(key) = map.next_key::<String>()? {
            let value: Value = map.next_value()?;
            // Go's JSON decoder rejects duplicate member names.
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom(format!(
                    "{OBJECT_ERROR}: duplicate object member name {key:?}"
                )));
            }
            match key.as_str() {
                "from" => from = Some(value),
                "name" => name = Some(value),
                "path" => path = Some(value),
                "package" => package = Some(value),
                _ => {}
            }
        }

        // Go decodes the members first, so their type errors come first.
        let from = optional_string(from, "from")?;
        let path = optional_string(path, "path")?.unwrap_or_default();
        let package = optional_string(package, "package")?.unwrap_or_default();
        let from = match from.as_deref() {
            None | Some("" | "file") => TypeOrValueSpecifierFrom::File,
            Some("lib") => TypeOrValueSpecifierFrom::Lib,
            Some("package") => TypeOrValueSpecifierFrom::Package,
            Some(other) => {
                return Err(de::Error::custom(format!(
                    "invalid 'from' field: {other} (must be 'file', 'lib', or 'package')"
                )));
            }
        };
        let name = match name {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::String(name)) => vec![name],
            Some(Value::Array(names)) => names
                .into_iter()
                .map(|name| match name {
                    Value::String(name) => Ok(name),
                    _ => Err(de::Error::custom("name array must contain only strings")),
                })
                .collect::<Result<_, _>>()?,
            Some(_) => {
                return Err(de::Error::custom(
                    "name must be a string or array of strings",
                ));
            }
        };
        Ok(TypeOrValueSpecifier {
            from,
            name,
            path,
            package,
        })
    }
}

/// A string member that may be missing or `null`.
fn optional_string<E: de::Error>(value: Option<Value>, member: &str) -> Result<Option<String>, E> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(other) => Err(E::custom(format!(
            "{OBJECT_ERROR}: member {member:?}: cannot unmarshal {} into string",
            json_kind(&other)
        ))),
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

impl Serialize for TypeOrValueSpecifier {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let from = match self.from {
            TypeOrValueSpecifierFrom::File => "file",
            TypeOrValueSpecifierFrom::Lib => "lib",
            TypeOrValueSpecifierFrom::Package => "package",
            TypeOrValueSpecifierFrom::Name => {
                return match self.name.as_slice() {
                    [name] => serializer.serialize_str(name),
                    _ => Err(serde::ser::Error::custom(
                        "name-only specifier must contain exactly one name",
                    )),
                };
            }
        };
        let len = 2 + usize::from(!self.package.is_empty()) + usize::from(!self.path.is_empty());
        let mut map = serializer.serialize_map(Some(len))?;
        map.serialize_entry("from", from)?;
        map.serialize_entry("name", &self.name)?;
        if !self.package.is_empty() {
            map.serialize_entry("package", &self.package)?;
        }
        if !self.path.is_empty() {
            map.serialize_entry("path", &self.path)?;
        }
        map.end()
    }
}

/// The type's alias name (else its symbol name) or intrinsic name is one of
/// `names`.
fn type_matches_string_specifier(c: &Checker, t: TypeId, names: &[String]) -> bool {
    let ty = c.ty(t);
    let symbol = match &ty.alias {
        Some(alias) => alias.symbol,
        None => ty.symbol,
    };
    let contains = |name: &str| names.iter().any(|n| n == name);
    if symbol.is_some() && contains(c.sym(symbol).name.as_str()) {
        return true;
    }
    is_intrinsic_type(c, t) && contains(c.ty(t).as_intrinsic_type().intrinsic_name())
}

/// `relative_path` empty: some file is under the program's current
/// directory; else some file is that path resolved against it.
fn type_declared_in_file(relative_path: &str, declaration_files: &[Node]) -> bool {
    let cwd = program::get_current_directory();
    if relative_path.is_empty() {
        return declaration_files
            .iter()
            .any(|&f| source_file_file_name(f).starts_with(cwd));
    }
    let absolute_path = get_normalized_absolute_path(relative_path, cwd);
    declaration_files
        .iter()
        .any(|&f| source_file_file_name(f) == absolute_path)
}

fn type_declared_in_lib(declaration_files: &[Node]) -> bool {
    // No declarations: an intrinsic such as `string`, which counts as lib.
    declaration_files.is_empty()
        || declaration_files
            .iter()
            .any(|&f| is_source_file_default_library(f))
}

/// The nearest `declare module "name"` around `node`, skipping namespaces.
fn find_parent_module_declaration(mut node: Node) -> Node {
    loop {
        match node.kind() {
            SyntaxKind::ModuleDeclaration if node.keyword() != SyntaxKind::NamespaceKeyword => {
                return if ast::is_string_literal(node.name()) {
                    node
                } else {
                    Node::NIL
                };
            }
            SyntaxKind::SourceFile => return Node::NIL,
            _ => {}
        }
        node = node.parent();
    }
}

fn type_declared_in_declare_module(package_name: &str, declarations: &[Node]) -> bool {
    declarations.iter().any(|&declaration| {
        let module = find_parent_module_declaration(declaration);
        module.is_some() && module.name().text() == package_name
    })
}

/// The package name of a file under `node_modules`: the `name` of the
/// nearest `package.json` inside `node_modules`, else the path segment
/// after the last `node_modules`.
fn source_file_package_name(fs: &dyn Fs, source_file: Node) -> Option<String> {
    let file_name = normalize_slashes(source_file_file_name(source_file));
    if !contains_node_modules_segment(&file_name) {
        return None;
    }
    package_name_from_nearest_package_json(fs, &file_name)
        .or_else(|| package_name_from_node_modules_path(&file_name))
}

fn package_name_from_nearest_package_json(fs: &dyn Fs, file_name: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct PackageJson {
        name: Option<String>,
    }

    let mut current_dir = get_directory_path(file_name);
    while !current_dir.is_empty() && contains_node_modules_segment(&current_dir) {
        let package_json_path = combine_paths(&current_dir, &["package.json"]);
        let (contents, ok) = fs.read_file(&package_json_path);
        if ok
            && let Ok(PackageJson { name: Some(name) }) = serde_json::from_str(&contents)
            && !name.is_empty()
        {
            return Some(name);
        }
        let parent_dir = get_directory_path(&current_dir);
        if parent_dir == current_dir {
            break;
        }
        current_dir = parent_dir;
    }
    None
}

/// The package segment(s) after the last usable `node_modules` segment
/// (`@scope/name` for scoped packages).
fn package_name_from_node_modules_path(file_name: &str) -> Option<String> {
    let normalized = normalize_slashes(file_name);
    let segments: Vec<&str> = normalized.split('/').collect();
    for i in (0..segments.len()).rev() {
        if segments[i] != "node_modules" {
            continue;
        }
        let Some(&name) = segments.get(i + 1) else {
            continue;
        };
        if matches!(name, "" | "." | "..") {
            continue;
        }
        if name.starts_with('@') {
            match segments.get(i + 2) {
                Some(&scoped) if !scoped.is_empty() => return Some(format!("{name}/{scoped}")),
                _ => continue,
            }
        }
        return Some(name.to_owned());
    }
    None
}

fn contains_node_modules_segment(path: &str) -> bool {
    format!("/{}/", normalize_slashes(path)).contains("/node_modules/")
}

/// Whole path components: the scope `@angular` covers `@angular/core` but
/// not `@angularlol`.
fn path_is_in_package(package_path: &str, package_name: &str) -> bool {
    package_path
        .strip_prefix(package_name)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn type_declared_in_declaration_file(
    fs: &dyn Fs,
    package_name: &str,
    declaration_files: &[Node],
) -> bool {
    if package_name.is_empty() {
        return false;
    }
    let types_package_name = get_types_package_name(package_name);
    declaration_files.iter().any(|&declaration| {
        if declaration.is_nil() {
            return false;
        }
        let Some(package_id_name) = source_file_package_name(fs, declaration) else {
            return false;
        };
        if package_id_name.is_empty() {
            return false;
        }
        let without_types = package_id_name
            .strip_prefix("@types/")
            .unwrap_or(&package_id_name);
        (path_is_in_package(&package_id_name, package_name)
            || path_is_in_package(without_types, types_package_name.as_ref()))
            && program::is_source_file_from_external_library(declaration)
    })
}

/// The `@types` name of a package: `@scope/name` becomes `scope__name`.
fn get_types_package_name(package_name: &str) -> std::borrow::Cow<'_, str> {
    let Some(scoped) = package_name.strip_prefix('@') else {
        return package_name.into();
    };
    match scoped.split_once('/') {
        Some((scope, name)) if !scope.is_empty() && !name.is_empty() => {
            format!("{scope}__{name}").into()
        }
        _ => package_name.into(),
    }
}

fn type_declared_in_package_declaration_file(
    fs: &dyn Fs,
    package_name: &str,
    declarations: &[Node],
    declaration_files: &[Node],
) -> bool {
    type_declared_in_declare_module(package_name, declarations)
        || type_declared_in_declaration_file(fs, package_name, declaration_files)
}

/// The declarations of `symbol` (none for a nil symbol) and their files.
fn declarations_and_files(c: &Checker, symbol: SymbolId) -> (Vec<Node>, Vec<Node>) {
    let declarations: Vec<Node> = if symbol.is_some() {
        c.sym(symbol).declarations.to_vec()
    } else {
        Vec::new()
    };
    let files = declarations
        .iter()
        .map(|&d| get_source_file_of_node(d))
        .collect();
    (declarations, files)
}

/// Whether declarations in `declaration_files` satisfy the source part of
/// `specifier`.
fn declarations_match_source(
    fs: &dyn Fs,
    specifier: &TypeOrValueSpecifier,
    declarations: &[Node],
    declaration_files: &[Node],
) -> bool {
    match specifier.from {
        TypeOrValueSpecifierFrom::Name => true,
        TypeOrValueSpecifierFrom::File => type_declared_in_file(&specifier.path, declaration_files),
        TypeOrValueSpecifierFrom::Lib => type_declared_in_lib(declaration_files),
        TypeOrValueSpecifierFrom::Package => type_declared_in_package_declaration_file(
            fs,
            &specifier.package,
            declarations,
            declaration_files,
        ),
    }
}

fn type_matches_specifier(
    c: &Checker,
    fs: &dyn Fs,
    t: TypeId,
    specifier: &TypeOrValueSpecifier,
) -> bool {
    if !type_matches_string_specifier(c, t, &specifier.name) {
        return false;
    }
    // The name check prefers the alias symbol; the source check prefers the
    // type's own symbol, as in tsgolint.
    let ty = c.ty(t);
    let symbol = if ty.symbol.is_some() {
        ty.symbol
    } else {
        ty.alias
            .as_ref()
            .map_or(SymbolId::NIL, |alias| alias.symbol)
    };
    let (declarations, files) = declarations_and_files(c, symbol);
    declarations_match_source(fs, specifier, &declarations, &files)
}

/// Whether `symbol` is named `name`, `name` is one of the specifier's names,
/// and the symbol's declarations satisfy the specifier's source.
///
/// For nodes that are not value references, such as a contextual object
/// literal property resolved to its property symbol.
pub fn symbol_matches_specifier_name_and_source(
    c: &Checker,
    fs: &dyn Fs,
    symbol: SymbolId,
    name: &str,
    specifier: &TypeOrValueSpecifier,
) -> bool {
    if symbol.is_nil() || !specifier.name.iter().any(|n| n == name) {
        return false;
    }
    let (declarations, files) = declarations_and_files(c, symbol);
    declarations_match_source(fs, specifier, &declarations, &files)
}

/// typescript-eslint `typeMatchesSomeSpecifier`: `t`, or a member of the
/// intersection `t`, matches a specifier. The `error` type never matches.
pub fn type_matches_some_specifier(
    c: &Checker,
    fs: &dyn Fs,
    t: TypeId,
    specifiers: &[TypeOrValueSpecifier],
) -> bool {
    let matches = |t: TypeId| {
        !is_intrinsic_error_type(c, t)
            && specifiers
                .iter()
                .any(|specifier| type_matches_specifier(c, fs, t, specifier))
    };
    if matches(t) {
        return true;
    }
    intersection_type_parts(c, t)
        .into_iter()
        .any(|part| part != t && matches(part))
}

/// The static name of an identifier, private identifier (without `#`) or
/// string literal; "" for other nodes.
fn get_static_name(node: Node) -> &'static str {
    match node.kind() {
        SyntaxKind::Identifier | SyntaxKind::StringLiteral => node.text(),
        SyntaxKind::PrivateIdentifier => {
            let text = node.text();
            text.strip_prefix('#').unwrap_or(text)
        }
        _ => "",
    }
}

fn value_matches_specifier(
    c: &Checker,
    fs: &dyn Fs,
    node: Node,
    specifier: &TypeOrValueSpecifier,
    t: TypeId,
) -> bool {
    let node_name = get_static_name(node);
    if node_name.is_empty() || !specifier.name.iter().any(|n| n == node_name) {
        return false;
    }
    if get_source_file_of_node(node).is_nil() {
        return false;
    }
    // Only `package` checks the source; `file` and `lib` match on the name.
    if specifier.from != TypeOrValueSpecifierFrom::Package {
        return true;
    }
    let symbol = if t.is_some() {
        c.ty(t).symbol
    } else {
        SymbolId::NIL
    };
    if symbol.is_nil() {
        return false;
    }
    let (declarations, files) = declarations_and_files(c, symbol);
    type_declared_in_package_declaration_file(fs, &specifier.package, &declarations, &files)
}

/// typescript-eslint `valueMatchesSomeSpecifier`: the static name of `node`
/// is in a specifier; for `package` specifiers the symbol of `t` must also
/// be declared in that package.
pub fn value_matches_some_specifier(
    c: &Checker,
    fs: &dyn Fs,
    node: Node,
    specifiers: &[TypeOrValueSpecifier],
    t: TypeId,
) -> bool {
    specifiers
        .iter()
        .any(|specifier| value_matches_specifier(c, fs, node, specifier, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(json: &str) -> Result<TypeOrValueSpecifier, serde_json::Error> {
        serde_json::from_str(json)
    }

    fn spec(from: TypeOrValueSpecifierFrom, name: &[&str]) -> TypeOrValueSpecifier {
        TypeOrValueSpecifier {
            from,
            name: name.iter().map(|s| (*s).to_owned()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn decodes_string_specifiers() {
        assert_eq!(
            decode(r#""Foo""#).unwrap(),
            TypeOrValueSpecifier::from_name("Foo")
        );
        assert_eq!(decode("null").unwrap(), TypeOrValueSpecifier::from_name(""));
    }

    #[test]
    fn decodes_object_specifiers() {
        use TypeOrValueSpecifierFrom::*;
        assert_eq!(
            decode(r#"{"from":"lib","name":"Promise"}"#).unwrap(),
            spec(Lib, &["Promise"])
        );
        assert_eq!(
            decode(r#"{"from":"file","name":["A","B"],"path":"src/a.ts"}"#).unwrap(),
            TypeOrValueSpecifier {
                path: "src/a.ts".into(),
                ..spec(File, &["A", "B"])
            }
        );
        assert_eq!(
            decode(r#"{"from":"package","name":"Foo","package":"foo","extra":1}"#).unwrap(),
            TypeOrValueSpecifier {
                package: "foo".into(),
                ..spec(Package, &["Foo"])
            }
        );
        // A missing, empty or null `from` is `file`; a missing name is empty.
        assert_eq!(decode(r#"{"name":"A"}"#).unwrap(), spec(File, &["A"]));
        assert_eq!(decode(r#"{"from":""}"#).unwrap(), spec(File, &[]));
        assert_eq!(
            decode(r#"{"from":null,"name":null,"path":null}"#).unwrap(),
            spec(File, &[])
        );
        assert_eq!(decode("{}").unwrap(), spec(File, &[]));
        // Names are case sensitive.
        assert_eq!(
            decode(r#"{"From":"lib","name":"A"}"#).unwrap(),
            spec(File, &["A"])
        );
    }

    #[test]
    fn rejects_bad_specifiers() {
        let err = |json: &str| decode(json).unwrap_err().to_string();
        assert!(
            err(r#"{"from":"global","name":"A"}"#)
                .contains("invalid 'from' field: global (must be 'file', 'lib', or 'package')")
        );
        assert!(
            err(r#"{"from":"lib","name":1}"#).contains("name must be a string or array of strings")
        );
        assert!(
            err(r#"{"from":"lib","name":{}}"#)
                .contains("name must be a string or array of strings")
        );
        assert!(
            err(r#"{"from":"lib","name":["A",1]}"#)
                .contains("name array must contain only strings")
        );
        assert!(
            err(r#"{"from":"lib","name":["A",null]}"#)
                .contains("name array must contain only strings")
        );
        assert!(err(r#"{"from":1}"#).contains(OBJECT_ERROR));
        assert!(err(r#"{"from":"file","path":true}"#).contains(OBJECT_ERROR));
        assert!(err(r#"{"from":"lib","from":"file"}"#).contains("duplicate"));
        assert!(decode("1").is_err());
        assert!(decode("true").is_err());
        assert!(decode(r#"["A"]"#).is_err());
    }

    #[test]
    fn decodes_specifier_lists() {
        let list: Vec<TypeOrValueSpecifier> =
            serde_json::from_str(r#"["A", {"from":"lib","name":["B"]}]"#).unwrap();
        assert_eq!(
            list,
            vec![
                TypeOrValueSpecifier::from_name("A"),
                spec(TypeOrValueSpecifierFrom::Lib, &["B"])
            ]
        );
    }

    #[test]
    fn encodes_specifiers() {
        use TypeOrValueSpecifierFrom::*;
        let json = |s: &TypeOrValueSpecifier| serde_json::to_string(s);
        assert_eq!(
            json(&TypeOrValueSpecifier::from_name("A")).unwrap(),
            r#""A""#
        );
        assert!(json(&spec(Name, &["A", "B"])).is_err());
        assert_eq!(
            json(&spec(Lib, &["A"])).unwrap(),
            r#"{"from":"lib","name":["A"]}"#
        );
        let package = TypeOrValueSpecifier {
            package: "foo".into(),
            path: "a.ts".into(),
            ..spec(Package, &[])
        };
        assert_eq!(
            json(&package).unwrap(),
            r#"{"from":"package","name":[],"package":"foo","path":"a.ts"}"#
        );
        for s in [
            spec(File, &["A"]),
            package,
            TypeOrValueSpecifier::from_name("x"),
        ] {
            assert_eq!(decode(&json(&s).unwrap()).unwrap(), s);
        }
    }

    #[test]
    fn package_names_from_paths() {
        let name = package_name_from_node_modules_path;
        assert_eq!(
            name("/a/node_modules/foo/index.d.ts").as_deref(),
            Some("foo")
        );
        assert_eq!(
            name("/a/node_modules/@scope/foo/index.d.ts").as_deref(),
            Some("@scope/foo")
        );
        assert_eq!(
            name("/a/node_modules/foo/node_modules/bar/index.d.ts").as_deref(),
            Some("bar")
        );
        assert_eq!(
            name("C:\\a\\node_modules\\foo\\x.d.ts").as_deref(),
            Some("foo")
        );
        // A trailing or scope-only segment falls back to an earlier one.
        assert_eq!(
            name("/a/node_modules/foo/node_modules").as_deref(),
            Some("foo")
        );
        assert_eq!(
            name("/a/node_modules/foo/node_modules/@scope").as_deref(),
            Some("foo")
        );
        assert_eq!(
            name("/a/node_modules/foo/node_modules/@scope/").as_deref(),
            Some("foo")
        );
        assert_eq!(name("/a/b/c.d.ts"), None);
        assert_eq!(name("/a/node_modules/"), None);

        assert!(contains_node_modules_segment("node_modules"));
        assert!(contains_node_modules_segment("/x/node_modules/y"));
        assert!(contains_node_modules_segment("x\\node_modules\\y"));
        assert!(!contains_node_modules_segment("/x/my_node_modules/y"));
    }

    #[test]
    fn package_matching_helpers() {
        assert!(path_is_in_package("@angular/core", "@angular"));
        assert!(path_is_in_package("@angular/core", "@angular/core"));
        assert!(!path_is_in_package("@angularlol/core", "@angular"));
        assert!(!path_is_in_package("foo", "foo/bar"));

        assert_eq!(get_types_package_name(""), "");
        assert_eq!(get_types_package_name("foo"), "foo");
        assert_eq!(get_types_package_name("@scope/foo"), "scope__foo");
        assert_eq!(get_types_package_name("@scope/foo/bar"), "scope__foo/bar");
        assert_eq!(get_types_package_name("@scope"), "@scope");
        assert_eq!(get_types_package_name("@/foo"), "@/foo");
        assert_eq!(get_types_package_name("@scope/"), "@scope/");
    }
}
