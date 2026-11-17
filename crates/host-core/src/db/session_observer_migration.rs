use crate::db::{create_migration_backup, Connection, Context, Path, Result};

/// Consent is explicit per conversation: existing rows and omitted inserts are off.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 32)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'observer_mode')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN observer_mode TEXT NOT NULL DEFAULT 'off'
             CHECK (observer_mode IN ('off', 'observe', 'guard'));",
        )?;
    }
    tx.pragma_update(None, "user_version", 33i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v32 to v33 observer mode migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "session_observer_migration_tests.rs"]
mod tests;
