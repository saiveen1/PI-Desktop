use super::*;
use crate::{
    db::{migration_backup_path, Database, SCHEMA_VERSION},
    sessions,
};
use serde_json::json;

fn version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn schema(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_personas'",
        [],
        |row| row.get(0),
    )
}

fn v34(path: &Path) -> String {
    let db = Database::open(path).unwrap();
    let session =
        sessions::create_session(&db, Some("Retained".into()), None, None, None, None).unwrap();
    db.set_setting("app", &json!({"retained":true})).unwrap();
    db.conn()
        .execute_batch("DROP TABLE session_personas; PRAGMA user_version = 34;")
        .unwrap();
    session.id
}

#[test]
fn persona_migration_v34_preserves_legacy_rows_and_verified_backup_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let id = v34(&path);
    let fresh = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
    assert_eq!(version(fresh.conn()), 35);
    let expected = schema(fresh.conn()).unwrap();
    let backup_path = migration_backup_path(&path, 34);
    let mut original_backup = None;
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(schema(db.conn()).unwrap(), expected);
        let summary = sessions::session_summary(&db, &id).unwrap().unwrap();
        assert_eq!(summary.title, "Retained");
        assert!(summary.persona.is_none());
        assert_eq!(
            db.get_setting("app").unwrap().unwrap(),
            json!({"retained":true})
        );
        let contents = std::fs::read(&backup_path).unwrap();
        if let Some(already) = &original_backup {
            assert_eq!(&contents, already);
        }
        original_backup = Some(contents);
    }
    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(version(&backup), 34);
    assert!(schema(&backup).is_err());
    let title: String = backup
        .query_row("SELECT title FROM sessions WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "Retained");
}

#[test]
fn persona_migration_v34_does_not_mutate_when_backup_cannot_be_installed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    v34(&path);
    std::fs::create_dir(migration_backup_path(&path, 34)).unwrap();
    assert!(Database::open(&path).is_err());
    let original = Connection::open(&path).unwrap();
    assert_eq!(version(&original), 34);
    assert!(schema(&original).is_err());
}
