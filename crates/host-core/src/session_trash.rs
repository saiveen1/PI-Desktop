//! Durable recycle-bin membership reuses the existing soft-delete marker.
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::db::{ms_to_ts, now_ms, Database};
use crate::sessions::{self, SessionSummary};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashedSession {
    #[serde(flatten)]
    pub session: SessionSummary,
    pub deleted_at: String,
}

pub fn list(db: &Database) -> Result<Vec<TrashedSession>> {
    let sql = format!(
        "{} WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC, s.id",
        sessions::SUMMARY_SELECT
    );
    let mut statement = db.conn().prepare_cached(&sql)?;
    let rows = statement.query_map([], |row| {
        Ok(TrashedSession {
            session: sessions::summary_from_row(row)?,
            deleted_at: ms_to_ts(row.get("deleted_at")?),
        })
    })?;
    let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for entry in &mut rows {
        crate::session_personas::attach(db, &mut entry.session)?;
    }
    Ok(rows)
}

pub fn is_trashed(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1 AND deleted_at IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?)
}

pub(crate) fn has_pending_work(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id = ?1 AND status = 'running')
          OR EXISTS(SELECT 1 FROM turn_queue WHERE session_id = ?1)
          OR EXISTS(SELECT 1 FROM plan_approvals WHERE session_id = ?1
                    AND (status = 'pending' OR execution_state IN ('queued', 'running')))
          OR EXISTS(SELECT 1 FROM session_collaboration_messages WHERE target_session_id = ?1
                    AND status IN ('queued', 'running'))",
        [id],
        |row| row.get(0),
    )?)
}

pub fn ensure_idle(db: &Database, id: &str) -> Result<()> {
    if has_pending_work(db, id)? {
        return Err(anyhow!(
            "AGENT_BUSY: stop running work and clear pending work before recycling"
        ));
    }
    Ok(())
}

pub fn trash(db: &Database, id: &str) -> Result<bool> {
    ensure_idle(db, id)?;
    let current: Option<Option<i64>> = db
        .conn()
        .query_row(
            "SELECT deleted_at FROM sessions WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    match current {
        None => Ok(false),
        Some(Some(_)) => Ok(true),
        Some(None) => Ok(db.conn().execute(
            "UPDATE sessions SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now_ms(), id],
        )? > 0),
    }
}

pub fn restore(db: &Database, id: &str) -> Result<bool> {
    ensure_idle(db, id)?;
    Ok(db.conn().execute(
        "UPDATE sessions SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
        [id],
    )? > 0)
}

pub fn purge(db: &Database, id: &str) -> Result<bool> {
    ensure_idle(db, id)?;
    if !is_trashed(db, id)? {
        return Err(anyhow!(
            "INVALID_ARGUMENT: session must be in the recycle bin"
        ));
    }
    sessions::delete_session(db, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trash_survives_reopen_and_restore_preserves_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let session =
            sessions::create_session(&db, Some("Keep me".into()), None, None, None, None).unwrap();
        let message = serde_json::from_value(json!({
            "id": "message", "role": "user", "content": "Retained history", "createdAt": "2026-11-04T00:00:00Z"
        })).unwrap();
        sessions::append_message(&db, &session.id, &message, None).unwrap();
        assert!(purge(&db, &session.id).is_err());
        assert!(trash(&db, &session.id).unwrap());
        let stamp = list(&db).unwrap()[0].deleted_at.clone();
        assert!(trash(&db, &session.id).unwrap());
        assert_eq!(list(&db).unwrap()[0].deleted_at, stamp);
        assert!(sessions::list_sessions(&db).unwrap().is_empty());
        assert!(sessions::get_session(&db, &session.id).unwrap().is_none());
        assert!(sessions::begin_turn(&db, &session.id, None, None).is_err());
        drop(db);
        let db = Database::open_in_dir(dir.path()).unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);
        assert_eq!(sessions::recover_orphaned_sessions(&db).unwrap(), 0);
        assert!(restore(&db, &session.id).unwrap());
        let detail = sessions::get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages[0].content, "Retained history");
        assert!(list(&db).unwrap().is_empty());
        assert!(trash(&db, &session.id).unwrap());
        assert!(purge(&db, &session.id).unwrap());
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(sessions::recover_orphaned_sessions(&db).unwrap(), 0);
        assert!(!restore(&db, &session.id).unwrap());
    }

    #[test]
    fn running_and_queued_sessions_cannot_be_trashed() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let running = sessions::create_session(&db, None, None, None, None, None).unwrap();
        sessions::begin_turn(&db, &running.id, None, None).unwrap();
        assert!(trash(&db, &running.id)
            .unwrap_err()
            .to_string()
            .starts_with("AGENT_BUSY"));
        let queued = sessions::create_session(&db, None, None, None, None, None).unwrap();
        db.conn().execute(
            "INSERT INTO turn_queue(id, session_id, principal, input_hash, content, permission_mode, position, created_at)
             VALUES ('queued', ?1, 'user', 'hash', 'pending', 'ask', 0, 0)", [&queued.id],
        ).unwrap();
        assert!(trash(&db, &queued.id)
            .unwrap_err()
            .to_string()
            .starts_with("AGENT_BUSY"));
        assert!(list(&db).unwrap().is_empty());
    }
}
