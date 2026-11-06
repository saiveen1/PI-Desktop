use serde_json::Value;

/// Validate `AppSettings.notifications` without normalizing or rewriting it.
///
/// Absence alone preserves legacy behavior; null and malformed preferences must
/// fail closed so a bad write can never replace saved settings. The accepted
/// shape is the strict mirror of `packages/shared/src/notification-settings.ts`:
/// unknown keys are rejected at every level, `delegation` is the only per-source
/// override, and its reminder interval is either `0` (remind once) or an integer
/// from 10 to 300.
pub(super) fn validate(settings: &Value) -> Result<(), &'static str> {
    let object = settings.as_object().ok_or("settings must be an object")?;
    let Some(preferences) = object.get("notifications") else {
        return Ok(());
    };
    let preferences = preferences
        .as_object()
        .ok_or("notifications must be an object")?;
    if has_unknown_key(
        preferences,
        &[
            "version",
            "enabled",
            "channel",
            "sound",
            "volume",
            "categories",
            "delegation",
        ],
    ) {
        return Err("notifications contains an unknown field");
    }
    if preferences.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err("notifications.version must be 1");
    }
    validate_policy(preferences, "notifications")?;
    if let Some(categories) = preferences.get("categories") {
        let categories = categories
            .as_object()
            .ok_or("notifications.categories must be an object")?;
        if has_unknown_key(categories, &["needsAction", "failures", "completions"]) {
            return Err("notifications.categories contains an unknown field");
        }
        for (name, value) in categories {
            if !value.is_boolean() {
                return Err(match name.as_str() {
                    "needsAction" => "notifications.categories.needsAction must be a boolean",
                    "failures" => "notifications.categories.failures must be a boolean",
                    _ => "notifications.categories.completions must be a boolean",
                });
            }
        }
    }
    if let Some(override_value) = preferences.get("delegation") {
        let override_value = override_value
            .as_object()
            .ok_or("notifications.delegation must be an object")?;
        if has_unknown_key(
            override_value,
            &[
                "enabled",
                "channel",
                "sound",
                "volume",
                "repeatIntervalSeconds",
            ],
        ) {
            return Err("notifications.delegation contains an unknown field");
        }
        validate_policy(override_value, "notifications.delegation")?;
        if let Some(interval) = override_value.get("repeatIntervalSeconds") {
            // `0` means "remind once"; any positive repeat starts at 10 seconds.
            let once_only = interval.as_f64() == Some(0.0);
            if !once_only && !integer_in_range(Some(interval), 10.0, 300.0) {
                return Err("notifications.delegation.repeatIntervalSeconds must be 0 or an integer from 10 to 300");
            }
        }
    }
    Ok(())
}

