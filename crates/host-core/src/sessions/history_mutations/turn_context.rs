//! Model-context overlays for settled turns; the execution journal is read-only.
use super::assistant_edit::{load_editable_turn, top_level, EditableTurn, MissingAnchor};
use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_MESSAGES: usize = 1024;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const OVERRIDE: &str = "contextOverride";
const LEGACY: &str = "excludeThinkingFromContext";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetTurnContext {
    session_id: String,
    anchor_message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextEdit {
    message_id: String,
    context_override: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditTurnContext {
    session_id: String,
    anchor_message_id: String,
    expected_revision: String,
    edits: Vec<ContextEdit>,
    #[serde(default)]
    restore: bool,
    #[serde(default)]
    exclude_history_thinking: bool,
    exclude_previous_turns: Option<bool>,
}

fn invalid(message: &str) -> anyhow::Error {
    anyhow!("INVALID_PARAMS: {message}")
}

fn size_limit() -> anyhow::Error {
    anyhow!("LIMIT_EXCEEDED: turn context exceeds 1024 rows or 8 MiB")
}

fn eligible(row: &MessageRecord) -> bool {
    matches!(row.role.as_str(), "assistant" | "tool") && top_level(row)
}

fn blocks(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn tool_block(row: &MessageRecord) -> Option<&Value> {
    blocks(&row.blocks).find(|block| block["type"] == "tool_call")
}

fn content(row: &MessageRecord) -> String {
    if row.role == "tool" {
        tool_block(row)
            .and_then(|block| block["text"].as_str())
            .unwrap_or_default()
            .to_owned()
    } else {
        record_index_text(row).unwrap_or_default()
    }
}

fn meta(row: &MessageRecord) -> &Value {
    row.meta.as_ref().unwrap_or(&Value::Null)
}

fn source_thinking(row: &MessageRecord) -> bool {
    blocks(&row.blocks)
        .chain(blocks(&meta(row)["providerReplay"]["blocks"]))
        .any(|block| block["type"] == "thinking")
}

fn history_thinking(row: &MessageRecord, overlay: &Value) -> bool {
    row.role == "assistant"
        && top_level(row)
        && (source_thinking(row) || overlay["thinking"].is_string())
}

fn validate_override(row: &MessageRecord, overlay: &Value) -> Result<()> {
    if overlay.is_null() {
        return Ok(());
    }
    let fields = overlay
        .as_object()
        .ok_or_else(|| invalid("contextOverride must be a version 1 object or null"))?;
    if overlay["version"].as_u64() != Some(1) {
        return Err(invalid("contextOverride.version must be 1"));
    }
    if row.role == "tool"
        && tool_block(row)
            .and_then(|block| block.get("args"))
            .is_some_and(|args| !args.is_object())
    {
        return Err(invalid(
            "a tool with non-object original arguments is read-only",
        ));
    }
    for (key, value) in fields {
        let valid = match (row.role.as_str(), key.as_str()) {
            (_, "version") => true,
            ("assistant", "content" | "thinking") | ("tool", "toolResultText") => value.is_string(),
            ("assistant", "excludeContent" | "excludeThinking") | ("tool", "excludeTool") => {
                value.is_boolean()
            }
            ("tool", "toolArgs") => value.is_object(),
            _ => false,
        };
        if !valid {
            return Err(invalid(
                "unknown or invalid contextOverride field for this role",
            ));
        }
    }
    Ok(())
}

fn revision(db: &Database, turn: &EditableTurn, session: &str, anchor: &str) -> Result<String> {
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(
        session,
        anchor,
        &turn.owner,
        turn.is_latest,
    ))?);
    // A tail draft can opt into a wider write. Bind it to the live file's
    // generation without decoding prior turns just to open the editor.
    if turn.is_latest {
        digest.update(transcripts::history_generation(db.data_dir(), session)?);
    }
    // Include every owned row, even those not editable, and its original blocks and open metadata.
    for &i in &turn.members {
        digest.update(b"\n");
        digest.update(serde_json::to_vec(&turn.records[i])?);
    }
    Ok(hex::encode(digest.finalize()))
}

const OMITTED_MEDIA: &str = "[binary media omitted from editor]";

fn media_kind(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    matches!(
        value.as_str(),
        "image" | "audio" | "input_image" | "input_audio" | "image_url" | "audio_url"
    ) || value.starts_with("image/")
        || value.starts_with("audio/")
}

fn redact_data_urls(text: &str) -> String {
    let mut result = String::with_capacity(text.len().min(1024));
    let mut rest = text;
    while let Some(pos) = rest.find("data:") {
        let candidate = &rest[pos..];
        let Some(comma) = candidate.find(',') else {
            break;
        };
        let header = &candidate[5..comma];
        let mime = header.split(';').next().unwrap_or_default();
        if !media_kind(mime)
            || !header
                .split(';')
                .any(|part| part.eq_ignore_ascii_case("base64"))
        {
            result.push_str(&rest[..pos + 5]);
            rest = &rest[pos + 5..];
            continue;
        }
        result.push_str(&rest[..pos]);
        result.push_str(OMITTED_MEDIA);
        let payload = &candidate[comma + 1..];
        let end = payload
            .bytes()
            .position(|b| {
                !(b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
            })
            .unwrap_or(payload.len());
        rest = &payload[end..];
    }
    result.push_str(rest);
    result
}

fn readable_result(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_data_urls(text)),
        Value::Array(items) => Value::Array(items.iter().map(readable_result).collect()),
        Value::Object(fields) => {
            let media = ["type", "kind", "mimeType", "mime_type", "media_type"]
                .iter()
                .any(|key| {
                    fields
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(media_kind)
                });
            Value::Object(
                fields
                    .iter()
                    .map(|(key, value)| {
                        let projected = if media
                            && matches!(key.as_str(), "data" | "base64" | "blob")
                            && value.is_string()
                        {
                            json!(OMITTED_MEDIA)
                        } else {
                            readable_result(value)
                        };
                        (key.clone(), projected)
                    })
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn project(row: &MessageRecord, final_answer: bool) -> Result<Value> {
    let thinking_blocks: Vec<_> = blocks(&row.blocks)
        .filter(|block| block["type"] == "thinking")
        .collect();
    let metadata = meta(row);
    let mut message = json!({
        "messageId": row.id, "role": row.role, "final": final_answer, "content": content(row),
        "hasThinking": source_thinking(row),
    });
    let visible: Vec<_> = thinking_blocks
        .iter()
        .filter_map(|block| block["text"].as_str())
        .collect();
    if !visible.is_empty() {
        message["thinking"] = json!(visible.concat());
    }
    if let Some(overlay) = metadata.get(OVERRIDE).filter(|value| !value.is_null()) {
        message["override"] = overlay.clone();
    }
    if let Some(legacy) = metadata[LEGACY].as_bool() {
        message["legacyExcludeThinking"] = json!(legacy);
    }
    if row.role == "tool" {
        let block = tool_block(row).unwrap_or(&Value::Null);
        if let Some(name) = row.tool_name.as_deref().or_else(|| block["name"].as_str()) {
            message["toolName"] = json!(name);
        }
        if let Some(args) = block.get("args").filter(|args| args.is_object()) {
            message["toolArgs"] = args.clone();
        }
        if let Some(result) = block.get("result") {
            let readable = readable_result(result);
            message["toolResultText"] = match readable.as_str() {
                Some(text) => json!(text),
                None => json!(serde_json::to_string_pretty(&readable)?),
            };
        }
    }
    Ok(message)
}

fn load_turn(db: &Database, session: &str, anchor: &str) -> Result<EditableTurn> {
    let turn = load_editable_turn(db, session, anchor, false)?;
    if content(&turn.records[turn.anchor]).trim().is_empty() {
        return Err(anyhow!(
            "CONFLICT: the selected assistant reply has no final text"
        ));
    }
    Ok(turn)
}

/// The bounded loader returns an id-closed suffix of the canonical records.
/// Only expand that suffix once a bulk save has passed its revision check.
fn include_history(db: &Database, session: &str, turn: &mut EditableTurn) -> Result<()> {
    let records = dedupe_records(transcripts::read_transcript(db.data_dir(), session)?);
    let prefix = records
        .len()
        .checked_sub(turn.records.len())
        .filter(|&n| {
            records[n..]
                .iter()
                .zip(&turn.records)
                .all(|(a, b)| a.id == b.id)
        })
        .ok_or_else(|| anyhow!("CONFLICT: canonical history changed"))?;
    turn.anchor += prefix;
    for index in &mut turn.members {
        *index += prefix;
    }
    turn.records = records;
    Ok(())
}
fn prompt(turn: &EditableTurn) -> Option<usize> {
    turn.members
        .iter()
        .copied()
        .find(|&i| i < turn.anchor && turn.records[i].user_prompt())
}

fn snapshot(turn: &EditableTurn, session: &str, anchor: &str, revision: &str) -> Result<Value> {
    let mut snapshot = json!({
        "sessionId": session, "anchorMessageId": anchor, "revision": revision, "messages": [],
        "isLatestTurn": turn.is_latest,
        "excludePreviousTurns": prompt(turn).is_some_and(|i| turn.records[i].marks_context_boundary()),
    });
    let mut size = serde_json::to_vec(&snapshot)?.len();
    let mut messages = Vec::new();
    for &i in &turn.members {
        let row = &turn.records[i];
        if !eligible(row) {
            continue;
        }
        if messages.len() == MAX_MESSAGES {
            return Err(size_limit());
        }
        let message = project(row, i == turn.anchor)?;
        size += serde_json::to_vec(&message)?.len() + usize::from(!messages.is_empty());
        if size > MAX_SNAPSHOT_BYTES {
            return Err(size_limit());
        }
        messages.push(message);
    }
    snapshot["messages"] = Value::Array(messages);
    Ok(snapshot)
}

pub fn get_turn_context(db: &Database, request: &GetTurnContext) -> Result<Value> {
    let session = &request.session_id;
    let anchor = &request.anchor_message_id;
    let turn = load_turn(db, session, anchor)?;
    let revision = revision(db, &turn, session, anchor)?;
    Ok(json!({"snapshot": snapshot(&turn, session, anchor, &revision)?}))
}

pub fn edit_turn_context(db: &Database, request: &EditTurnContext) -> Result<Value> {
    if request.expected_revision.trim().is_empty()
        || (request.restore && (!request.edits.is_empty() || request.exclude_history_thinking))
    {
        return Err(invalid(
            "expectedRevision is required and restore cannot be combined with edits or history exclusion",
        ));
    }
    if request.edits.len() > MAX_MESSAGES {
        return Err(size_limit());
    }
    let session = &request.session_id;
    let anchor = &request.anchor_message_id;
    let mut turn = load_turn(db, session, anchor).map_err(|error| {
        if error.is::<MissingAnchor>() {
            anyhow!("CONFLICT: turn context anchor no longer exists")
        } else {
            error
        }
    })?;
    if request.exclude_history_thinking && !turn.is_latest {
        return Err(anyhow!(
            "CONFLICT: history thinking exclusion requires the latest turn"
        ));
    }
    let prior_revision = revision(db, &turn, session, anchor)?;
    if prior_revision != request.expected_revision {
        return Err(anyhow!(
            "CONFLICT: turn context changed since it was opened"
        ));
    }

    if request.exclude_history_thinking {
        include_history(db, session, &mut turn)?;
    }
    let mut edits = HashMap::with_capacity(request.edits.len());
    for edit in &request.edits {
        if edit.message_id.trim().is_empty()
            || edits
                .insert(edit.message_id.as_str(), &edit.context_override)
                .is_some()
        {
            return Err(invalid("blank or duplicate edit messageId"));
        }
    }
    let prompt_edit = request
        .exclude_previous_turns
        .map(|enabled| -> Result<_> {
            let index = prompt(&turn)
                .ok_or_else(|| anyhow!("CONFLICT: turn has no top-level user prompt"))?;
            let previous = &meta(&turn.records[index])[OVERRIDE];
            let marker = json!({"version":1,"excludePreviousTurns":true});
            if !previous.is_null() && previous != &marker {
                return Err(invalid("unsupported user prompt context override"));
            }
            Ok((index, if enabled { marker } else { Value::Null }))
        })
        .transpose()?;
    let mut boundary_changed = false;
    let mut replacements = Vec::new();
    let mut updates = Vec::new();
    for (i, row) in turn.records.iter_mut().enumerate() {
        let selected = turn.members.binary_search(&i).is_ok();
        let marker = prompt_edit.as_ref().filter(|(index, _)| *index == i);
        if marker.is_none() && !eligible(row) {
            continue;
        }
        let edit = if let Some((_, overlay)) = marker {
            Some(overlay)
        } else if selected && request.restore {
            Some(&Value::Null)
        } else if selected {
            edits.remove(row.id.as_str())
        } else {
            None
        };
        if let Some(overlay) = edit.filter(|_| marker.is_none()) {
            validate_override(row, overlay)?;
        }
        let base = edit.unwrap_or(&meta(row)[OVERRIDE]);
        let exclude =
            request.exclude_history_thinking && i <= turn.anchor && history_thinking(row, base);
        if edit.is_none() && !exclude {
            continue;
        }
        let overlay = if exclude {
            let mut merged = if base.is_null() {
                json!({"version": 1})
            } else {
                base.clone()
            };
            validate_override(row, &merged)?;
            merged["excludeThinking"] = json!(true);
            merged
        } else {
            base.clone()
        };
        let previous = meta(row);
        let clear_legacy =
            marker.is_none() && edit.is_some_and(Value::is_null) && previous.get(LEGACY).is_some();
        let changed = clear_legacy
            || if overlay.is_null() {
                previous.get(OVERRIDE).is_some()
            } else {
                previous[OVERRIDE] != overlay
            };
        if !changed {
            continue;
        }
        boundary_changed |= marker.is_some();
        let metadata = row
            .meta
            .get_or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| anyhow!("invalid message metadata"))?;
        if clear_legacy {
            metadata.remove(LEGACY);
        }
        if overlay.is_null() {
            metadata.remove(OVERRIDE);
        } else {
            metadata.insert(OVERRIDE.to_owned(), overlay.clone());
        }
        if metadata.is_empty() {
            row.meta = None;
        }
        replacements.push(i);
        if !selected {
            continue;
        }
        let mut update = json!({"messageId": row.id, "contextOverride": overlay});
        if let Some(legacy) = meta(row)[LEGACY]
            .as_bool()
            .or(clear_legacy.then_some(false))
        {
            update[LEGACY] = json!(legacy);
        }
        updates.push(update);
    }
    if !edits.is_empty() {
        return Err(invalid(
            "edit messageId does not belong to the editable turn",
        ));
    }
    let final_row = &turn.records[turn.anchor];
    let overlay = &meta(final_row)[OVERRIDE];
    if overlay["excludeContent"] != true
        && overlay["content"].as_str().map_or_else(
            || content(final_row).trim().is_empty(),
            |text| text.trim().is_empty(),
        )
    {
        return Err(invalid(
            "the final answer must keep nonblank content in context",
        ));
    }
    // Project and enforce the byte limit before any write. Revision hashes
    // have fixed length; only the new generation must wait for the splice.
    let mut snapshot = snapshot(&turn, session, anchor, &prior_revision)?;
    if let Some(&earliest) = replacements.first() {
        let suffix: HashSet<_> = turn.records[earliest..]
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        let rows: Vec<_> = replacements.iter().map(|&i| &turn.records[i]).collect();
        let tx = db.conn().unchecked_transaction()?;
        tx.execute(
            "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
            params![session, now_ms()],
        )?;
        if !transcripts::update_message_context_lines(
            db.data_dir(),
            session,
            &rows,
            &suffix,
            boundary_changed,
        )? {
            return Err(anyhow!("CONFLICT: canonical turn membership has changed"));
        }
        tx.commit()?;
        snapshot["revision"] = json!(revision(db, &turn, session, anchor)?);
    }
    Ok(json!({"snapshot": snapshot, "updates": updates}))
}
