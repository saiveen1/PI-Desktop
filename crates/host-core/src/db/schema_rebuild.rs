use super::{anyhow, Connection, Context, Result};
use rusqlite::Transaction;

/// Keep dependent views, triggers and child FK targets stable during table
/// replacement, then restore both connection settings on every exit path.
pub(super) fn with_table_rebuild(
    conn: &Connection,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    let legacy_alter_table: bool =
        conn.pragma_query_value(None, "legacy_alter_table", |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        conn.pragma_update(None, "legacy_alter_table", true)?;
        action()
    })();
    // Attempt both restores even when migration or the other restore fails.
    let restore_alter = conn.pragma_update(None, "legacy_alter_table", legacy_alter_table);
    let restore_keys = conn.pragma_update(None, "foreign_keys", foreign_keys);
    restore_alter.context("restore legacy alter table after schema rebuild")?;
    restore_keys.context("restore foreign keys after schema rebuild")?;
    result
}

pub(super) fn rebuild_sessions(
    tx: &Transaction<'_>,
    ddl: &str,
    replacement_table: &str,
    column_override: Option<(&str, &str)>,
) -> Result<()> {
    let columns_start = ddl
        .find('(')
        .ok_or_else(|| anyhow!("unrecognized sessions table definition"))?;
    let objects = tx
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Copy writable columns only; generated columns are recomputed by SQLite.
    let (columns, projection): (Vec<_>, Vec<_>) = tx
        .prepare("SELECT name FROM pragma_table_xinfo('sessions') WHERE hidden=0 ORDER BY cid")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|name| {
            let column = format!("\"{}\"", name.replace('"', "\"\""));
            let source = match column_override {
                Some((key, expression)) if name == key => expression.to_owned(),
                _ => column.clone(),
            };
            (column, source)
        })
        .unzip();
    tx.execute_batch(&format!(
        "CREATE TABLE {replacement_table} {};
         INSERT INTO {replacement_table} ({}) SELECT {} FROM sessions;
         DROP TABLE sessions;
         ALTER TABLE {replacement_table} RENAME TO sessions;",
        &ddl[columns_start..],
        columns.join(","),
        projection.join(","),
    ))?;
    for object in objects {
        tx.execute_batch(&object)?;
    }
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(anyhow!("foreign key check failed during sessions rebuild"));
    }
    Ok(())
}