/// The fields the global policy and the delegation override share. `context`
/// names the object being checked so one message stays truthful for both.
fn validate_policy(
    policy: &serde_json::Map<String, Value>,
    context: &str,
) -> Result<(), &'static str> {
    for (name, value) in policy {
        match name.as_str() {
            "enabled" | "sound" => {
                if !value.is_boolean() {
                    return Err(match (context, name.as_str()) {
                        ("notifications.delegation", "enabled") => {
                            "notifications.delegation.enabled must be a boolean"
                        }
                        ("notifications.delegation", _) => {
                            "notifications.delegation.sound must be a boolean"
                        }
                        (_, "enabled") => "notifications.enabled must be a boolean",
                        _ => "notifications.sound must be a boolean",
                    });
                }
            }
            "channel" => {
                if !matches!(value.as_str(), Some("auto" | "in-app" | "system")) {
                    return Err(match context {
                        "notifications.delegation" => {
                            "notifications.delegation.channel must be auto, in-app, or system"
                        }
                        _ => "notifications.channel must be auto, in-app, or system",
                    });
                }
            }
            "volume" => {
                if !integer_in_range(Some(value), 0.0, 100.0) {
                    return Err(match context {
                        "notifications.delegation" => {
                            "notifications.delegation.volume must be an integer from 0 to 100"
                        }
                        _ => "notifications.volume must be an integer from 0 to 100",
                    });
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn has_unknown_key(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().any(|key| !allowed.contains(&key.as_str()))
}

fn integer_in_range(value: Option<&Value>, min: f64, max: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.fract() == 0.0 && (min..=max).contains(&number))
}

#[cfg(test)]
pub(super) mod tests {
    use super::validate;
    use serde_json::{json, Value};

    pub(crate) fn preferences() -> Value {
        json!({
            "version": 1,
            "enabled": true,
            "channel": "auto",
            "sound": false,
            "volume": 40,
            "categories": {"needsAction": true, "failures": false, "completions": true},
            "delegation": {
                "enabled": true, "channel": "system", "sound": true, "volume": 0,
                "repeatIntervalSeconds": 30
            }
        })
    }

    pub(crate) fn invalid_preferences() -> Vec<Value> {
        let mut cases = vec![
            Value::Null,
            json!(false),
            json!(1),
            json!("notifications"),
            json!([]),
            json!({}),
        ];
        for (field, invalid) in [
            ("version", json!(0)),
            ("version", json!(2)),
            ("version", json!("1")),
            ("version", json!(1.5)),
            ("version", Value::Null),
            ("version", json!(true)),
            ("enabled", json!("true")),
            ("enabled", json!(1)),
            ("enabled", Value::Null),
            ("channel", json!("native")),
            ("channel", json!("System")),
            ("channel", json!(true)),
            ("channel", Value::Null),
            ("sound", json!("true")),
            ("sound", json!(0)),
            ("sound", Value::Null),
            ("volume", json!(-1)),
            ("volume", json!(101)),
            ("volume", json!(1.5)),
            ("volume", json!("50")),
            ("volume", Value::Null),
            ("categories", Value::Null),
            ("categories", json!([])),
            ("categories", json!({"other": true})),
            ("categories", json!({"needsAction": "yes"})),
            ("categories", json!({"needsAction": Value::Null})),
            (
                "categories",
                json!({"needsAction": false, "completions": 1}),
            ),
            ("delegation", Value::Null),
            ("delegation", json!([])),
            ("delegation", json!(true)),
            ("delegation", json!({"unknown": 1})),
            ("delegation", json!({"enabled": "yes"})),
            ("delegation", json!({"channel": "auto", "repeat": 10})),
            ("delegation", json!({"sound": 1})),
            ("delegation", json!({"volume": 101})),
            ("delegation", json!({"repeatIntervalSeconds": 1})),
            ("delegation", json!({"repeatIntervalSeconds": 9})),
            ("delegation", json!({"repeatIntervalSeconds": 301})),
            ("delegation", json!({"repeatIntervalSeconds": -10})),
            ("delegation", json!({"repeatIntervalSeconds": 10.5})),
            ("delegation", json!({"repeatIntervalSeconds": "30"})),
            ("delegation", json!({"repeatIntervalSeconds": Value::Null})),
            ("delegation", json!({"repeatIntervalSeconds": true})),
            ("unexpected", json!(true)),
            ("category", json!(true)),
        ] {
            let mut value = preferences();
            value[field] = invalid;
            cases.push(value);
        }
        let mut without_version = preferences();
        without_version.as_object_mut().unwrap().remove("version");
        cases.push(without_version);
        cases
    }

    #[test]
    fn notification_settings_accepts_partial_and_boundary_values() {
        for preferences in [
            json!({"version": 1}),
            json!({"version": 1.0}),
            json!({"version": 1, "enabled": false, "channel": "in-app", "sound": true, "volume": 0}),
            json!({"version": 1, "volume": 100, "categories": {}}),
            json!({"version": 1, "categories": {"needsAction": true}}),
            json!({"version": 1, "delegation": {}}),
            json!({"version": 1, "delegation": {"repeatIntervalSeconds": 0}}),
            json!({"version": 1, "delegation": {"repeatIntervalSeconds": 10}}),
            json!({"version": 1, "delegation": {"repeatIntervalSeconds": 300}}),
            json!({"version": 1, "delegation": {"repeatIntervalSeconds": 300.0}}),
            preferences(),
        ] {
            assert!(
                validate(&json!({"notifications": preferences, "theme": "dark"})).is_ok(),
                "{preferences}"
            );
        }
        // Missing preferences stay accepted: absence is the legacy shape and
        // must never be rewritten by validation.
        for settings in [
            json!({}),
            json!({"theme": "dark"}),
            json!({"delegation": null}),
        ] {
            assert!(validate(&settings).is_ok(), "{settings}");
        }
    }

    #[test]
    fn notification_settings_rejects_invalid_preferences() {
        for preferences in invalid_preferences() {
            let error = validate(&json!({"notifications": preferences, "theme": "light"}))
                .expect_err("invalid notification preferences must fail closed");
            assert!(error.starts_with("notifications"), "{preferences}: {error}");
        }
    }

    #[test]
    fn notification_settings_rejects_non_object_replacements() {
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
