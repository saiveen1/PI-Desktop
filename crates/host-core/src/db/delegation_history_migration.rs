use super::{create_migration_backup, Connection, Context, Path, Result};
pub(crate) const DDL: &str = "CREATE INDEX IF NOT EXISTS idx_messages_task_history ON messages(created_at DESC,mid DESC) WHERE tool_name='Task';";
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(DDL)?;
    tx.pragma_update(None, "user_version", 28i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit delegation history index migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
