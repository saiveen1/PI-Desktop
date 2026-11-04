use serde_json::Value;
use std::collections::HashSet;

/// Validate without normalizing or migrating the cost/approval policy. Absence
/// alone preserves legacy behavior; null and malformed policies must fail closed.
pub(super) fn validate(settings: &Value) -> Result<(), &'static str> {
    let object = settings.as_object().ok_or("settings must be an object")?;
    let Some(policy) = object.get("delegation") else {
        return Ok(());
    };
    let policy = policy.as_object().ok_or("delegation must be an object")?;
    if policy.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err("delegation.version must be 1");
    }
    if !integer_in_range(policy.get("approvalTimeoutSeconds"), 0.0, 300.0) {
        return Err("delegation.approvalTimeoutSeconds must be an integer from 0 to 300");
    }
    if let Some(run_policy) = policy.get("runPolicy") {
        validate_run_policy(run_policy)?;
    }
    let models = policy
        .get("models")
        .and_then(Value::as_array)
        .ok_or("delegation.models must be an array")?;
    if models.len() > 128 {
        return Err("delegation.models contains too many models");
    }
    let mut identities = HashSet::new();
    for row in models {
        let row = row
            .as_object()
            .ok_or("delegation.models entries must be objects")?;
        let provider_id = row
            .get("providerId")
            .and_then(Value::as_str)
            .filter(|text| identifier(text, 128))
            .ok_or("delegation providerId must be trimmed and contain 1 to 128 characters")?;
        let model_id = row
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|text| identifier(text, 256))
            .ok_or("delegation modelId must be trimmed and contain 1 to 256 characters")?;
        if !row.get("enabled").is_some_and(Value::is_boolean) {
            return Err("delegation enabled must be a boolean");
        }
        if !integer_in_range(row.get("priority"), 1.0, 100.0) {
            return Err("delegation priority must be an integer from 1 to 100");
        }
        if !matches!(
            row.get("approval").and_then(Value::as_str),
            Some("auto" | "ask")
        ) {
            return Err("delegation approval must be auto or ask");
        }
        if row
            .get("description")
            .and_then(Value::as_str)
            .is_none_or(|text| text.encode_utf16().count() > 1000)
        {
            return Err("delegation description must be a string of at most 1000 characters");
        }
        if !identities.insert((provider_id, model_id)) {
            return Err("delegation.models contains a duplicate providerId/modelId pair");
        }
    }
    Ok(())
}

fn validate_run_policy(value: &Value) -> Result<(), &'static str> {
    let policy = value
        .as_object()
        .ok_or("delegation.runPolicy must be an object")?;
    for (key, value) in policy {
        let (min, max) = match key.as_str() {
            "maxToolCalls" => (0.0, 10_000.0),
            "maxDurationSeconds" => (0.0, 21_600.0),
            // Retired trial fields are preserved as data and ignored by the runtime.
            "checkpointInterval" => (1.0, 1_000.0),
            "maxCheckpointRequests" => (1.0, 10.0),
            "finalReportTimeoutSeconds" => (1.0, 300.0),
            _ => return Err("delegation.runPolicy contains an unknown field"),
        };
        if !integer_in_range(Some(value), min, max) {
            return Err("delegation.runPolicy values must be integers within the supported range");
        }
    }
    Ok(())
}

fn integer_in_range(value: Option<&Value>, min: f64, max: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.fract() == 0.0 && (min..=max).contains(&number))
}

