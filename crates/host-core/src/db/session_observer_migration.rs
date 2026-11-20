use crate::db::{anyhow, create_migration_backup, Connection, Context, Path, Result};
use regex::Regex;

use super::super::schema_rebuild::{rebuild_sessions, with_table_rebuild};

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

pub(in crate::db) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 35)?;
    with_table_rebuild(conn, || {
        let tx = conn.unchecked_transaction()?;
        ensure_column(&tx)?;
        let ddl: String = tx.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |row| row.get(0),
        )?;
        let check = Regex::new(
            r#"(?i)\bCHECK\s*\(\s*(?:observer_mode|"observer_mode"|`observer_mode`|\[observer_mode\])\s+IN\s*\(\s*'off'\s*,\s*'(observe|endless)'\s*,\s*'guard'\s*\)\s*\)"#,
        )?;
        let captures = check
            .captures(&ddl)
            .ok_or_else(|| anyhow!("unrecognized sessions observer mode constraint"))?;
        let mode = captures
            .get(1)
            .ok_or_else(|| anyhow!("missing observer mode"))?;
        if mode.as_str() != "endless" {
            let mut next = ddl.clone();
            next.replace_range(mode.range(), "endless");
            rebuild_sessions(
                &tx,
                &next,
                "sessions_v36",
                Some((
                    "observer_mode",
                    "CASE observer_mode WHEN 'observe' THEN 'off' ELSE observer_mode END",
                )),
            )?;
        }
        tx.pragma_update(None, "user_version", 36i64)?;
        tx.commit().with_context(|| {
            format!(
                "commit schema v35 to v36 observer migration; backup {} remains",
                backup.display()
            )
        })
    })
}

#[cfg(test)]
#[path = "session_observer_migration_tests.rs"]
mod tests;
