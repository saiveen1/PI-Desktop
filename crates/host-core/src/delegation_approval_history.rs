//! Optional, versioned receipts in the existing Host-owned kv extension.
use crate::db::{ms_to_ts, now_ms, Database};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
const NS: &str = "delegationApprovalHistory";
const KEY: &str = "v1";
const KEEP: usize = 200;

fn load(db: &Database) -> Result<Vec<Value>> {
    let Some(value) = db.kv_get(NS, KEY)? else {
        return Ok(vec![]);
    };
    ensure!(
        value["version"] == 1,
        "Unsupported delegation receipt version"
    );
    let rows = value["entries"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid delegation receipts"))?;
    ensure!(rows.len() <= KEEP, "Too many delegation receipts");
    Ok(rows.clone())
}
fn save(db: &Database, entries: &[Value]) -> Result<()> {
    db.kv_set(NS, KEY, &json!({"version":1,"entries":entries}))
}
pub fn list(db: &Database) -> Result<Value> {
    Ok(json!({"entries":load(db)?}))
}
fn timestamp(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
}
fn id(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.trim() == s && s.encode_utf16().count() <= 256)
}
fn same(a: &Value, b: &Value) -> bool {
    a["sessionId"] == b["sessionId"] && a["requestId"] == b["requestId"]
}
fn model(input: &Value) -> Result<Value> {
    ensure!(
        id(&input["providerId"]) && id(&input["modelId"]),
        "Invalid receipt model"
    );
    ensure!(
        input["providerName"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty()),
        "Invalid provider label"
    );
    ensure!(
        input["priority"]
            .as_u64()
            .is_some_and(|n| (1..=100).contains(&n)),
        "Invalid priority"
    );
    ensure!(
        matches!(input["approval"].as_str(), Some("auto" | "ask")),
        "Invalid approval mode"
    );
    let mut out = json!({});
    for key in [
        "providerId",
        "modelId",
        "providerName",
        "modelLabel",
        "thinkingLevel",
        "priority",
        "approval",
    ] {
        if let Some(v) = input.get(key) {
            out[key] = v.clone();
        }
    }
    Ok(out)
}
fn receipt(input: &Value) -> Result<Value> {
    let p = &input["request"];
    ensure!(
        id(&p["sessionId"]) && id(&p["requestId"]),
        "Invalid receipt identity"
    );
    ensure!(
        p["revision"]
            .as_u64()
            .is_some_and(|n| n <= 9_007_199_254_740_991),
        "Invalid revision"
    );
    ensure!(
        matches!(
            p["status"].as_str(),
            Some("approved" | "skipped" | "cancelled" | "expired" | "invalidated")
        ),
        "Receipt must be terminal"
    );
    ensure!(
        timestamp(&p["createdAt"]) && timestamp(&p["expiresAt"]) && timestamp(&input["settledAt"]),
        "Invalid receipt timestamp"
    );
    ensure!(
        p["task"].as_str().is_some_and(|s| !s.trim().is_empty()),
        "Missing receipt task"
    );
    // Copy only prompt DTO fields, never provider credentials or request execution state.
    let mut request = json!({});
    for key in [
        "sessionId",
        "requestId",
        "revision",
        "status",
        "createdAt",
        "expiresAt",
        "task",
        "sessionTitle",
        "projectTitle",
        "projectPath",
        "agentName",
        "description",
        "modelReason",
        "requestedModel",
        "schedulingReason",
    ] {
        if let Some(v) = p.get(key) {
            ensure!(
                matches!(key, "revision") || v.is_string(),
                "Invalid prompt field"
            );
            request[key] = v.clone();
        }
    }
    request["candidate"] = model(&p["candidate"])?;
    let candidates = p["candidates"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing candidates"))?;
    ensure!(
        !candidates.is_empty() && candidates.len() <= 128,
        "Invalid candidates"
    );
    request["candidates"] = Value::Array(candidates.iter().map(model).collect::<Result<Vec<_>>>()?);
    ensure!(
        serde_json::to_vec(&request)?.len() <= 1024 * 1024,
        "Receipt too large"
    );
    Ok(json!({"request":request,"settledAt":input["settledAt"]}))
}
pub fn record(db: &Database, input: &Value) -> Result<Value> {
    let mut incoming = receipt(input)?;
    let mut entries = load(db)?;
    if let Some(index) = entries
        .iter()
        .position(|e| same(&e["request"], &incoming["request"]))
    {
        if entries[index]["request"]["revision"].as_u64()
            >= incoming["request"]["revision"].as_u64()
        {
            return Ok(json!({"ok":true}));
        }
        if let Some(read) = entries[index].get("readAt") {
            incoming["readAt"] = read.clone();
        }
        entries.remove(index);
    }
    entries.push(incoming);
    entries.sort_by(|a, b| b["settledAt"].as_str().cmp(&a["settledAt"].as_str()));
    entries.truncate(KEEP);
    save(db, &entries)?;
    Ok(json!({"ok":true}))
}
pub fn mark_read(db: &Database, input: &Value) -> Result<Value> {
    let Some(object) = input.as_object() else {
        bail!("Invalid receipt identity");
    };
    ensure!(
        object.keys().all(|k| k == "sessionId" || k == "requestId"),
        "Unknown identity field"
    );
    let all = object.is_empty();
    ensure!(
        all || (id(&input["sessionId"]) && id(&input["requestId"])),
        "Both identity parts required"
    );
    let mut entries = load(db)?;
    let stamp = ms_to_ts(now_ms());
    for row in &mut entries {
        if (all || same(&row["request"], input)) && row["readAt"].is_null() {
            row["readAt"] = json!(stamp);
        }
    }
    save(db, &entries)?;
    Ok(json!({"ok":true}))
}
pub fn clear(db: &Database) -> Result<Value> {
    db.kv_delete(NS, KEY)?;
    Ok(json!({"ok":true}))
}

#[cfg(test)]
#[path = "delegation_approval_history_tests.rs"]
mod tests;
