use crate::db::{Connection, Result};

/// Consent is explicit per conversation: existing rows and omitted inserts are off.
/// The caller owns the backup, transaction and version of the combined repair.
pub(crate) fn ensure_column(conn: &Connection) -> Result<()> {
    let has_column: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'observer_mode')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN observer_mode TEXT NOT NULL DEFAULT 'off'
             CHECK (observer_mode IN ('off', 'observe', 'guard'));",
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "session_observer_migration_tests.rs"]
mod tests;
