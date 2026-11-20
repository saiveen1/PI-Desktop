use super::*;
use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};
use crate::sessions::{self, ObserverMode};
use rusqlite::types::Value as SqlValue;
use serde_json::json;

fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn observer_migration_v32_preserves_every_legacy_session_field_messages_and_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = sessions::create_session_with_options(
        &db,
        sessions::SessionCreateOptions {
            title: Some("Saved conversation".into()),
            mode: Some("goal".into()),
            provider_id: Some("saved-provider".into()),
            model_id: Some("saved-model".into()),
            project_path: Some(dir.path().to_string_lossy().into_owned()),
            thinking_level: Some("max".into()),
            permission_mode: Some("auto".into()),
            fast_mode: true,
            ..Default::default()
        },
    )
    .unwrap();
    let message: sessions::UiMessage = serde_json::from_value(json!({
        "id": "saved-message", "role": "assistant", "content": "Saved answer",
        "thinking": "Saved thought", "createdAt": "2026-01-01T00:00:00Z",
        "runDiagnostics": { "elapsedMs": 10, "observer": { "fixture": [1, false, null] } }
    }))
    .unwrap();
    sessions::append_message(&db, &session.id, &message, None).unwrap();
    db.kv_set(
        crate::session_delegation::NAMESPACE,
        &session.id,
        &json!(["saved-provider/worker"]),
    )
    .unwrap();
    db.set_setting("app", &json!({ "retained": { "nested": true } }))
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET source='synthetic', pinned=1, todo_revision=7,
         todo_updated_at=789, title_source='manual', mode_snapshot_hash='retained-hash',
         created_at=123, updated_at=456 WHERE id=?1",
            [&session.id],
        )
        .unwrap();
    // Remove the new column, not merely the version stamp: this is a real v32 layout.
    db.conn().execute_batch(
        "INSERT INTO sessions(id,title,deleted_at,created_at,updated_at) VALUES('trashed','Retained trash',999,111,222);
         ALTER TABLE sessions DROP COLUMN observer_mode; PRAGMA user_version=32;"
    ).unwrap();
    let columns = db
        .conn()
        .prepare("SELECT * FROM sessions")
        .unwrap()
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let session_sql = format!("SELECT {} FROM sessions ORDER BY id", columns.join(","));
    let old_sessions = rows(db.conn(), &session_sql);
    let related = ["messages", "projects", "kv"];
    let old_related = related
        .iter()
        .map(|table| rows(db.conn(), &format!("SELECT * FROM {table} ORDER BY 1,2")))
        .collect::<Vec<_>>();
    let transcript = crate::transcripts::transcript_path(dir.path(), &session.id).unwrap();
    let old_bytes = std::fs::read(&transcript).unwrap();
    drop(db);

    for _ in 0..2 {
        let upgraded = Database::open(&path).unwrap();
        assert_eq!(version(upgraded.conn()), SCHEMA_VERSION);
        assert_eq!(rows(upgraded.conn(), &session_sql), old_sessions);
        for (table, expected) in related.iter().zip(&old_related) {
            assert_eq!(
                &rows(
                    upgraded.conn(),
                    &format!("SELECT * FROM {table} ORDER BY 1,2")
                ),
                expected
            );
        }
        assert_eq!(std::fs::read(&transcript).unwrap(), old_bytes);
        let detail = sessions::get_session(&upgraded, &session.id)
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.observer_mode, ObserverMode::Off);
        assert_eq!(detail.messages[0].run_diagnostics, message.run_diagnostics);
        assert_eq!(detail.messages[0].thinking, message.thinking);
        assert_eq!(detail.messages[0].content, message.content);
        assert_eq!(
            rows(
                upgraded.conn(),
                "SELECT observer_mode FROM sessions ORDER BY id"
            ),
            vec![vec![SqlValue::Text("off".into())]; 2]
        );
        assert!(rows(upgraded.conn(), "PRAGMA foreign_key_check").is_empty());
    }
    let backup = Connection::open(migration_backup_path(&path, 32)).unwrap();
    assert_eq!(version(&backup), 32);
    assert_eq!(rows(&backup, &session_sql), old_sessions);
    assert!(backup
        .prepare("SELECT observer_mode FROM sessions")
        .is_err());
}

#[test]
fn observer_migration_fresh_and_upgraded_columns_have_identical_strict_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
    let path = dir.path().join("old.sqlite");
    let old = Database::open(&path).unwrap();
    old.conn()
        .execute_batch("ALTER TABLE sessions DROP COLUMN observer_mode; PRAGMA user_version=32;")
        .unwrap();
    drop(old);
    let upgraded = Database::open(&path).unwrap();
    let column_sql = "SELECT name,type,\"notnull\",dflt_value FROM pragma_table_info('sessions') WHERE name='observer_mode'";
    assert_eq!(
        rows(fresh.conn(), column_sql),
        rows(upgraded.conn(), column_sql)
    );
    for db in [&fresh, &upgraded] {
        db.conn()
            .execute_batch("INSERT INTO sessions(id,created_at,updated_at) VALUES('s',1,2)")
            .unwrap();
        assert_eq!(
            sessions::session_summary(db, "s")
                .unwrap()
                .unwrap()
                .observer_mode,
            ObserverMode::Off
        );
        for valid in ["off", "observe", "guard"] {
            db.conn()
                .execute("UPDATE sessions SET observer_mode=?1 WHERE id='s'", [valid])
                .unwrap();
        }
        for invalid in [
            SqlValue::Null,
            SqlValue::Integer(0),
            SqlValue::Integer(1),
            SqlValue::Text("[]".into()),
            SqlValue::Text("enabled".into()),
            SqlValue::Text("Guard".into()),
        ] {
            assert!(db
                .conn()
                .execute(
                    "UPDATE sessions SET observer_mode=?1 WHERE id='s'",
                    [invalid]
                )
                .is_err());
        }
        assert_eq!(
            sessions::session_summary(db, "s")
                .unwrap()
                .unwrap()
                .observer_mode,
            ObserverMode::Guard
        );
    }
}

#[test]
fn observer_migration_preserves_preexisting_column_on_idempotent_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = sessions::create_session_with_options(
        &db,
        sessions::SessionCreateOptions {
            observer_mode: ObserverMode::Observe,
            ..Default::default()
        },
    )
    .unwrap();
    db.conn().pragma_update(None, "user_version", 32).unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert_eq!(
        sessions::session_summary(&db, &session.id)
            .unwrap()
            .unwrap()
            .observer_mode,
        ObserverMode::Observe
    );
}
