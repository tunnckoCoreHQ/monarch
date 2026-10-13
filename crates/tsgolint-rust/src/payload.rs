//! The stdin payload of `tsgolint headless` (Go `cmd/tsgolint/payload.go`).
//!
//! Decoding follows Go's `json.Unmarshal` (JSON v2) into tsgolint's structs:
//! field names match case-sensitively, unknown fields are ignored, `null`
//! leaves the zero value, and a value of the wrong JSON kind is an error.

use goport_core::gostd::strconv;

use crate::json::{self, Value};

/// A rule of a config: its name and its options as the rule receives them.
#[derive(Clone, Debug, PartialEq)]
pub struct PayloadRule {
    pub name: String,
    /// Go `Options any`: `None` when absent or `null`. Numbers are Go
    /// `float64` values: integral ones that fit become JSON integers.
    pub options: Option<serde_json::Value>,
}

/// Files that share one rule configuration.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PayloadConfig {
    pub file_paths: Vec<String>,
    pub rules: Vec<PayloadRule>,
}

/// The decoded payload, always in the V2 shape.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Payload {
    pub configs: Vec<PayloadConfig>,
    /// File path -> file text, in input order (Go map; keys are unique).
    pub source_overrides: Vec<(String, String)>,
    pub report_syntactic: bool,
    pub report_semantic: bool,
}

/// Go `deserializePayload`. The error is the text after
/// `error parsing config: `.
pub fn decode(data: &[u8]) -> Result<Payload, String> {
    let root = json::parse(data)?;
    let version = payload_version(&root)?;
    if version == 2 {
        return decode_v2(&root).map_err(|e| format!("failed to deserialize V2 payload: {e}"));
    }
    // Version 0 or unset is the V1 payload.
    if version != 0 {
        return Err(format!(
            "unsupported version `{version}`: expected `unset` or `2`"
        ));
    }
    let files = decode_v1(&root).map_err(|e| format!("failed to deserialize V1 payload: {e}"))?;
    if files.is_empty() {
        return Err("V1 payload has no files".to_string());
    }
    Ok(Payload {
        configs: files
            .into_iter()
            .map(|(file_path, rules)| PayloadConfig {
                file_paths: vec![file_path],
                rules: rules
                    .into_iter()
                    .map(|name| PayloadRule {
                        name,
                        options: None,
                    })
                    .collect(),
            })
            .collect(),
        ..Payload::default()
    })
}

/// Go `getPayloadVersion`: the payload decoded into
/// `struct { Version int "json:\"version\"" }`.
fn payload_version(root: &Value) -> Result<i64, String> {
    const GO_TYPE: &str = r#"struct { Version int "json:\"version\"" }"#;
    let mut version = 0;
    Decoder::default().fields(root, GO_TYPE, |d, name, value| {
        if name == "version" {
            version = d.int(value)?;
        }
        Ok(())
    })?;
    Ok(version)
}

fn decode_v2(root: &Value) -> Result<Payload, String> {
    let mut payload = Payload::default();
    let mut d = Decoder::default();
    d.fields(root, "main.headlessPayload", |d, name, value| {
        match name {
            "configs" => {
                payload.configs = d.slice(value, "[]main.headlessConfig", decode_config)?;
            }
            "source_overrides" => {
                payload.source_overrides = d.string_map(value, "map[string]string")?;
            }
            "report_syntactic" => payload.report_syntactic = d.bool(value)?,
            "report_semantic" => payload.report_semantic = d.bool(value)?,
            _ => {}
        }
        Ok(())
    })?;
    Ok(payload)
}

