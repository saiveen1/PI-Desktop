//! Metadata-only refreshes for a settled main assistant message.
use super::{
    indexed_message_record, record_is_streaming, transcripts, Database, Result, UiMessage,
};
use rusqlite::params;
use serde_json::{Map, Value};

fn valid_observer(value: &Value, message_id: &str) -> bool {
    let mode = value["mode"].as_str();
    value["messageId"].as_str() == Some(message_id)
        && matches!(mode, Some("observe" | "endless" | "guard"))
        && matches!(
            value["status"].as_str(),
            Some("checking" | "assessed" | "error" | "skipped")
        )
        && value["startedAt"].as_i64().is_some()
        && value
            .get("decision")
            .is_none_or(|field| matches!(field.as_str(), Some("continue" | "stop")))
        && value
            .get("continuationCount")
            .is_none_or(|field| field.as_u64().is_some())
        && value.get("maxContinuations").is_none_or(|field| {
            field
                .as_u64()
                .is_some_and(|count| (1..=100).contains(&count))
        })
        && value.get("endlessRecoveriesUsed").is_none_or(|field| {
            matches!(mode, Some("guard" | "endless"))
                && field.as_u64().is_some_and(|used| {
                    used > 0
                        && value["maxContinuations"]
                            .as_u64()
                            .is_some_and(|max| used <= max)
                })
        })
        && (mode != Some("endless")
            || [
                "modelKey",
                "thinkingLevel",
                "effort",
                "usage",
                "verdict",
                "confidence",
            ]
            .iter()
            .all(|key| value.get(*key).is_none()))
}

pub(super) fn refresh(
    db: &Database,
    session_id: &str,
    message: &UiMessage,
    turn_id: Option<&str>,
    diagnostics: &Value,
) -> Result<()> {
    let Some(turn_id) = turn_id else {
        return Ok(());
    };
    let observer = diagnostics.get("observer");
    let ended_at = diagnostics.get("endedAt");
    if diagnostics["refreshOnly"] != true
        || message.role != "assistant"
        || !message.content.is_empty()
        || diagnostics["turnId"].as_str() != Some(turn_id)
        || diagnostics["startedAt"].as_i64().is_none()
        || (observer.is_none() && ended_at.is_none())
        || ended_at.is_some_and(|end| end.as_i64().is_none())
        || observer.is_some_and(|value| !valid_observer(value, &message.id))
        || diagnostics
            .get("termination")
            .is_some_and(|value| value["messageId"].as_str() != Some(message.id.as_str()))
    {
        return Ok(());
    }
    let patch = serde_json::to_value(message)?;
    if patch.as_object().is_none_or(|fields| {
        fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "id" | "role" | "content" | "createdAt" | "runDiagnostics"
            )
        })
    }) {
        return Ok(());
    }
    let owned: bool = db
        .conn()
        .prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM messages m
         JOIN turns t ON t.id = m.turn_id AND t.session_id = m.session_id
         JOIN sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
         WHERE m.id = ?1 AND m.session_id = ?2 AND m.turn_id = ?3
           AND m.role = 'assistant' AND m.streaming IS NOT 1)",
        )?
        .query_row(params![message.id, session_id, turn_id], |row| row.get(0))?;
    if !owned {
        return Ok(());
    }
    let Some(mut row) = indexed_message_record(db, session_id, &message.id)? else {
        return Ok(());
    };
    if row.role != "assistant" || row.created_at != message.created_at || record_is_streaming(&row)
    {
        return Ok(());
    }
    let Some(meta) = row
        .meta
        .get_or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        return Ok(());
    };
    if ["parentToolCallId", "nestedParentToolCallId", "agentName"]
        .iter()
        .any(|key| meta.contains_key(*key))
    {
        return Ok(());
    }

    let Some(mut next) = diagnostics.as_object().cloned() else {
        return Ok(());
    };
    next.remove("refreshOnly");
    if let Some(previous) = meta.get("runDiagnostics") {
        if previous
            .get("turnId")
            .is_some_and(|id| id != &next["turnId"])
            || previous
                .get("startedAt")
                .is_some_and(|start| start != &next["startedAt"])
            || previous["endedAt"].as_i64().is_some()
        {
            return Ok(());
        }
        if let Some(old_observer) = previous.get("observer") {
            match observer {
                Some(value) if old_observer["status"] != "checking" && value != old_observer => {
                    return Ok(())
                }
                None => {
                    next.insert("observer".into(), old_observer.clone());
                }
                _ => {}
            }
        }
        if previous.as_object() == Some(&next) {
            return Ok(());
        }
    }
    meta.insert("runDiagnostics".into(), Value::Object(next));
    if !transcripts::update_message(db.data_dir(), session_id, &row)? {
        return Err(anyhow::anyhow!(
            "settled diagnostic target is missing from its transcript"
        ));
    }
    Ok(())
}
