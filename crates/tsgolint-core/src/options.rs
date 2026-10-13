//! Rule options decoding (Go `utils.UnmarshalOptions` and the generated
//! `UnmarshalJSON` of each rule's options type).
//!
//! An options type is a serde struct with `#[serde(default)]` on the
//! container and a `Default` impl that holds the defaults of the rule's
//! `schema.json`. Field names follow the JSON names
//! (`#[serde(rename_all = "camelCase")]`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Decodes the options of rule `rule_name`. `null` options and `null` or
/// missing properties take their defaults, unknown properties are ignored,
/// and keys are case-sensitive. A non-object value or a property of the
/// wrong type panics with `<rule_name>: failed to unmarshal options: ...`,
/// as tsgolint does.
pub fn decode_options<T: DeserializeOwned>(options: &Value, rule_name: &str) -> T {
    let value = match options {
        Value::Null => Value::Object(serde_json::Map::new()),
        Value::Object(_) => without_nulls(options),
        other => {
            panic!("{rule_name}: failed to unmarshal options: expected an object, got {other}")
        }
    };
    match T::deserialize(value) {
        Ok(decoded) => decoded,
        Err(error) => panic!("{rule_name}: failed to unmarshal options: {error}"),
    }
}

/// A copy of `value` whose objects have no `null` properties, so each such
/// property takes its default (the generated Go types reset absent and `null`
/// properties to the schema default).
fn without_nulls(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), without_nulls(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(without_nulls).collect()),
        other => other.clone(),
    }
}

/// An option that is either a boolean or an object `T` (Go `utils.BoolOr`).
/// `null` and values of any other shape are silently unset.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum BoolOr<T> {
    #[default]
    Unset,
    Bool(bool),
    Object(T),
}

impl<T> BoolOr<T> {
    /// Set to boolean `true` (Go `IsTrue`).
    pub fn is_true(&self) -> bool {
        matches!(self, BoolOr::Bool(true))
    }

    /// Set to `false` or unset (Go `IsFalse`).
    pub fn is_false(&self) -> bool {
        matches!(self, BoolOr::Unset | BoolOr::Bool(false))
    }

    pub fn object(&self) -> Option<&T> {
        match self {
            BoolOr::Object(object) => Some(object),
            _ => None,
        }
    }

    /// `true` for boolean `true` or an object (Go `Bool`).
    pub fn as_bool(&self) -> bool {
        matches!(self, BoolOr::Bool(true) | BoolOr::Object(_))
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for BoolOr<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Value::deserialize(deserializer)? {
            Value::Null => BoolOr::Unset,
            Value::Bool(value) => BoolOr::Bool(value),
            value @ Value::Object(_) => T::deserialize(value).map_or(BoolOr::Unset, BoolOr::Object),
            _ => BoolOr::Unset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Deserialize, Debug, PartialEq)]
    #[serde(default, rename_all = "camelCase")]
    struct Options {
        ignore_string_arrays: bool,
        check_never: bool,
        nested: BoolOr<Inner>,
    }

    impl Default for Options {
        fn default() -> Self {
            Self {
                ignore_string_arrays: true,
                check_never: false,
                nested: BoolOr::Unset,
            }
        }
    }

    #[derive(Deserialize, Debug, PartialEq, Default)]
    #[serde(default)]
    struct Inner {
        a: u32,
    }

    #[test]
    fn null_and_missing_take_defaults() {
        let o: Options = decode_options(&Value::Null, "r");
        assert_eq!(o, Options::default());
        let o: Options = decode_options(
            &json!({"ignoreStringArrays": null, "checkNever": true, "x": 1}),
            "r",
        );
        assert!(o.ignore_string_arrays && o.check_never);
    }

    #[test]
    fn bool_or() {
        let o: Options = decode_options(&json!({"nested": {"a": 2}}), "r");
        assert_eq!(o.nested, BoolOr::Object(Inner { a: 2 }));
        let o: Options = decode_options(&json!({"nested": 3}), "r");
        assert_eq!(o.nested, BoolOr::Unset);
        let o: Options = decode_options(&json!({"nested": false}), "r");
        assert!(o.nested.is_false() && !matches!(o.nested, BoolOr::Unset));
    }

    #[test]
    #[should_panic(expected = "r: failed to unmarshal options: ")]
    fn wrong_type_panics() {
        let _: Options = decode_options(&json!({"checkNever": "yes"}), "r");
    }

    #[test]
    #[should_panic(expected = "r: failed to unmarshal options: ")]
    fn array_panics() {
        let _: Options = decode_options(&json!([]), "r");
    }
}
