//! The journal keeps the entire branch. Exclusion flags are a read projection only.
use super::*;

pub(super) fn start(records: &[MessageRecord]) -> Option<usize> {
    records
        .iter()
        .rposition(MessageRecord::marks_context_boundary)
}

pub(super) fn mark_prefix(messages: &mut [UiMessage], start: Option<usize>) {
    for (i, message) in messages.iter_mut().enumerate() {
        message.excluded_by_context_boundary = i < start.unwrap_or(0);
    }
}

pub(super) fn mark_window(messages: &mut [UiMessage], layout: &transcripts::TranscriptLayout) {
    if let Some(boundary) = layout.context_boundary() {
        for row in messages {
            row.excluded_by_context_boundary = boundary.excluded_ids.contains(&row.id);
        }
    }
}

pub(super) fn project(
    records: Vec<MessageRecord>,
    options: &SessionReadOptions,
    layout: Option<&transcripts::TranscriptLayout>,
) -> Vec<UiMessage> {
    let start = if layout.is_none() {
        start(&records)
    } else {
        None
    };
    let mut messages: Vec<_> = records
        .into_iter()
        .map(|record| {
            let Some(limit) = options.content_limit else {
                return record_to_ui(record);
            };
            // Preserve a search hit beyond the usual display cap on the focused row only.
            let focused = options.message_around.as_deref() == Some(record.id.as_str())
                && matches!(record.role.as_str(), "user" | "assistant");
            let content = focused.then(|| record_index_text(&record)).flatten();
            let mut message = record_to_ui_for_display(record, limit);
            if let Some(content) = content {
                message.content = content;
            }
            message
        })
        .collect();
    if let Some(layout) = layout {
        mark_window(&mut messages, layout);
    } else {
        mark_prefix(&mut messages, start);
    }
    messages
}

fn matches_stamp(checkpoint: &CompactionRecord, boundary: Option<&str>) -> bool {
    match checkpoint
        .details
        .as_ref()
        .and_then(|details| details.get("contextBoundaryMessageId"))
    {
        None => boundary.is_none(),
        Some(stamp) => boundary.is_some_and(|id| stamp.as_str() == Some(id)),
    }
}

pub(super) fn validate_checkpoint(
    db: &Database,
    session: &str,
    checkpoint: &CompactionRecord,
) -> Result<()> {
    let layout = session_layout(db, session)?;
    let boundary = layout.context_boundary();
    if !matches_stamp(checkpoint, boundary.map(|b| b.id.as_str()))
        || boundary.is_some_and(|b| {
            b.excluded_ids.contains(&checkpoint.through_message_id)
                || checkpoint
                    .first_kept_message_id
                    .as_ref()
                    .is_some_and(|id| b.excluded_ids.contains(id))
        })
    {
        return Err(anyhow!(
            "CONFLICT: compaction does not match the active context boundary"
        ));
    }
    Ok(())
}

/// A revision can restore a marker without going through the context editor. A
/// summary produced under a different cutoff is unsafe even if both anchors survive.
pub(super) fn surviving_compactions(
    db: &Database,
    session: &str,
    records: &[MessageRecord],
) -> Result<Vec<CompactionRecord>> {
    let mut checkpoints = transcripts::read_compactions(db.data_dir(), session)?;
    let start = start(records);
    let boundary = start.map(|i| records[i].id.as_str());
    checkpoints.retain(|c| {
        matches_stamp(c, boundary)
            && compaction_valid_for_records(c, &records[start.unwrap_or(0)..])
    });
    Ok(checkpoints)
}
