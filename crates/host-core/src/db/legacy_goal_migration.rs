use super::{anyhow, create_migration_backup, Connection, Context, Path, Result};

/// Both branches published v33: Observer consent or retired independent Goal
/// storage. Reconcile the actual shape without rewriting either branch's data.
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if !matches!(version, 32 | 33) {
        return Err(anyhow!(
            "unsupported schema v{version} for v34 reconciliation"
        ));
    }
    let backup = create_migration_backup(conn, path, version)?;
    super::schema_rebuild::with_table_rebuild(conn, || {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("DROP TRIGGER IF EXISTS turn_execution_snapshot;")?;
        super::migrations::session_observer_migration::ensure_column(&tx)?;
        super::session_mode_migration::widen_session_modes(&tx)?;
        tx.execute_batch(super::delegation_history_migration::DDL)?;
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(anyhow!(
                "foreign key check failed during schema v34 reconciliation"
            ));
        }
        tx.pragma_update(None, "user_version", 34i64)?;
        tx.commit().with_context(|| {
            format!(
                "commit schema v{version} to v34 reconciliation; backup {} remains",
                backup.display()
            )
        })
    })
}

#[cfg(test)]
#[path = "schema_reconciliation_tests.rs"]
mod tests;
