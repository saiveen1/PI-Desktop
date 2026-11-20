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
        for valid in ["off", "endless", "guard"] {
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
            SqlValue::Text("observe".into()),
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
            observer_mode: ObserverMode::Endless,
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
        ObserverMode::Endless
    );
}

fn v35(path: &Path) {
    let db = Database::open(path).unwrap();
    db.conn()
        .execute_batch("ALTER TABLE sessions DROP COLUMN observer_mode;")
        .unwrap();
    ensure_column(db.conn()).unwrap();
    db.conn().execute_batch(
        "ALTER TABLE sessions ADD COLUMN payload BLOB NOT NULL DEFAULT X'00FE';
         ALTER TABLE sessions ADD COLUMN label TEXT GENERATED ALWAYS AS (title || ':' || observer_mode) VIRTUAL;
         CREATE INDEX retained_observer ON sessions(observer_mode) WHERE observer_mode != 'off';
         CREATE VIEW retained_sessions AS SELECT id,label,payload FROM sessions;
         CREATE TABLE retained_audit(mode TEXT);
         CREATE TRIGGER retained_observer_audit AFTER UPDATE OF observer_mode ON sessions
           BEGIN INSERT INTO retained_audit VALUES(new.observer_mode); END;
         INSERT INTO sessions(id,title,observer_mode,created_at,updated_at,payload)
           VALUES('old','Legacy','observe',10,11,X'1234'),('protected','Protected','guard',20,21,X'5678'),
                 ('disabled','Disabled','off',30,31,X'9ABC');
         INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES('old-turn','old','completed',10,11);
         INSERT INTO session_todo(session_id,position,content,status,updated_at)
           VALUES('old',0,'Keep this todo','pending',11);
         PRAGMA user_version = 35;"
    ).unwrap();
    let message: sessions::UiMessage = serde_json::from_value(json!({
        "id": "old-answer", "role": "assistant", "content": "Preserved",
        "createdAt": "2026-01-01T00:00:00Z",
        "runDiagnostics": {"observer": {
            "messageId":"old-answer", "mode":"observe", "status":"assessed",
            "startedAt":10, "continuationReason":"observe_only"
        }}
    }))
    .unwrap();
    sessions::append_message(&db, "old", &message, Some("old-turn")).unwrap();
}

#[test]
fn observer_migration_v35_disables_observe_and_preserves_guard_data_schema_and_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    v35(&path);
    let source = Connection::open(&path).unwrap();
    let modes = "SELECT observer_mode FROM sessions ORDER BY id";
    let saved_modes = rows(&source, modes);
    let objects = "SELECT name,sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') ORDER BY name";
    let retained_objects = rows(&source, objects);
    let retained_tables = [
        "SELECT id,title,created_at,updated_at,payload FROM sessions ORDER BY id",
        "SELECT * FROM messages",
        "SELECT * FROM turns",
        "SELECT * FROM session_todo",
    ];
    let retained_rows = retained_tables.map(|sql| rows(&source, sql));
    let transcript = crate::transcripts::transcript_path(dir.path(), "old").unwrap();
    let transcript_bytes = std::fs::read(&transcript).unwrap();
    drop(source);

    let backup_path = migration_backup_path(&path, 35);
    let db = Database::open(&path).unwrap();
    let backup_bytes = std::fs::read(&backup_path).unwrap();
    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(version(&backup), 35);
    assert_eq!(rows(&backup, modes), saved_modes);
    drop(backup);

    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert_eq!(
        rows(db.conn(), modes),
        ["off", "off", "guard"].map(|mode| vec![SqlValue::Text(mode.into())])
    );
    assert_eq!(rows(db.conn(), objects), retained_objects);
    for (sql, expected) in retained_tables.into_iter().zip(retained_rows) {
        assert_eq!(rows(db.conn(), sql), expected);
    }
    assert_eq!(
        rows(
            db.conn(),
            "SELECT label FROM retained_sessions WHERE id='old'"
        ),
        vec![vec![SqlValue::Text("Legacy:off".into())]]
    );
    assert!(rows(db.conn(), "SELECT * FROM retained_audit").is_empty());
    assert!(rows(db.conn(), "PRAGMA foreign_key_check").is_empty());
    assert!(db
        .conn()
        .execute("UPDATE session_todo SET session_id='missing'", [])
        .is_err());
    db.conn()
        .execute(
            "UPDATE sessions SET observer_mode='endless' WHERE id='old'",
            [],
        )
        .unwrap();
    assert_eq!(
        rows(db.conn(), "SELECT * FROM retained_audit"),
        vec![vec![SqlValue::Text("endless".into())]]
    );
    drop(db);

    let db = Database::open(&path).unwrap();
    let detail = sessions::get_session(&db, "old").unwrap().unwrap();
    assert_eq!(detail.summary.observer_mode, ObserverMode::Endless);
    assert_eq!(
        detail.messages[0].run_diagnostics.as_ref().unwrap()["observer"]["mode"],
        "observe"
    );
    assert_eq!(std::fs::read(&transcript).unwrap(), transcript_bytes);
    assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes);
}

#[test]
fn observer_migration_v35_rolls_back_on_foreign_key_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    v35(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=OFF; UPDATE session_todo SET session_id='missing'; PRAGMA foreign_keys=ON;").unwrap();
    assert!(migrate(&conn, &path)
        .unwrap_err()
        .to_string()
        .contains("foreign key check failed"));
    assert_eq!(version(&conn), 35);
    assert_eq!(
        rows(&conn, "SELECT observer_mode FROM sessions WHERE id='old'"),
        vec![vec![SqlValue::Text("observe".into())]]
    );
    assert!(conn
        .pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
        .unwrap());
    assert!(!conn
        .pragma_query_value(None, "legacy_alter_table", |row| row.get::<_, bool>(0))
        .unwrap());
    assert!(migration_backup_path(&path, 35).is_file());
}
