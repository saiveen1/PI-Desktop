//! Read-only projection of canonical Task results, never an execution ledger.
use crate::{
    db::{ms_to_ts, Database},
    sessions, transcripts,
};
use anyhow::Result;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
const TEXT_LIMIT: usize = 32768;
#[path = "delegation_history_observation.rs"]
mod observation;
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    pub status: Option<String>,
    pub project_path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_session_id")]
    pub session_id: Option<String>,
}
fn deserialize_session_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
struct Candidate {
    id: String,
    session: String,
    title: String,
    path: Option<String>,
    project: Option<String>,
    turn_status: Option<String>,
    ended: Option<i64>,
}
fn stamp(v: &Value) -> Option<String> {
    if let Some(ms) = v.as_i64() {
        return chrono::DateTime::from_timestamp_millis(ms)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    v.as_str().and_then(normalize_stamp)
}
fn normalize_stamp(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|d| {
        d.to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}
/// Match JavaScript string-length bounds without splitting a surrogate pair.
fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|ch| {
            used += ch.len_utf16();
            used <= limit
        })
        .collect()
}
fn bounded(out: &mut Value, key: &str, value: &str, flag: Option<&str>) {
    let limit = match key {
        "agentName" => 1024,
        "sessionTitle" | "projectPath" => 4096,
        _ => TEXT_LIMIT,
    };
    let text = truncate_utf16(value, limit);
    if let Some(flag) = flag {
        if text.len() < value.len() {
            out[flag] = json!(true);
        }
    }
    out[key] = json!(text);
}
fn project(c: &Candidate, message: &sessions::UiMessage) -> Option<Value> {
    let result = message.tool_result.as_ref()?;
    let parsed;
    let result = if let Some(s) = result.as_str() {
        parsed = serde_json::from_str::<Value>(s).ok()?;
        &parsed
    } else {
        result
    };
    let details = result.get("details").unwrap_or(result);
    let delegation = details["delegationId"].as_str()?;
    let original = details["status"].as_str()?;
    if !matches!(
        original,
        "running" | "completed" | "failed" | "stopped" | "aborted" | "timed_out" | "interrupted"
    ) {
        return None;
    }
    // Missing owner also cannot prove a legacy delegate is currently active.
    let status = if original == "running" && c.turn_status.as_deref() != Some("running") {
        "interrupted"
    } else {
        original
    };
    let args = message.tool_args.as_ref().unwrap_or(&Value::Null);
    let started = stamp(&details["startedAt"]);
    let mut out = json!({"id":format!("{}:{}",c.session,c.id),"sessionId":c.session,"sessionTitle":c.title,
        "projectPath":c.path,"delegationId":delegation,"messageId":c.id,"status":status,
        "createdAt":started.as_deref().unwrap_or(&message.created_at)});
    if let Some(started) = started {
        out["startedAt"] = json!(started);
    }
    let count = |v: &Value| v.as_u64().filter(|n| *n <= 9_007_199_254_740_991);
    for key in ["turns", "toolCalls"] {
        if let Some(value) = count(&details[key]) {
            out[key] = json!(value);
        }
    }
    if let (Some(input), Some(output), Some(total)) = (
        count(&details["usage"]["inputTokens"]),
        count(&details["usage"]["outputTokens"]),
        count(&details["usage"]["totalTokens"]),
    ) {
        out["usage"] = json!({"inputTokens":input,"outputTokens":output,"totalTokens":total});
    }
    if let Some(value) = observation::project(&details["observation"]) {
        out["observation"] = value;
    }
    bounded(&mut out, "sessionTitle", &c.title, None);
    if let Some(title) = &c.project {
        bounded(&mut out, "projectTitle", title, None);
    }
    bounded(
        &mut out,
        "agentName",
        details["agent"]
            .as_str()
            .or_else(|| args["agent"].as_str())
            .unwrap_or(""),
        None,
    );
    bounded(
        &mut out,
        "description",
        args["description"]
            .as_str()
            .or_else(|| details["summary"].as_str())
            .unwrap_or(""),
        None,
    );
    bounded(
        &mut out,
        "task",
        args["task"].as_str().unwrap_or(""),
        Some("taskTruncated"),
    );
    if let Some(report) = details["report"].as_str() {
        bounded(&mut out, "report", report, Some("reportTruncated"));
    }
    let scheduling = details.get("scheduling").unwrap_or(&Value::Null);
    for (key, source) in [
        ("modelId", &details["modelId"]),
        (
            "modelReason",
            scheduling
                .get("modelReason")
                .or(args.get("reason"))
                .unwrap_or(&Value::Null),
        ),
        (
            "requestedModel",
            scheduling
                .get("requestedModel")
                .or(args.get("model"))
                .unwrap_or(&Value::Null),
        ),
    ] {
        if let Some(text) = source.as_str() {
            bounded(&mut out, key, text, None);
        }
    }
    // The run's own recorded effective level, allowlisted so an unknown token
    // can never reach the typed shared entry. Legacy rows recorded none and
    // stay absent rather than inheriting current settings.
    if let Some(level) = details["thinkingLevel"]
        .as_str()
        .filter(|level| sessions::is_valid_thinking_level(level))
    {
        out["thinkingLevel"] = json!(level);
    }
    let completed = stamp(&details["completedAt"]).or_else(|| {
        if status == "interrupted" {
            c.ended.map(ms_to_ts)
        } else {
            None
        }
    });
    if let Some(completed) = completed {
        out["completedAt"] = json!(completed);
    }
    if let (Some(code), Some(message)) = (
        details["error"]["code"].as_str(),
        details["error"]["message"].as_str(),
    ) {
        out["error"] =
            json!({"code":truncate_utf16(code, 256),"message":truncate_utf16(message, TEXT_LIMIT)});
    }
    Some(out)
}

