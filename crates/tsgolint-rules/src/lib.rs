//! The type-aware lint rules of tsgolint-rust.

pub mod rules;
pub mod utils;

pub use rules::{ALL_RULES, find_rule};
