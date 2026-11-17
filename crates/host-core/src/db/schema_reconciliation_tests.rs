use super::*;
use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};
use rusqlite::types::Value;

fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut statement = conn.prepare(sql).unwrap();
    let columns = statement.column_count();
    statement
        .query_map([], |row| (0..columns).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn objects(conn: &Connection) -> Vec<Vec<Value>> {
    rows(
        conn,
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name",
    )
}

fn has_observer(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='observer_mode')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

fn has_legacy_trigger(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='turn_execution_snapshot')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

/// Local v33 has consent, a constrained sessions table and the legacy writer;
/// upstream v33 has neither constraint nor writer, but lacks consent entirely.
fn fixture(path: &Path, source_version: i64, local: bool) -> std::path::PathBuf {
    let db = Database::open(path).unwrap();
    db.conn()
        .execute_batch(
            "INSERT INTO sessions(id,title,mode,observer_mode,created_at,updated_at)
           VALUES('saved','History','goal','observe',1,2),('guarded','Guarded','agent','guard',1,2);
         INSERT INTO turns(id,session_id,status,started_at,ended_at)
           VALUES('saved-turn','saved','completed',1,2);",
        )
        .unwrap();
    let message = serde_json::from_value(serde_json::json!({
        "id":"saved-task", "role":"assistant", "content":"Retained Task history",
        "createdAt":"2026-11-01T00:00:00Z"
    }))
    .unwrap();
    crate::sessions::append_message(&db, "saved", &message, None).unwrap();
    db.conn()
        .execute_batch("UPDATE messages SET tool_name='Task';")
        .unwrap();
    if !local {
        db.conn()
            .execute_batch("ALTER TABLE sessions DROP COLUMN observer_mode;")
            .unwrap();
    } else {
        // Recreate a genuine legacy CHECK using the actual definition, not a
        // reduced fixture that could hide lost additive columns.
        super::super::schema_rebuild::with_table_rebuild(db.conn(), || {
            let tx = db.conn().unchecked_transaction()?;
            let sql: String = tx.query_row("SELECT sql FROM sqlite_master WHERE name='sessions'", [], |row| row.get(0))?;
            let sql = sql.replace("mode        TEXT NOT NULL DEFAULT 'agent'", "mode        TEXT NOT NULL DEFAULT 'agent' CHECK(mode IN ('agent','plan','goal'))");
            assert!(sql.contains("CHECK(mode IN"));
            let saved = tx.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND sql IS NOT NULL")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            tx.execute_batch(&format!("CREATE TABLE sessions_fixture {}", &sql[sql.find('(').unwrap()..]))?;
            tx.execute_batch("INSERT INTO sessions_fixture SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_fixture RENAME TO sessions;")?;
            for sql in saved {
                tx.execute_batch(&sql)?;
            }
            tx.commit()?;
            Ok(())
        }).unwrap();
    }
    db.conn().execute_batch(
        "ALTER TABLE sessions ADD COLUMN additive_payload BLOB NOT NULL DEFAULT X'00FE';
         ALTER TABLE sessions ADD COLUMN generated_label TEXT GENERATED ALWAYS AS (title || ':' || mode) VIRTUAL;
         CREATE INDEX retained_payload ON sessions(additive_payload);
         CREATE VIEW retained_sessions AS SELECT id,mode,generated_label FROM sessions;
         CREATE TABLE retained_children(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE);
         INSERT INTO retained_children VALUES('child','saved');
         CREATE TABLE retained_audit(mode TEXT);
         CREATE TRIGGER retained_mode_audit AFTER UPDATE OF mode ON sessions
           BEGIN INSERT INTO retained_audit VALUES(new.mode); END;
         CREATE TABLE turn_execution(turn_id TEXT PRIMARY KEY REFERENCES turns(id), mode TEXT CHECK(mode IN ('agent','plan','goal')));
         INSERT INTO turn_execution VALUES('saved-turn','goal');
         DROP INDEX idx_messages_task_history;"
    ).unwrap();
    if local {
        db.conn().execute_batch(
            "CREATE TRIGGER turn_execution_snapshot AFTER INSERT ON turns BEGIN
             INSERT INTO turn_execution SELECT new.id,mode FROM sessions WHERE id=new.session_id; END;"
        ).unwrap();
    }
    db.conn()
        .pragma_update(None, "user_version", source_version)
        .unwrap();
    crate::transcripts::transcript_path(path.parent().unwrap(), "saved").unwrap()
}

#[test]
fn schema_v34_reconciles_both_populated_v33_and_v32_variants_idempotently() {
    for source_version in [32, 33] {
        for local in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("pi.sqlite");
            let transcript = fixture(&path, source_version, local);
            let bytes = std::fs::read(&transcript).unwrap();
            let before = Connection::open(&path).unwrap();
            let saved = rows(
                &before,
                "SELECT id,title,mode,additive_payload,generated_label FROM sessions ORDER BY id",
            );
            let messages = rows(&before, "SELECT * FROM messages");
            let ledger = rows(&before, "SELECT * FROM turn_execution");
            drop(before);

            let db = Database::open(&path).unwrap();
            assert_eq!(SCHEMA_VERSION, 34);
            assert_eq!(version(db.conn()), 34);
            assert_eq!(rows(db.conn(), "SELECT id,title,mode,additive_payload,generated_label FROM sessions ORDER BY id"), saved);
            assert_eq!(rows(db.conn(), "SELECT * FROM messages"), messages);
            assert_eq!(rows(db.conn(), "SELECT * FROM turn_execution"), ledger);
            assert_eq!(std::fs::read(&transcript).unwrap(), bytes);
            assert!(!has_legacy_trigger(db.conn()));
            let expected = if local {
                ["guard", "observe"]
            } else {
                ["off", "off"]
            };
            assert_eq!(
                rows(db.conn(), "SELECT observer_mode FROM sessions ORDER BY id"),
                expected
                    .into_iter()
                    .map(|mode| vec![Value::Text(mode.into())])
                    .collect::<Vec<_>>()
            );
            assert_eq!(rows(db.conn(), "SELECT count(*) FROM sqlite_master WHERE name IN ('retained_payload','retained_sessions','retained_mode_audit','idx_messages_task_history')"), vec![vec![Value::Integer(4)]]);
            db.conn().execute_batch(
                "INSERT INTO sessions(id,created_at,updated_at) VALUES('default',1,2);
                 UPDATE sessions SET mode='review' WHERE id='saved';
                 INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES('custom-turn','saved','completed',3,4);"
            ).unwrap();
            assert_eq!(
                rows(
                    db.conn(),
                    "SELECT observer_mode FROM sessions WHERE id='default'"
                ),
                vec![vec![Value::Text("off".into())]]
            );
            assert_eq!(
                rows(
                    db.conn(),
                    "SELECT generated_label FROM retained_sessions WHERE id='saved'"
                ),
                vec![vec![Value::Text("History:review".into())]]
            );
            assert_eq!(
                rows(db.conn(), "SELECT * FROM retained_audit"),
                vec![vec![Value::Text("review".into())]]
            );
            assert_eq!(rows(db.conn(), "SELECT * FROM turn_execution"), ledger);
            assert!(rows(db.conn(), "PRAGMA foreign_key_check").is_empty());
            assert!(db
                .conn()
                .execute("UPDATE retained_children SET session_id='missing'", [])
                .is_err());
            assert!(db
                .conn()
                .execute("UPDATE sessions SET observer_mode='enabled'", [])
                .is_err());
            assert!(db
                .conn()
                .execute("UPDATE sessions SET observer_mode=NULL", [])
                .is_err());
            let backup_path = migration_backup_path(&path, source_version);
            let backup = Connection::open(&backup_path).unwrap();
            assert_eq!(version(&backup), source_version);
            assert_eq!(has_observer(&backup), local);
            assert_eq!(has_legacy_trigger(&backup), local);
            assert_eq!(rows(&backup, "SELECT * FROM messages"), messages);
            assert_eq!(rows(&backup, "SELECT * FROM turn_execution"), ledger);
            assert_eq!(rows(&backup, "SELECT id,title,mode,additive_payload,generated_label FROM sessions ORDER BY id"), saved);
            drop(backup);
            let backup_bytes = std::fs::read(&backup_path).unwrap();
            let final_objects = objects(db.conn());
            let final_sessions = rows(db.conn(), "SELECT * FROM sessions ORDER BY id");
            drop(db);
            for _ in 0..2 {
                let reopened = Database::open(&path).unwrap();
                assert_eq!(version(reopened.conn()), 34);
                assert_eq!(objects(reopened.conn()), final_objects);
                assert_eq!(
                    rows(reopened.conn(), "SELECT * FROM sessions ORDER BY id"),
                    final_sessions
                );
                assert_eq!(std::fs::read(&backup_path).unwrap(), backup_bytes);
                assert_eq!(std::fs::read(&transcript).unwrap(), bytes);
                assert!(rows(reopened.conn(), "PRAGMA foreign_key_check").is_empty());
            }
        }
    }
}

