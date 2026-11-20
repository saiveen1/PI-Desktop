use crate::db::{create_migration_backup, Connection, Context, Path, Result};

pub(super) const DDL: &str = r#"
CREATE TABLE IF NOT EXISTS session_personas (
  session_id    TEXT NOT NULL PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
) WITHOUT ROWID;
"#;

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 34)?;
    (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(DDL)?;
        tx.pragma_update(None, "user_version", 35i64)?;
        tx.commit()?;
        Ok(())
    })()
    .with_context(|| {
        format!(
            "apply schema v34 to v35 migration; backup {} remains",
            backup.display()
        )
    })
}

#[cfg(test)]
#[path = "session_persona_migration_tests.rs"]
mod tests;
