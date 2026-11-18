//! Final-answer edits and reversible, current-turn thinking-context choices.
use super::*;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ThinkingContext {
    Reply,
    Turn,
    Keep,
}

fn deserialize_thinking_context<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ThinkingContext>, D::Error> {
    ThinkingContext::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditAssistantReply {
    pub(super) session_id: String,
    pub(super) message_id: String,
    pub(super) expected_content: String,
    pub(super) content: String,
    #[serde(default, deserialize_with = "deserialize_thinking_context")]
    pub(super) thinking_context: Option<ThinkingContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingContextUpdate {
    message_id: String,
    exclude_thinking_from_context: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAssistantReplyResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_context_updates: Option<Vec<ThinkingContextUpdate>>,
}

fn top_level(record: &MessageRecord) -> bool {
    let meta = record.meta.as_ref().unwrap_or(&Value::Null);
    record.tool_name.is_none()
        && [
            "parentToolCallId",
            "nestedParentToolCallId",
            "agentName",
            "modelSystem",
            "sessionMessage",
        ]
        .iter()
        .all(|key| meta[*key].is_null())
}

fn user_boundary(record: &MessageRecord) -> bool {
    record.role == "user"
        && top_level(record)
        && record
            .meta
            .as_ref()
            .is_none_or(|meta| meta["steering"] != true)
}

/// Edit the last conversational record, not an earlier fragment or a tool carrier.
/// System journal rows and non-message events do not close the editing window.
pub fn edit_assistant_reply(
    db: &Database,
    edit: &EditAssistantReply,
) -> Result<EditAssistantReplyResult> {
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

    // Durable ownership wins over prompt-shaped rows. Manual forks have no turn IDs.
    let turn_rows = if edit.thinking_context.is_some() {
        if let Some(turn) = message_turn(db, session, &edit.message_id)? {
            Some(
                db.conn()
                    .prepare(
                        "SELECT id FROM messages WHERE session_id=?1 AND turn_id=?2 ORDER BY seq",
                    )?
                    .query_map(params![session, turn], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let whole_turn = edit.thinking_context.is_some();
    let suffix = transcripts::read_closed_message_suffix(db.data_dir(), session, |records| {
        if !whole_turn {
            records.iter().any(|r| r.role != "system")
        } else if let Some(ids) = &turn_rows {
            records.iter().any(|r| ids.first() == Some(&r.id))
        } else {
            records.iter().any(user_boundary)
        }
    })?;
    let mut records = dedupe_records(match suffix {
        Some(records) => records,
        None => transcripts::read_transcript(db.data_dir(), session)?,
    });
    let index = records
        .iter()
        .rposition(|r| r.role != "system")
        .ok_or_else(ineligible)?;
    let record = &mut records[index];
    let meta = record.meta.as_ref().unwrap_or(&Value::Null);
    if record.id != edit.message_id
        || record.role != "assistant"
        || record.is_error
        || !top_level(record)
        || !(meta["status"].is_null() || meta["status"] == "complete")
        || !meta["error"].is_null()
    {
        return Err(ineligible());
    }
    let previous = record_index_text(record)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(ineligible)?;
    let blocks = record.blocks.as_array_mut().ok_or_else(ineligible)?;
    // Never discard attachments, tool calls or unknown blocks during a text edit.
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
    let text_changed = previous != edit.content;
    if text_changed {
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
    }

    let mut changed = std::collections::BTreeSet::new();
    if text_changed {
        changed.insert(index);
    }
    let mut updates = edit.thinking_context.map(|_| Vec::new());
    if let Some(mode) = edit.thinking_context {
        let start = records[..=index]
            .iter()
            .rposition(user_boundary)
            .unwrap_or(0);
        let owned: Option<std::collections::HashSet<&str>> = turn_rows
            .as_ref()
            .map(|ids| ids.iter().map(String::as_str).collect());
        for (i, row) in records[..=index].iter_mut().enumerate() {
            let belongs = owned
                .as_ref()
                .map_or(i >= start, |ids| ids.contains(row.id.as_str()));
            if !belongs || row.role != "assistant" || !top_level(row) {
                continue;
            }
            let excluded =
                mode == ThinkingContext::Turn || (mode == ThinkingContext::Reply && i == index);
            let has_thinking = row
                .blocks
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "thinking"))
                || row
                    .meta
                    .as_ref()
                    .and_then(|meta| meta["providerReplay"]["blocks"].as_array())
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "thinking"));
            if excluded && !has_thinking {
                continue;
            }
            let was_excluded = row
                .meta
                .as_ref()
                .is_some_and(|meta| meta["excludeThinkingFromContext"] == true);
            if was_excluded == excluded {
                continue;
            }
            let meta = row
                .meta
                .get_or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| anyhow!("invalid message metadata"))?;
            meta.insert("excludeThinkingFromContext".into(), json!(excluded));
            changed.insert(i);
            if let Some(updates) = updates.as_mut() {
                updates.push(ThinkingContextUpdate {
                    message_id: row.id.clone(),
                    exclude_thinking_from_context: excluded,
                });
            }
        }
    }
    // Only changed text loses its signed replay boundaries, after detecting opaque reasoning.
    if text_changed {
        if let Some(meta) = records[index].meta.as_mut().and_then(Value::as_object_mut) {
            meta.remove("providerReplay");
        }
    }
    let result = EditAssistantReplyResult {
        ok: true,
        thinking_context_updates: updates,
    };
    let Some(&earliest) = changed.first() else {
        // Repair a lagging index after a crash between canonical rename and commit.
        db.conn().execute(
            "UPDATE messages SET text = ?3 WHERE session_id = ?1 AND id = ?2 AND text IS NOT ?3",
            params![session, edit.message_id, edit.content],
        )?;
        return Ok(result);
    };
    let affected = records[earliest..].iter().map(|r| r.id.as_str()).collect();
    let replacements: Vec<_> = changed.into_iter().map(|i| &records[i]).collect();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "UPDATE messages SET text = ?3 WHERE session_id = ?1 AND id = ?2",
        params![session, edit.message_id, edit.content],
    )?;
    tx.execute(
        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
        params![session, now_ms()],
    )?;
    if !transcripts::update_messages_lines(db.data_dir(), session, &replacements, Some(&affected))?
    {
        return Err(anyhow!("NOT_FOUND: canonical message no longer exists"));
    }
    tx.commit()?;
    Ok(result)
}