fn decode_config(d: &mut Decoder, value: &Value) -> Result<PayloadConfig, String> {
    let mut config = PayloadConfig::default();
    d.fields(value, "main.headlessConfig", |d, name, value| {
        match name {
            "file_paths" => config.file_paths = d.slice(value, "[]string", |d, v| d.string(v))?,
            "rules" => {
                config.rules = d.slice(value, "[]main.headlessRule", |d, v| {
                    let mut rule = PayloadRule {
                        name: String::new(),
                        options: None,
                    };
                    d.fields(v, "main.headlessRule", |d, name, value| {
                        match name {
                            "name" => rule.name = d.string(value)?,
                            "options" => rule.options = d.any(value)?,
                            _ => {}
                        }
                        Ok(())
                    })?;
                    Ok(rule)
                })?;
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(config)
}

/// The V1 `files`: (file path, rule names).
fn decode_v1(root: &Value) -> Result<Vec<(String, Vec<String>)>, String> {
    let mut files = Vec::new();
    let mut d = Decoder::default();
    d.fields(root, "main.headlessPayloadV1", |d, name, value| {
        if name == "files" {
            files = d.slice(value, "[]main.headlessConfigForFileV1", |d, v| {
                let mut file = (String::new(), Vec::new());
                d.fields(v, "main.headlessConfigForFileV1", |d, name, value| {
                    match name {
                        "file_path" => file.0 = d.string(value)?,
                        "rules" => file.1 = d.slice(value, "[]string", |d, v| d.string(v))?,
                        _ => {}
                    }
                    Ok(())
                })?;
                Ok(file)
            })?;
        }
        Ok(())
    })?;
    Ok(files)
}

/// A JSON number as Go `float64`. An integral value below 2^63 in magnitude
/// becomes an integer, so it decodes into the integer fields of rule options
/// as Go's re-marshaled `float64` does. `None` when it overflows float64.
fn float64_number(text: &str) -> Option<serde_json::Value> {
    let f: f64 = text.parse().ok().filter(|f: &f64| f.is_finite())?;
    if f.fract() == 0.0 && f.abs() < 2f64.powi(63) {
        #[allow(clippy::cast_possible_truncation)]
        return Some(serde_json::Value::from(f as i64));
    }
    serde_json::Number::from_f64(f).map(serde_json::Value::Number)
}

/// Decodes [`Value`]s into Go-typed values, tracking the JSON pointer for
/// the error texts of JSON v2 (`json: cannot unmarshal JSON number into Go
/// string within "/configs/0/file_paths/0"`).
#[derive(Default)]
struct Decoder {
    path: Vec<String>,
}

impl Decoder {
    fn error(&self, value: &Value, go_type: &str, detail: Option<(&str, &str)>) -> String {
        let mut text = format!("json: cannot unmarshal JSON {}", value.kind_name());
        if let Some((literal, _)) = detail {
            text.push(' ');
            text.push_str(literal);
        }
        text.push_str(" into Go ");
        text.push_str(go_type);
        if !self.path.is_empty() {
            text.push_str(" within ");
            let pointer: String = self
                .path
                .iter()
                .map(|t| format!("/{}", t.replace('~', "~0").replace('/', "~1")))
                .collect();
            text.push_str(&strconv::quote(&pointer));
        }
        if let Some((_, reason)) = detail {
            text.push_str(": ");
            text.push_str(reason);
        }
        text
    }

    /// The members of an object decoded into a struct; `null` decodes
    /// nothing.
    fn fields(
        &mut self,
        value: &Value,
        go_type: &str,
        mut field: impl FnMut(&mut Self, &str, &Value) -> Result<(), String>,
    ) -> Result<(), String> {
        self.object(value, go_type, |d, name, value| field(d, name, value))
            .map(|_| ())
    }

    fn object<T>(
        &mut self,
        value: &Value,
        go_type: &str,
        mut member: impl FnMut(&mut Self, &str, &Value) -> Result<T, String>,
    ) -> Result<Vec<T>, String> {
        match value {
            Value::Null => Ok(Vec::new()),
            Value::Object(members) => {
                let mut out = Vec::with_capacity(members.len());
                for (name, value) in members {
                    self.path.push(name.clone());
                    let result = member(self, name, value);
                    self.path.pop();
                    out.push(result?);
                }
                Ok(out)
            }
            _ => Err(self.error(value, go_type, None)),
        }
    }

    fn slice<T>(
        &mut self,
        value: &Value,
        go_type: &str,
        mut element: impl FnMut(&mut Self, &Value) -> Result<T, String>,
    ) -> Result<Vec<T>, String> {
        match value {
            Value::Null => Ok(Vec::new()),
            Value::Array(elements) => {
                let mut out = Vec::with_capacity(elements.len());
                for (i, value) in elements.iter().enumerate() {
                    self.path.push(i.to_string());
                    let result = element(self, value);
                    self.path.pop();
                    out.push(result?);
                }
                Ok(out)
            }
            _ => Err(self.error(value, go_type, None)),
        }
    }

    fn string_map(
        &mut self,
        value: &Value,
        go_type: &str,
    ) -> Result<Vec<(String, String)>, String> {
        self.object(value, go_type, |d, name, value| {
            Ok((name.to_string(), d.string(value)?))
        })
    }

    fn string(&mut self, value: &Value) -> Result<String, String> {
        match value {
            Value::Null => Ok(String::new()),
            Value::String(s) => Ok(s.clone()),
            _ => Err(self.error(value, "string", None)),
        }
    }

    fn bool(&mut self, value: &Value) -> Result<bool, String> {
        match value {
            Value::Null => Ok(false),
            Value::Bool(b) => Ok(*b),
            _ => Err(self.error(value, "bool", None)),
        }
    }

    /// Go `any`: `null` is nil (`None`), numbers are `float64`.
    fn any(&mut self, value: &Value) -> Result<Option<serde_json::Value>, String> {
        if *value == Value::Null {
            return Ok(None);
        }
        self.any_value(value).map(Some)
    }

    fn any_value(&mut self, value: &Value) -> Result<serde_json::Value, String> {
        Ok(match value {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Number(text) => float64_number(text)
                .ok_or_else(|| self.error(value, "float64", Some((text, "value out of range"))))?,
            Value::String(s) => serde_json::Value::String(s.clone()),
            Value::Array(elements) => {
                let mut out = Vec::with_capacity(elements.len());
                for (i, element) in elements.iter().enumerate() {
                    self.path.push(i.to_string());
                    let result = self.any_value(element);
                    self.path.pop();
                    out.push(result?);
                }
                serde_json::Value::Array(out)
            }
            Value::Object(members) => {
                let mut out = serde_json::Map::with_capacity(members.len());
                for (name, member) in members {
                    self.path.push(name.clone());
                    let result = self.any_value(member);
                    self.path.pop();
                    out.insert(name.clone(), result?);
                }
                serde_json::Value::Object(out)
            }
        })
    }

    /// Go `int` (64-bit): only integer syntax that fits.
    fn int(&mut self, value: &Value) -> Result<i64, String> {
        match value {
            Value::Null => Ok(0),
            Value::Number(text) => {
                let digits = text.strip_prefix('-').unwrap_or(text);
                if !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(self.error(value, "int", Some((text, "invalid syntax"))));
                }
                text.parse::<i64>()
                    .map_err(|_| self.error(value, "int", Some((text, "value out of range"))))
            }
            _ => Err(self.error(value, "int", None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(input: &str) -> String {
        decode(input.as_bytes()).unwrap_err()
    }

    #[test]
    fn v2() {
        let payload = decode(
            br#"{"version":2,"configs":[{"file_paths":["/a.ts","C:\\b.ts"],"rules":[{"name":"no-floating-promises","options":{"ignoreVoid":true,"n":3,"f":1.5,"big":1e300}},{"name":"await-thenable","options":null},{"name":"return-await","options":"in-try-catch"}],"unknown":1}],"source_overrides":{"/a.ts":"x"},"report_syntactic":true,"report_semantic":null,"extra":[1,2]}"#,
        )
        .unwrap();
        assert_eq!(
            payload,
            Payload {
                configs: vec![PayloadConfig {
                    file_paths: vec!["/a.ts".into(), "C:\\b.ts".into()],
                    rules: vec![
                        PayloadRule {
                            name: "no-floating-promises".into(),
                            options: Some(
                                serde_json::json!({"ignoreVoid": true, "n": 3, "f": 1.5, "big": 1e300})
                            ),
                        },
                        PayloadRule {
                            name: "await-thenable".into(),
                            options: None
                        },
                        PayloadRule {
                            name: "return-await".into(),
                            options: Some(serde_json::json!("in-try-catch"))
                        },
                    ],
                }],
                source_overrides: vec![("/a.ts".into(), "x".into())],
                report_syntactic: true,
                report_semantic: false,
            }
        );
        // Options keep their member order.
        let keys: Vec<_> = payload.configs[0].rules[0]
            .options
            .as_ref()
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["ignoreVoid", "n", "f", "big"]);
    }

    #[test]
    fn nulls_are_zero_values() {
        let payload = decode(br#"{"version":2,"configs":[null,{"file_paths":null,"rules":[null]}],"source_overrides":null}"#).unwrap();
        assert_eq!(payload.configs.len(), 2);
        assert_eq!(payload.configs[0], PayloadConfig::default());
        assert_eq!(
            payload.configs[1].rules,
            vec![PayloadRule {
                name: String::new(),
                options: None
            }]
        );
        assert_eq!(
            decode(br#"{"version":2,"configs":null}"#).unwrap(),
            Payload::default()
        );
        assert_eq!(
            decode(br#"{"version":null,"files":[{"file_path":"/a.ts"}]}"#)
                .unwrap()
                .configs
                .len(),
            1
        );
    }

    #[test]
    fn v1() {
        let payload = decode(br#"{"files":[{"file_path":"/a.ts","rules":["r1","r2"]},{"file_path":"/b.ts","rules":[]}]}"#).unwrap();
        assert_eq!(
            payload,
            Payload {
                configs: vec![
                    PayloadConfig {
                        file_paths: vec!["/a.ts".into()],
                        rules: vec![
                            PayloadRule {
                                name: "r1".into(),
                                options: None
                            },
                            PayloadRule {
                                name: "r2".into(),
                                options: None
                            },
                        ],
                    },
                    PayloadConfig {
                        file_paths: vec!["/b.ts".into()],
                        rules: vec![]
                    },
                ],
                ..Payload::default()
            }
        );
        // An explicit version 0 is V1 too; V1 ignores `configs`.
        assert_eq!(
            err(r#"{"version":0,"configs":[{"file_paths":["/a.ts"]}]}"#),
            "V1 payload has no files"
        );
    }

    // Texts captured from the Go binary (`error parsing config: ` stripped).
    // Go picks "cannot" or "unable to" at random per process; this port says
    // "cannot".
    #[test]
    fn go_error_texts() {
        assert_eq!(
            err(r#"{"version":3}"#),
            "unsupported version `3`: expected `unset` or `2`"
        );
        assert_eq!(
            err(r#"{"version":-1}"#),
            "unsupported version `-1`: expected `unset` or `2`"
        );
        assert_eq!(
            err(r#"{"version":"2"}"#),
            r#"json: cannot unmarshal JSON string into Go int within "/version""#
        );
        assert_eq!(
            err(r#"{"version":2.0}"#),
            r#"json: cannot unmarshal JSON number 2.0 into Go int within "/version": invalid syntax"#
        );
        assert_eq!(
            err(r#"{"version":1e0}"#),
            r#"json: cannot unmarshal JSON number 1e0 into Go int within "/version": invalid syntax"#
        );
        assert_eq!(
            err(r#"{"version":9999999999999999999}"#),
            r#"json: cannot unmarshal JSON number 9999999999999999999 into Go int within "/version": value out of range"#
        );
        assert_eq!(err(r#"{"Version":2}"#), "V1 payload has no files");
        assert_eq!(err("{}"), "V1 payload has no files");
        assert_eq!(err("null"), "V1 payload has no files");
        assert_eq!(err(r#"{"files":[]}"#), "V1 payload has no files");
        assert_eq!(
            err(r#"{"version":0,"files":null}"#),
            "V1 payload has no files"
        );
        assert_eq!(
            err("[]"),
            r#"json: cannot unmarshal JSON array into Go struct { Version int "json:\"version\"" }"#
        );
        assert_eq!(
            err(r#"{"files":[{"file_path":1}]}"#),
            r#"failed to deserialize V1 payload: json: cannot unmarshal JSON number into Go string within "/files/0/file_path""#
        );
        assert_eq!(
            err(r#"{"version":2,"configs":{}}"#),
            r#"failed to deserialize V2 payload: json: cannot unmarshal JSON object into Go []main.headlessConfig within "/configs""#
        );
        assert_eq!(
            err(r#"{"version":2,"configs":[{"file_paths":[1]}]}"#),
            r#"failed to deserialize V2 payload: json: cannot unmarshal JSON number into Go string within "/configs/0/file_paths/0""#
        );
        assert_eq!(
            err(r#"{"version":2,"report_syntactic":1}"#),
            r#"failed to deserialize V2 payload: json: cannot unmarshal JSON number into Go bool within "/report_syntactic""#
        );
        assert_eq!(
            err(r#"{"version":2,"source_overrides":{"a":1}}"#),
            r#"failed to deserialize V2 payload: json: cannot unmarshal JSON number into Go string within "/source_overrides/a""#
        );
    }

    #[test]
    fn duplicate_keys_anywhere() {
        assert_eq!(
            err(r#"{"version":2,"version":2}"#),
            r#"jsontext: duplicate object member name "version""#
        );
        assert!(
            err(r#"{"version":2,"extra":{"a":1,"a":2}}"#)
                .starts_with("jsontext: duplicate object member name \"a\"")
        );
        assert!(
            err(r#"{"files":[{"file_path":"/a","file_path":"/b"}]}"#)
                .starts_with("jsontext: duplicate")
        );
        // Names differ only by case: not duplicates.
        assert!(decode(br#"{"version":2,"configs":[],"Configs":{}}"#).is_ok());
    }

    #[test]
    fn float64_overflow() {
        assert_eq!(
            err(r#"{"version":2,"configs":[{"rules":[{"name":"a","options":{"x":[1e400]}}]}]}"#),
            r#"failed to deserialize V2 payload: json: cannot unmarshal JSON number 1e400 into Go float64 within "/configs/0/rules/0/options/x/0": value out of range"#
        );
    }

    #[test]
    fn invalid_utf8() {
        assert!(
            decode(b"{\"version\":2,\"configs\":[{\"file_paths\":[\"/a\xff.ts\"]}]}")
                .unwrap_err()
                .starts_with("jsontext: invalid UTF-8")
        );
    }
}
