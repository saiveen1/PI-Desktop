use super::Result;
use rusqlite::Transaction;

/// Shared by fresh initialization, v29 reconciliation and local v30 upgrades.
/// Legacy runs start at zero, never at a duration inferred from created_at.
/// Legacy queued turns do not explicitly request a new Goal run.
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    for (table, column, ddl) in [
        (
            "mode_runs",
            "elapsed_ms",
            "ALTER TABLE mode_runs ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0
             CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991);",
        ),
        (
            "mode_runs",
            "active_since_ms",
            "ALTER TABLE mode_runs ADD COLUMN active_since_ms INTEGER
             CHECK (active_since_ms BETWEEN 0 AND 9007199254740991);",
        ),
        (
            "turn_queue",
            "start_goal",
            "ALTER TABLE turn_queue ADD COLUMN start_goal INTEGER NOT NULL DEFAULT 0
             CHECK (start_goal IN (0, 1));",
        ),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(ddl)?;
        }
    }
    Ok(())
}
