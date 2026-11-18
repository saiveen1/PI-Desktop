//! Targeted mutations of canonical history. RPC callers hold the Host state lock.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditAssistantReply {
    session_id: String,
    message_id: String,
    expected_content: String,
    content: String,
}

/// Edit the last conversational record, not an earlier fragment or a tool carrier.
/// System journal rows and non-message events do not close the editing window.
pub fn edit_assistant_reply(db: &Database, edit: &EditAssistantReply) -> Result<()> {
    let session = edit.session_id.as_str();
    if session.trim().is_empty()
        || edit.message_id.trim().is_empty()
        || edit.content.trim().is_empty()
    {
        return Err(anyhow!(
            "INVALID_PARAMS: sessionId, messageId and content must not be blank"
        ));
    }
    let local = db
        .conn()
        .query_row(
            "SELECT COALESCE(NULLIF(s.source, ''), 'desktop') = 'desktop'
             AND NOT EXISTS(SELECT 1 FROM session_import_origins WHERE session_id = s.id)
             AND NOT EXISTS(SELECT 1 FROM task_runs WHERE session_id = s.id)
         FROM sessions s WHERE s.id = ?1 AND s.deleted_at IS NULL",
            [session],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: session not found"))?;
    if !local || session.starts_with("remote:") || session.starts_with("native-pi:") {
        return Err(anyhow!(
            "PERMISSION_DENIED: only a local Desktop conversation is editable"
        ));
    }
    if crate::session_trash::has_pending_work(db, session)?
        || transcripts::read_inflight(db.data_dir(), session)?.is_some()
    {
        return Err(anyhow!(
            "AGENT_BUSY: settle pending work before editing a reply"
        ));
    }
    let settled = db
        .conn()
        .query_row(
            "SELECT m.role = 'assistant' AND COALESCE(m.streaming, 0) = 0 AND m.is_error = 0
            AND NOT EXISTS(SELECT 1 FROM messages newer WHERE newer.session_id = m.session_id
                 AND newer.seq > m.seq AND newer.role != 'system')
            AND (m.turn_id IS NULL OR EXISTS(SELECT 1 FROM turns t WHERE t.id = m.turn_id
                 AND t.session_id = m.session_id AND t.status = 'completed'))
         FROM messages m WHERE m.session_id = ?1 AND m.id = ?2",
            params![session, edit.message_id],
            |row| row.get::<_, bool>(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: message not found in this session"))?;
    let ineligible = || {
        anyhow!("CONFLICT: only the latest completed top-level assistant text reply is editable")
    };
    if !settled {
        return Err(ineligible());
    }

    let suffix = transcripts::read_closed_message_suffix(db.data_dir(), session, |records| {
        records.iter().any(|r| r.role != "system")
    })?;
    let mut records = dedupe_records(match suffix {
        Some(records) => records,
        None => transcripts::read_transcript(db.data_dir(), session)?,
    });
    let index = records
        .iter()
        .rposition(|r| r.role != "system")
        .ok_or_else(ineligible)?;
    let (record, later) = records[index..].split_first_mut().ok_or_else(ineligible)?;
    let meta = record.meta.as_ref().unwrap_or(&Value::Null);
    if record.id != edit.message_id
        || record.role != "assistant"
        || record.is_error
        || record.tool_name.is_some()
        || !(meta["status"].is_null() || meta["status"] == "complete")
        || [
            "error",
            "parentToolCallId",
            "nestedParentToolCallId",
            "agentName",
            "modelSystem",
            "sessionMessage",
        ]
        .iter()
        .any(|key| !meta[*key].is_null())
    {
        return Err(ineligible());
    }
    let previous = record_index_text(record)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(ineligible)?;
    let blocks = record.blocks.as_array_mut().ok_or_else(ineligible)?;
    // Only known answer shapes are safe to rewrite. Never discard an attachment,
    // tool call, or unknown block just because the display also contains text.
    if blocks.iter().any(|b| match b["type"].as_str() {
        Some("thinking" | "hostedSearch") => false,
        Some("text") => !b["text"].is_string() || b.as_object().is_none_or(|o| o.len() != 2),
        _ => true,
    }) {
        return Err(ineligible());
    }
    if previous != edit.expected_content {
        return Err(anyhow!(
            "CONFLICT: assistant reply changed since it was opened"
        ));
    }
    if previous == edit.content {
        // The file is authoritative if a crash landed between rename and index commit.
        db.conn().execute(
            "UPDATE messages SET text = ?3 WHERE session_id = ?1 AND id = ?2 AND text IS NOT ?3",
            params![session, record.id, edit.content],
        )?;
        return Ok(());
    }
    let mut replaced = false;
    blocks.retain_mut(|block| {
        if block["type"] != "text" {
            return true;
        }
        if replaced {
            return false;
        }
        block["text"] = json!(edit.content);
        replaced = true;
        true
    });
    // Signed provider boundaries describe the original bytes, even for equal-length edits.
    if let Some(meta) = record.meta.as_mut().and_then(Value::as_object_mut) {
        meta.remove("providerReplay");
    }
    let affected = std::iter::once(record.id.as_str())
        .chain(later.iter().map(|r| r.id.as_str()))
        .collect();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "UPDATE messages SET text = ?3 WHERE session_id = ?1 AND id = ?2",
        params![session, record.id, edit.content],
    )?;
    tx.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session, now_ms()],
    )?;
    if !transcripts::update_message_lines(db.data_dir(), session, record, Some(&affected))? {
        return Err(anyhow!("NOT_FOUND: canonical message no longer exists"));
    }
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMessageResult {
    pub ok: bool,
    pub deleted: bool,
    pub deleted_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetractPendingPromptResult {
    pub ok: bool,
    pub retracted: bool,
    pub removed_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

fn not_retracted(reason: &'static str) -> RetractPendingPromptResult {
    RetractPendingPromptResult {
        ok: true,
        retracted: false,
        removed_count: 0,
        reason: Some(reason),
    }
}

pub fn running_turn(db: &Database, session_id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND status='running')",
        params![session_id],
        |row| row.get(0),
    )?)
}

