//! Bounded, allowlisted observational metadata; never restored as execution state.
use serde_json::{json, Value};

fn count(value: &Value) -> Option<Value> {
    value
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .map(|n| json!(n))
}
fn text(value: &Value, limit: usize) -> Option<Value> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= limit)
        .map(|s| json!(s))
}
fn member(value: &Value, allowed: &[&str]) -> Option<Value> {
    value
        .as_str()
        .filter(|s| allowed.contains(s))
        .map(|s| json!(s))
}
fn numbers(source: &Value, target: &mut Value, keys: &[&str], optional: bool) -> Option<()> {
    for key in keys {
        if optional && source.get(key).is_none() {
            continue;
        }
        target[key] = count(&source[key])?;
    }
    Some(())
}
fn array(source: &Value, limit: usize, parse: fn(&Value) -> Option<Value>) -> Option<Value> {
    let rows = source.as_array()?;
    if rows.len() > limit {
        return None;
    }
    rows.iter()
        .map(parse)
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}
fn usage(source: &Value) -> Option<Value> {
    let mut out = json!({});
    numbers(
        source,
        &mut out,
        &["inputTokens", "outputTokens", "totalTokens"],
        false,
    )?;
    Some(out)
}
fn attempt(source: &Value) -> Option<Value> {
    let mut out = json!({"model":text(&source["model"],512)?,
        "outcome":member(&source["outcome"], &["running","completed","failed","aborted","unresolved"])?});
    numbers(source, &mut out, &["sequence", "startedAt"], false)?;
    numbers(source, &mut out, &["finishedAt"], true)?;
    if let Some(end) = source.get("finishedAt") {
        if end.as_u64()? < source["startedAt"].as_u64()? {
            return None;
        }
    }
    if let Some(duration) = source.get("providerDurationMs") {
        if !duration.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
            return None;
        }
        out["providerDurationMs"] = duration.clone();
    }
    if let Some(error) = source.get("error") {
        out["error"] =
            json!({"code":text(&error["code"],200)?,"message":text(&error["message"],2000)?});
    }
    if let Some(value) = source.get("usage") {
        out["usage"] = usage(value)?;
    }
    Some(out)
}
fn approval(source: &Value) -> Option<Value> {
    Some(
        json!({"model":text(&source["model"],512)?,"at":count(&source["at"])?,
        "status":member(&source["status"], &["pending","accepted","rejected","cancelled"])?}),
    )
}
fn tool(source: &Value) -> Option<Value> {
    let mut out = json!({"toolCallId":text(&source["toolCallId"],512)?,
        "toolName":text(&source["toolName"],200)?,
        "outcome":member(&source["outcome"], &["pending","completed","failed"])?,
        "effects":member(&source["effects"], &["unknown","read_only","write_confirmed"])?});
    numbers(source, &mut out, &["startedAt"], false)?;
    numbers(
        source,
        &mut out,
        &["finishedAt", "outputChars", "totalLines"],
        true,
    )?;
    if let Some(path) = source.get("path") {
        out["path"] = text(path, 1000)?;
    }
    Some(out)
}
pub(super) fn project(source: &Value) -> Option<Value> {
    if source["version"] != 1 {
        return None;
    }
    let mut out = json!({"version":1,"selectedModel":text(&source["selectedModel"],512)?,
        "phase":member(&source["phase"], &["preparing","model","tool","retrying","approval","ended"])?});
    numbers(
        source,
        &mut out,
        &[
            "lastActivityAt",
            "attemptCount",
            "attemptsOmitted",
            "approvalsOmitted",
            "completedToolCalls",
            "failedToolCalls",
            "pendingToolsOmitted",
            "confirmedWritePathsOmitted",
        ],
        false,
    )?;
    numbers(
        source,
        &mut out,
        &[
            "executionStartedAt",
            "executionEndedAt",
            "reportProducedAt",
            "reportDeliveredAt",
            "lastMeaningfulProgressAt",
        ],
        true,
    )?;
    let diagnostic = &source["diagnostic"];
    out["diagnostic"] = json!({"state":member(&diagnostic["state"],
        &["observing","waiting_tool","waiting_model","no_new_evidence","approval_pending","ended"])?,
        "observedAt":count(&diagnostic["observedAt"])?,"thresholdMs":count(&diagnostic["thresholdMs"])?,
        "reason":text(&diagnostic["reason"],1000)?});
    out["attempts"] = array(&source["attempts"], 64, attempt)?;
    out["approvals"] = array(&source["approvals"], 64, approval)?;
    out["pendingTools"] = array(&source["pendingTools"], 16, tool)?;
    out["recentTools"] = array(&source["recentTools"], 12, tool)?;
    out["confirmedWritePaths"] = array(&source["confirmedWritePaths"], 32, |v| text(v, 1000))?;
    if source["attemptCount"].as_u64()?
        != out["attempts"].as_array()?.len() as u64 + source["attemptsOmitted"].as_u64()?
    {
        return None;
    }
    Some(out)
}