#[test]
fn schema_v34_failure_rolls_back_all_repairs_and_restores_pragmas() {
    for local in [false, true] {
        for foreign_keys in [false, true] {
            for legacy_alter_table in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("pi.sqlite");
                fixture(&path, 33, local);
                let conn = Connection::open(&path).unwrap();
                // Failure after the missing consent column / trigger repair:
                // either table replacement collides, or final FK validation fails.
                if local {
                    conn.execute_batch("CREATE TABLE sessions_v32(unrelated TEXT);")
                        .unwrap();
                } else {
                    conn.pragma_update(None, "foreign_keys", false).unwrap();
                    conn.execute_batch("INSERT INTO retained_children VALUES('orphan','missing');")
                        .unwrap();
                }
                conn.pragma_update(None, "foreign_keys", foreign_keys)
                    .unwrap();
                conn.pragma_update(None, "legacy_alter_table", legacy_alter_table)
                    .unwrap();
                let old_objects = objects(&conn);
                let old_sessions = rows(&conn, "SELECT * FROM sessions ORDER BY id");
                assert!(migrate(&conn, &path).is_err());
                assert_eq!(version(&conn), 33);
                assert_eq!(objects(&conn), old_objects);
                assert_eq!(
                    rows(&conn, "SELECT * FROM sessions ORDER BY id"),
                    old_sessions
                );
                assert_eq!(has_observer(&conn), local);
                assert_eq!(has_legacy_trigger(&conn), local);
                assert_eq!(
                    conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
                        .unwrap(),
                    foreign_keys
                );
                assert_eq!(
                    conn.pragma_query_value(None, "legacy_alter_table", |row| row
                        .get::<_, bool>(0))
                        .unwrap(),
                    legacy_alter_table
                );
                let backup = Connection::open(migration_backup_path(&path, 33)).unwrap();
                assert_eq!(version(&backup), 33);
                assert_eq!(objects(&backup), old_objects);
            }
        }
    }
}

