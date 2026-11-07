use serde_json::Value;

/// Settings writes and portable imports share the same bounded recovery policy.
pub(crate) fn is_unknown_upstream_retry_limit(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.fract() == 0.0 && (0.0..=3.0).contains(&number))
}