fn identifier(text: &str, max: usize) -> bool {
    // Match JavaScript String.trim and UTF-16 length in the shared contract,
    // including the BOM that Rust's str::trim does not remove.
    let whitespace = |ch| {
        matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' |
        '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    };
    !text.is_empty() && text.trim_matches(whitespace) == text && text.encode_utf16().count() <= max
}

#[cfg(test)]
pub(super) mod tests {
    use super::validate;
    use serde_json::{json, Value};

    pub(crate) fn policy() -> Value {
        json!({
            "version": 1,
            "approvalTimeoutSeconds": 60,
            "runPolicy": { "maxToolCalls": 27, "maxDurationSeconds": 120,
                "finalReportTimeoutSeconds": 9 },
            "models": [
                {"providerId": "provider-a", "modelId": "economy", "enabled": true,
                 "priority": 1, "approval": "auto", "description": "Routine work"},
                {"providerId": "provider-a", "modelId": "specialist", "enabled": false,
                 "priority": 100, "approval": "ask", "description": "Explicit approval only"}
            ]
        })
    }

    fn models(count: usize) -> Value {
        json!((0..count)
            .map(|index| {
                let mut row = policy()["models"][0].clone();
                row["modelId"] = json!(format!("model-{index}"));
                row
            })
            .collect::<Vec<_>>())
    }

    pub(crate) fn invalid_policies() -> Vec<Value> {
        let mut cases = vec![
            Value::Null,
            json!(false),
            json!(1),
            json!("legacy"),
            json!([]),
            json!({}),
        ];
        for field in ["version", "approvalTimeoutSeconds", "models"] {
            let mut value = policy();
            value.as_object_mut().unwrap().remove(field);
            cases.push(value);
        }
        for (field, invalid) in [
            ("version", json!(0)),
            ("version", json!(2)),
            ("version", json!("1")),
            ("approvalTimeoutSeconds", json!(-1)),
            ("approvalTimeoutSeconds", json!(301)),
            ("approvalTimeoutSeconds", json!(0.5)),
            ("approvalTimeoutSeconds", json!("60")),
            ("approvalTimeoutSeconds", Value::Null),
            ("approvalTimeoutSeconds", json!(true)),
            ("models", Value::Null),
            ("models", json!({})),
            ("models", json!([null])),
            ("models", json!([[]])),
            ("models", models(129)),
        ] {
            let mut value = policy();
            value[field] = invalid;
            cases.push(value);
        }
        for field in [
            "providerId",
            "modelId",
            "enabled",
            "priority",
            "approval",
            "description",
        ] {
            let mut value = policy();
            value["models"][0].as_object_mut().unwrap().remove(field);
            cases.push(value);
        }
        for (field, invalid) in [
            ("providerId", json!("")),
            ("providerId", json!(" ")),
            ("providerId", json!(" provider-a")),
            ("providerId", json!("provider-a\n")),
            ("providerId", json!("p".repeat(129))),
            ("providerId", json!(12)),
            ("providerId", json!("🦀".repeat(65))),
            ("providerId", json!("\u{feff}provider-a")),
            ("modelId", json!("")),
            ("modelId", json!("\t")),
            ("modelId", json!(" model")),
            ("modelId", json!("model ")),
            ("modelId", json!("m".repeat(257))),
            ("modelId", Value::Null),
            ("enabled", json!("true")),
            ("enabled", Value::Null),
            ("priority", json!(0)),
            ("priority", json!(101)),
            ("priority", json!(1.5)),
            ("priority", json!("1")),
            ("priority", Value::Null),
            ("priority", json!(false)),
            ("approval", json!("allow")),
            ("approval", json!("ASK")),
            ("approval", json!(true)),
            ("approval", Value::Null),
            ("description", json!("d".repeat(1001))),
            ("description", json!("🦀".repeat(501))),
            ("description", Value::Null),
            ("description", json!({})),
        ] {
            let mut value = policy();
            value["models"][0][field] = invalid;
            cases.push(value);
        }
        for run_policy in [Value::Null, json!([]), json!(true), json!({"typo": 1})] {
            let mut value = policy();
            value["runPolicy"] = run_policy;
            cases.push(value);
        }
        for (field, min, max) in [
            ("maxToolCalls", 0, 10_000),
            ("maxDurationSeconds", 0, 21_600),
            ("checkpointInterval", 1, 1_000),
            ("maxCheckpointRequests", 1, 10),
            ("finalReportTimeoutSeconds", 1, 300),
        ] {
            for invalid in [
                json!(min - 1),
                json!(max + 1),
                json!(1.5),
                json!("1"),
                Value::Null,
                json!(false),
            ] {
                let mut value = policy();
                value["runPolicy"] = json!({});
                value["runPolicy"][field] = invalid;
                cases.push(value);
            }
        }
        let mut duplicate = policy();
        duplicate["models"][1]["modelId"] = json!("economy");
        cases.push(duplicate);
        cases
    }

    #[test]
    fn delegation_settings_run_policy_accepts_partial_and_unlimited_values() {
        for run_policy in [
            json!({}),
            json!({"maxToolCalls": 0, "maxDurationSeconds": 0}),
            json!({"maxToolCalls": 10_000, "maxDurationSeconds": 21_600,
                "checkpointInterval": 1_000, "maxCheckpointRequests": 10, "finalReportTimeoutSeconds": 300}),
            json!({"checkpointInterval": 1, "maxCheckpointRequests": 1, "finalReportTimeoutSeconds": 1}),
        ] {
            let mut value = policy();
            value["runPolicy"] = run_policy;
            assert!(validate(&json!({"delegation": value})).is_ok());
        }
        let mut legacy = policy();
        legacy.as_object_mut().unwrap().remove("runPolicy");
        assert!(validate(&json!({"delegation": legacy})).is_ok());
    }

    #[test]
    fn delegation_settings_accepts_boundaries_and_distinct_identity_pairs() {
        assert!(validate(&json!({})).is_ok());
        for timeout in [json!(0), json!(300), json!(300.0)] {
            let value = json!({"delegation": {"version": 1.0, "approvalTimeoutSeconds": timeout, "models": []}});
            assert!(validate(&value).is_ok(), "{value}");
        }
        let mut value = policy();
        value["models"][0]["providerId"] = json!("🦀".repeat(64));
        value["models"][0]["modelId"] = json!("m".repeat(256));
        value["models"][0]["description"] = json!("🦀".repeat(500));
        value["models"][0]["priority"] = json!(1.0);
        assert!(validate(&json!({"delegation": value})).is_ok());
        value["models"] = models(128);
        assert!(validate(&json!({"delegation": value})).is_ok());
        value["models"] = json!([
            {"providerId": "a/b", "modelId": "c", "enabled": true, "priority": 1, "approval": "auto", "description": ""},
            {"providerId": "a", "modelId": "b/c", "enabled": true, "priority": 1, "approval": "ask", "description": ""}
        ]);
        assert!(validate(&json!({"delegation": value})).is_ok());
    }

    #[test]
    fn delegation_settings_rejects_invalid_policies() {
        for value in invalid_policies() {
            let error = validate(&json!({"delegation": value}))
                .expect_err("invalid delegation must fail closed");
            assert!(error.starts_with("delegation"), "{value}: {error}");
        }
    }

    #[test]
    fn delegation_settings_rejects_non_object_replacements() {
        for value in [
            Value::Null,
            json!([]),
            json!(false),
            json!("reset"),
            json!(1),
        ] {
            assert!(validate(&value).is_err(), "{value}");
        }
    }
}