const STEERING_SKIP: &str = "Skipped because new user input is waiting.";

fn trim_js(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

fn identity(value: &str) -> bool {
    !value.is_empty() && trim_js(value) == value && value.encode_utf16().count() <= 256
}

fn attempt_result(result: &Value) -> Option<(&str, Option<&str>)> {
    if let Some(text) = result.as_str() {
        return Some((text, None));
    }
    let envelope = result.as_object()?;
    if !envelope
        .keys()
        .all(|key| matches!(key.as_str(), "content" | "details" | "isError"))
    {
        return None;
    }
    let Some(content) = envelope.get("content") else {
        let details = envelope.get("details")?.as_object()?;
        let error = details.get("error")?.as_str()?;
        // Only the old details-only unknown-resume result; the caller checks the target.
        return (envelope.len() == 1
            && details.len() == 1
            && error.starts_with("Unknown delegation \""))
        .then_some((error, None));
    };
    let [block] = content.as_array()?.as_slice() else {
        return None;
    };
    let text = block["text"].as_str()?;
    if block["type"] != "text" || text.is_empty() {
        return None;
    }
    let Some(details) = envelope.get("details") else {
        return Some((text, None));
    };
    let details = details.as_object()?;
    if details.is_empty() {
        return Some((text, None));
    }
    // Runtime duplicates the error text in details and spreads metadata.code
    // beside it. Any other field (including delegationId) is not this receipt.
    if details.get("error").and_then(Value::as_str) != Some(text) {
        return None;
    }
    match (details.len(), details.get("code")) {
        (1, None) => Some((text, None)),
        (2, Some(code)) => Some((text, Some(code.as_str()?))),
        _ => None,
    }
}

fn project_attempt(message: &sessions::UiMessage) -> Option<Value> {
    let failed = match message.tool_status.as_deref() {
        Some("error") => true,
        None => message.is_error == Some(true),
        _ => false,
    };
    if !failed
        || message.role != "tool"
        || message.tool_name.as_deref() != Some("Task")
        || message.parent_tool_call_id.is_some()
        || message.nested_parent_tool_call_id.is_some()
        || !identity(&message.id)
        || !matches!(message.status.as_deref(), None | Some("complete" | "error"))
    {
        return None;
    }
    let (text, code) = attempt_result(message.tool_result.as_ref()?)?;
    let args = message.tool_args.as_ref().unwrap_or(&Value::Null);
    let resume = args["resume"]
        .as_str()
        .map(trim_js)
        .filter(|id| !id.is_empty());
    let (outcome, reason) = match code {
        Some("DELEGATION_RESUME_NOT_RETAINED") if resume.is_some() => {
            ("rejected", "Resume chain no longer retained.")
        }
        Some("DELEGATION_RESUME_UNKNOWN") if resume.is_some() => {
            ("rejected", "Unknown delegation.")
        }
        Some(_) => return None,
        None if text == STEERING_SKIP => ("skipped", STEERING_SKIP),
        None => {
            let suffix = text
                .strip_prefix("Unknown delegation \"")?
                .strip_prefix(resume?)?
                .strip_prefix("\".")?;
            if !matches!(
                suffix,
                "" | " No reusable subagent sessions in this conversation."
            ) && !suffix.starts_with(" Reusable: ")
            {
                return None;
            }
            // Do not forward the reusable-chain list or interpolate arbitrary text.
            ("rejected", "Unknown delegation.")
        }
    };
    let mut out = json!({
        "messageId": message.id, "createdAt": normalize_stamp(&message.created_at)?,
        "outcome": outcome, "reason": reason,
    });
    if let Some(call) = message.tool_call_id.as_deref().filter(|id| identity(id)) {
        out["toolCallId"] = json!(call);
    }
    if let Some(resume) = resume.filter(|id| identity(id)) {
        out["resume"] = json!(resume);
    }
    for (key, source, limit) in [
        ("agentName", "agent", 1024),
        ("description", "description", 4096),
        ("task", "task", 4096),
    ] {
        if let Some(text) = args[source].as_str() {
            out[key] = json!(truncate_utf16(text, limit));
        }
    }
    Some(out)
}

/// Renderer-supplied filters are rejected before any query work begins.
pub fn check(query: &Query) -> std::result::Result<(), &'static str> {
    if query.offset.unwrap_or(0) > 9_007_199_254_740_991
        || !(1..=100).contains(&query.limit.unwrap_or(50))
        || !matches!(
            query.status.as_deref().unwrap_or("all"),
            "all" | "running" | "ended"
        )
    {
        return Err("Invalid history pagination or status");
    }
    if query
        .project_path
        .as_ref()
        .is_some_and(|path| path.is_empty() || path.trim() != path || path.len() > 4096)
    {
        return Err("Invalid project path");
    }
    if query.session_id.as_deref().is_some_and(|id| !identity(id)) {
        return Err("Invalid session id");
    }
    Ok(())
}
pub fn list(db: &Database, query: Query) -> Result<Value> {
    check(&query).map_err(anyhow::Error::msg)?;
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(50);
    let status = query.status.as_deref().unwrap_or("all");
    let path = query
        .project_path
        .as_deref()
        .and_then(crate::db::normalize_project_path);
    // Session scope selects candidates before pagination; other filters retain
    // their existing post-window semantics, including deleted sessions.
    let mut stmt = db.conn().prepare_cached(
        "SELECT m.id,m.session_id,s.title,p.path,p.name,t.status,t.ended_at
        FROM messages m INDEXED BY idx_messages_task_history
        JOIN sessions s ON s.id=m.session_id LEFT JOIN projects p ON p.id=s.project_id
        LEFT JOIN turns t ON t.id=m.turn_id
        WHERE m.tool_name='Task' AND (?3 IS NULL OR m.session_id=?3)
        ORDER BY m.created_at DESC,m.mid DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(
            params![(limit + 1) as i64, offset as i64, query.session_id],
            |r| {
                Ok(Candidate {
                    id: r.get(0)?,
                    session: r.get(1)?,
                    title: r.get(2)?,
                    path: r.get(3)?,
                    project: r.get(4)?,
                    turn_status: r.get(5)?,
                    ended: r.get(6)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > limit as usize;
    let include_attempts = query.session_id.is_some() && status != "running";
    let mut entries = Vec::new();
    let mut attempts = Vec::new();
    for c in rows.into_iter().take(limit as usize) {
        let visible: bool = db.conn().query_row(
            "SELECT deleted_at IS NULL FROM sessions WHERE id=?1",
            [&c.session],
            |r| r.get(0),
        )?;
        if !visible || path.as_ref().is_some_and(|p| c.path.as_ref() != Some(p)) {
            continue;
        }
        let layout = sessions::session_layout(db, &c.session)?;
        let Some(position) =
            transcripts::find_message_position(db.data_dir(), &c.session, &layout, &c.id)?
        else {
            continue;
        };
        let read = transcripts::read_transcript_window_with_layout(
            db.data_dir(),
            &c.session,
            &layout,
            position,
            Some(1),
        )?;
        if let Some(record) = read.messages.into_iter().find(|r| r.id == c.id) {
            let message = sessions::record_to_ui(record);
            if let Some(entry) = project(&c, &message) {
                if status == "all" || (status == "running") == (entry["status"] == "running") {
                    entries.push(entry);
                }
            } else if include_attempts {
                attempts.extend(project_attempt(&message));
            }
        }
    }
    let mut page = json!({"entries":entries,"nextOffset":more.then_some(offset + limit)});
    if !attempts.is_empty() {
        page["attempts"] = json!(attempts);
    }
    Ok(page)
}
#[cfg(test)]
#[path = "delegation_history_tests.rs"]
mod tests;
