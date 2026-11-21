use super::{create_migration_backup, Connection, Context, Path, Result};

/// Existing discovered rows establish past publication, not binding provenance.
/// User-owned rows remain unknown. No saved configuration is changed.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('models') WHERE name = 'discovery_state')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch(
            "ALTER TABLE models ADD COLUMN discovery_state TEXT
            CHECK (discovery_state IN ('published', 'unlisted'));
            UPDATE models SET discovery_state = 'published' WHERE source = 'discovered';",
        )?;
    }
    tx.pragma_update(None, "user_version", 25i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v24 to v25 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_reported_context_window(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 36)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('models') WHERE name = 'reported_context_window')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        // The previous cache could contain enriched defaults, so leave provenance unknown.
        tx.execute_batch("ALTER TABLE models ADD COLUMN reported_context_window INTEGER;")?;
    }
    // An upstream v34 profile can reach this step without the personal index.
    tx.execute_batch(super::delegation_history_migration::DDL)?;
    tx.pragma_update(None, "user_version", 37i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v36 to v37 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};
    use rusqlite::{Connection, OpenFlags};

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn seed_discovered_model(db: &Database) {
        db.conn()
            .execute_batch(
                "INSERT INTO providers(id, name, vendor_key, type, protocol, auth_kind, created_at, updated_at)
                 VALUES ('relay', 'Relay', 'custom', 'openai_compatible', 'openai_compatible', 'none', 0, 0);
                 INSERT INTO models(provider_id, model_id, display_name, source, context_window, discovery_state, updated_at)
                 VALUES ('relay', 'model', 'Model', 'discovered', 500000, 'published', 0);",
            )
            .unwrap();
    }

    fn assert_cached_windows(db: &Database, reported: Option<u32>) {
        let rows = crate::providers::list_models(db, Some("relay")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].context_window, Some(500_000));
        assert_eq!(rows[0].reported_context_window, reported);
    }

    #[test]
    fn upgrade_keeps_cached_capacity_without_inventing_its_provenance() {
        for from in [33, 36] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("pi.sqlite");
            let db = Database::open(&path).unwrap();
            seed_discovered_model(&db);
            db.conn()
                .execute_batch("ALTER TABLE models DROP COLUMN reported_context_window;")
                .unwrap();
            db.conn().pragma_update(None, "user_version", from).unwrap();
            drop(db);

            let upgraded = Database::open(&path).unwrap();
            assert_eq!(version(upgraded.conn()), SCHEMA_VERSION);
            assert_cached_windows(&upgraded, None);
            let backup = Connection::open_with_flags(
                migration_backup_path(&path, 36),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            assert_eq!(version(&backup), 36);
            assert!(!backup
                .prepare("SELECT 1 FROM pragma_table_info('models') WHERE name = 'reported_context_window'")
                .unwrap()
                .exists([])
                .unwrap());
            assert!(migration_backup_path(&path, from).is_file());
        }
    }

    #[test]
    fn upstream_v34_keeps_reported_capacity_and_gains_personal_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        seed_discovered_model(&db);
        db.conn()
            .execute_batch(
                "DROP TABLE session_personas;
                 DROP INDEX idx_messages_task_history;
                 ALTER TABLE sessions DROP COLUMN observer_mode;
                 UPDATE models SET reported_context_window = 400000;
                 PRAGMA user_version = 34;",
            )
            .unwrap();
        drop(db);

        let upgraded = Database::open(&path).unwrap();
        assert_eq!(version(upgraded.conn()), SCHEMA_VERSION);
        assert_cached_windows(&upgraded, Some(400_000));
        for name in ["session_personas", "idx_messages_task_history"] {
            assert!(upgraded
                .conn()
                .prepare("SELECT 1 FROM sqlite_master WHERE name = ?")
                .unwrap()
                .exists([name])
                .unwrap());
        }
        assert!(upgraded
            .conn()
            .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'observer_mode'")
            .unwrap()
            .exists([])
            .unwrap());
        drop(upgraded);
        assert_cached_windows(&Database::open(&path).unwrap(), Some(400_000));
    }
}
