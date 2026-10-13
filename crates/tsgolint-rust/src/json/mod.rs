//! The payload JSON of the headless protocol, read with the rules of
//! go-json-experiment/json (JSON v2), the library that tsgolint uses.
//! serde_json does not read the payload: it keeps the last of two members
//! with the same name where JSON v2 rejects them, stops at a nesting depth
//! of 128 where JSON v2 allows 10000, and words its errors differently.
//!
//! [`parse`] reads the stdin payload into a [`Value`] tree. It rejects what
//! JSON v2 rejects: duplicate object member names at any depth, invalid
//! UTF-8, control characters in strings, lone surrogate escapes, trailing
//! data and nesting deeper than 10000. The output JSON is in `protocol`.

mod parse;

pub use parse::{Value, parse};