fn message_turn(db: &Database, session_id: &str, message_id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id=?1 AND id=?2",
            params![session_id, message_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn canonical_messages(db: &Database, session_id: &str) -> Result<Vec<UiMessage>> {
    get_session(db, session_id)?
        .map(|detail| detail.messages)
        .ok_or_else(|| anyhow!("NOT_FOUND: session not found"))
}

/// Delete one row, or a user prompt and its replies up to the next user row.
/// A missing target is a successful no-op, including retries after a lost reply.
pub fn delete_message(
    db: &Database,
    session_id: &str,
    message_id: &str,
) -> Result<DeleteMessageResult> {
    let mut messages = canonical_messages(db, session_id)?;
    let Some(start) = messages.iter().position(|message| message.id == message_id) else {
        return Ok(DeleteMessageResult {
            ok: true,
            deleted: false,
            deleted_count: 0,
        });
    };
    if running_turn(db, session_id)? {
        return Err(anyhow!(
            "TURN_RUNNING: cannot delete messages during a running turn"
        ));
    }
    let end = if messages[start].role == "user" {
        messages[start + 1..]
            .iter()
            .position(|message| message.role == "user")
            .map_or(messages.len(), |offset| start + 1 + offset)
    } else {
        start + 1
    };
    let inflight = transcripts::read_inflight(db.data_dir(), session_id)?;
    let mut remove_inflight = inflight.as_ref().is_some_and(|checkpoint| {
        messages[start..end]
            .iter()
            .any(|message| message.id == checkpoint.message.id)
    });
    // An unindexed checkpoint belongs to the deleted prompt too, unless a later
    // steering prompt in the same turn survives the selected user-row range.
    if let Some(turn) = inflight
        .as_ref()
        .and_then(|checkpoint| checkpoint.turn_id.as_deref())
    {
        if messages[start].role == "user"
            && message_turn(db, session_id, &messages[start].id)?.as_deref() == Some(turn)
        {
            let mut surviving_user = false;
            for message in messages[..start]
                .iter()
                .chain(&messages[end..])
                .filter(|m| m.role == "user")
            {
                surviving_user |=
                    message_turn(db, session_id, &message.id)?.as_deref() == Some(turn);
            }
            remove_inflight |= !surviving_user;
        }
    }
    let deleted_count = end - start;
    messages.drain(start..end);
    rewrite_transcript(db, session_id, &messages, &[])?;
    if remove_inflight {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
    }
    Ok(DeleteMessageResult {
        ok: true,
        deleted: true,
        deleted_count,
    })
}

fn substantive_reply(message: &UiMessage) -> bool {
    // The per-turn model system snapshot is request state, not reply content.
    if message.role == "system" && message.model_system.is_some() {
        return false;
    }
    message.role != "assistant"
        || !message.content.trim().is_empty()
        || message
            .thinking
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || message.tool_name.is_some()
        || message.tool_call_id.is_some()
        || message.tool_args.is_some()
        || message.tool_result.is_some()
        || message.hosted_search.is_some()
}

/// Retract exactly the named last pending prompt after its turn has stopped.
/// Durable attribution and checkpoints are checked before any history is changed.
pub fn retract_pending_prompt(
    db: &Database,
    session_id: &str,
    user_message_id: &str,
    turn_id: Option<&str>,
) -> Result<RetractPendingPromptResult> {
    let messages = canonical_messages(db, session_id)?;
    let Some(start) = messages
        .iter()
        .position(|message| message.id == user_message_id)
    else {
        return Ok(not_retracted("message_not_found"));
    };
    let prompt = &messages[start];
    if prompt.role != "user"
        || messages[start + 1..]
            .iter()
            .any(|message| message.role == "user")
    {
        return Ok(not_retracted("not_final_user_prompt"));
    }
    if prompt.steering == Some(true) {
        return Ok(not_retracted("steering_prompt"));
    }
    if running_turn(db, session_id)? {
        return Ok(not_retracted("turn_running"));
    }
    let Some(owner) = message_turn(db, session_id, user_message_id)? else {
        return Ok(not_retracted("turn_not_found"));
    };
    if turn_id.is_some_and(|expected| expected != owner) {
        return Ok(not_retracted("turn_mismatch"));
    }
    let known: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND id=?2)",
        params![session_id, owner],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(not_retracted("turn_not_found"));
    }
    // Row order disambiguates turns created within the same millisecond.
    let latest: String = db.conn().query_row(
        "SELECT id FROM turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
        params![session_id],
        |row| row.get(0),
    )?;
    if latest != owner {
        return Ok(not_retracted("turn_mismatch"));
    }
    for message in &messages[start + 1..] {
        if substantive_reply(message) {
            return Ok(not_retracted("reply_started"));
        }
        if message_turn(db, session_id, &message.id)?.as_deref() != Some(owner.as_str()) {
            return Ok(not_retracted("turn_mismatch"));
        }
    }
    let inflight = transcripts::read_inflight(db.data_dir(), session_id)?;
    if let Some(checkpoint) = &inflight {
        if checkpoint.turn_id.as_deref() != Some(owner.as_str()) {
            return Ok(not_retracted("turn_mismatch"));
        }
        if substantive_reply(&record_to_ui(checkpoint.message.clone())) {
            return Ok(not_retracted("reply_started"));
        }
    }
    rewrite_transcript(db, session_id, &messages[..start], &[])?;
    if inflight.is_some() {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
    }
    Ok(RetractPendingPromptResult {
        ok: true,
        retracted: true,
        removed_count: messages.len() - start,
        reason: None,
    })
}

/// Opt-in revision activation that never trusts an uploaded or absent prefix.
/// The legacy activation API keeps its explicit-prefix behavior unchanged.
pub fn activate_message_revision_canonical(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
) -> Result<Vec<UiMessage>> {
    if running_turn(db, session_id)? {
        return Err(anyhow!(
            "TURN_RUNNING: cannot activate a revision during a running turn"
        ));
    }
    activate_message_revision_with_prefix(db, session_id, root_user_id, revision_index, None)
}
