//! Helpers that tsgolint's rules share (`internal/utils`), ported from Go.
//!
//! Helpers take `&mut Checker` (or `&Checker` when they only read the
//! arenas) and ts-rust handles. A nil handle (`TypeId::NIL`, `Node::NIL`,
//! ...) stands for Go's nil, and each helper treats it as tsgolint does.
//! Helpers that need the program (default-lib checks, specifier sources)
//! read the current program of the thread through `goport_core::program`.
//!
//! Not ported: program, host, VFS and tsconfig loading (tsgolint-core owns
//! them), Go's generic slice helpers (use iterators), `UnmarshalOptions` and
//! `BoolOr` (options decoding is in tsgolint-core), and helpers that no rule
//! calls (`IsLiteralValue`, `Is{Boolean,True,False}LiteralType`,
//! `ConvertTypeOrValueSpecifier`, `BreadthFirstSearch`). tsgolint rules read
//! literal types inline; here they share `literal_type_value` and
//! `boolean_literal_value`.

pub mod builtin_symbols;
pub mod eslint;
pub mod nodes;
pub mod parentheses;
pub mod ranges;
pub mod regexp;
pub mod specifier;
pub mod strings;
pub mod types;

pub use builtin_symbols::*;
pub use eslint::*;
pub use nodes::*;
pub use parentheses::*;
pub use ranges::*;
pub use regexp::*;
pub use specifier::*;
pub use strings::*;
pub use types::*;
