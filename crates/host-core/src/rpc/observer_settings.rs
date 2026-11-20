use serde_json::{Map, Value};

pub(super) fn validate(settings: &Map<String, Value>) -> Result<(), &'static str> {
    let Some(observer) = settings.get("observerGuard") else {
        return Ok(());
    };
    let observer = observer
        .as_object()
        .ok_or("observerGuard must be an object")?;
    if observer
        .get("continueOnTransientError")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("observerGuard.continueOnTransientError must be a boolean");
    }
    if observer.get("maxContinuations").is_some_and(|value| {
        !value
            .as_u64()
            .is_some_and(|count| (1..=100).contains(&count))
    }) {
        return Err("observerGuard.maxContinuations must be an integer from 1 to 100");
    }
    if observer.get("prompt").is_some_and(|value| {
        !value.as_str().is_some_and(|prompt| {
            prompt.encode_utf16().count() <= 8000
                && !prompt
                    .bytes()
                    .any(|byte| matches!(byte, 0..=8 | 11 | 12 | 14..=31 | 127))
        })
    }) {
        return Err("observerGuard.prompt must be a string of at most 8000 characters");
    }
    Ok(())
}

pub(super) fn normalize(settings: &mut Map<String, Value>) {
    if let Some(observer) = settings
        .get_mut("observerGuard")
        .and_then(Value::as_object_mut)
    {
        observer.remove("includeToolOutput");
        observer.remove("recentToolCount");
        if observer
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| prompt.trim().is_empty())
        {
            observer.remove("prompt");
        }
    }
}