#[test]
fn schema_v34_refuses_mutation_without_verified_source_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    fixture(&path, 33, false);
    std::fs::create_dir(migration_backup_path(&path, 33)).unwrap();
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 33);
    assert!(!has_observer(&conn));
    assert_eq!(
        rows(&conn, "SELECT count(*) FROM messages"),
        vec![vec![Value::Integer(1)]]
    );
}

#[test]
fn schema_v34_success_restores_original_connection_pragmas() {
    for foreign_keys in [false, true] {
        for legacy_alter_table in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("pi.sqlite");
            fixture(&path, 33, true);
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "foreign_keys", foreign_keys)
                .unwrap();
            conn.pragma_update(None, "legacy_alter_table", legacy_alter_table)
                .unwrap();
            migrate(&conn, &path).unwrap();
            assert_eq!(version(&conn), 34);
            assert_eq!(
                conn.pragma_query_value(None, "foreign_keys", |row| row.get::<_, bool>(0))
                    .unwrap(),
                foreign_keys
            );
            assert_eq!(
                conn.pragma_query_value(None, "legacy_alter_table", |row| row.get::<_, bool>(0))
                    .unwrap(),
                legacy_alter_table
            );
            assert!(rows(&conn, "PRAGMA foreign_key_check").is_empty());
        }
    }
}
