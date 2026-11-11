use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Staged mode storage (ADR mode-definitions). One batch so a fresh database
/// and the v29 -> v30 reconciliation cannot drift in tables, checks or indexes.
///
/// - `mode_snapshots` keeps every definition a session or run used, keyed by
///   the SHA-256 of its JSON. Rows are immutable: editing a mode never changes
///   a running run.
/// - `mode_runs` is the run state machine. The partial unique index allows at
///   most one open run per session.
/// - `mode_gate_results` records every gate the Host evaluated.
pub(crate) const MODE_RUNS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS mode_snapshots (
  hash       TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mode_runs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  mode_id          TEXT NOT NULL,
  snapshot_hash    TEXT NOT NULL REFERENCES mode_snapshots(hash),
  input            TEXT NOT NULL,
  stage_id         TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN (
    'running', 'waiting', 'paused', 'budget_exhausted', 'finished', 'stopped'
  )),
  wait_reason      TEXT CHECK (wait_reason IN ('approval', 'retries', 'turn_end', 'error')),
  last_error       TEXT,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_turn_id   TEXT,
  active_origin    TEXT CHECK (active_origin IN ('user', 'approval', 'host')),
  stage_entered    INTEGER NOT NULL DEFAULT 1 CHECK (stage_entered IN (0, 1)),
  advanced_in_turn INTEGER NOT NULL DEFAULT 0 CHECK (advanced_in_turn IN (0, 1)),
  pending_gate     INTEGER,
  retry_counts     TEXT NOT NULL DEFAULT '{}',
  rounds_completed INTEGER NOT NULL DEFAULT 0 CHECK (rounds_completed >= 0),
  tokens_used      INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  max_turns        INTEGER,
  max_tokens       INTEGER,
  artifact_paths   TEXT NOT NULL,
  settled_turns    TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  CHECK ((state = 'waiting') = (wait_reason IS NOT NULL)),
  CHECK ((active_turn_id IS NULL) = (active_origin IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mode_runs_one_open
  ON mode_runs(session_id)
  WHERE state IN ('running', 'waiting', 'paused', 'budget_exhausted');
CREATE INDEX IF NOT EXISTS idx_mode_runs_session
  ON mode_runs(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mode_gate_results (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES mode_runs(id) ON DELETE CASCADE,
  stage_id     TEXT NOT NULL,
  gate_index   INTEGER NOT NULL CHECK (gate_index >= 0),
  action       TEXT NOT NULL CHECK (action IN ('require', 'run', 'ask')),
  passed       INTEGER CHECK (passed IN (0, 1)),
  evidence     TEXT CHECK (evidence IS NULL OR length(evidence) <= 8192),
  tool_call_id TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mode_gate_results_run
  ON mode_gate_results(run_id, id);
"#;

/// Both branches published v29: delegation history or staged mode runs.
/// Add only missing objects, retaining existing snapshots, runs and approvals.
fn reconcile_v29_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_snapshot_hash: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions')
                       WHERE name = 'mode_snapshot_hash')",
        [],
        |row| row.get(0),
    )?;
    if !has_snapshot_hash {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN mode_snapshot_hash TEXT;")?;
    }
    tx.execute_batch(MODE_RUNS_SCHEMA)?;
    super::project_path_migration::reconcile_project_paths(tx, None)?;
    tx.execute_batch(super::delegation_history_migration::DDL)?;
    tx.pragma_update(None, "user_version", 30i64)?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 29)?;
    let tx = conn.unchecked_transaction()?;
    reconcile_v29_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v29 to v30 reconciliation; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::*;

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn has_table(conn: &Connection, table: &str) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Build a genuine v28 file: the v29 objects are removed again, so the
    /// upgrade has to create every one of them.
    fn v28_database(path: &Path) {
        let db = Database::open(path).unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO sessions(id,title,mode,created_at,updated_at)
                   VALUES ('plan-session','Saved plan','plan',1,1),
                          ('goal-session','Saved goal','goal',1,1);
                 INSERT INTO turns(id,session_id,status,started_at,ended_at)
                   VALUES ('saved-turn','plan-session','completed',1,2);
                 DROP TABLE mode_gate_results;
                 DROP TABLE mode_runs;
                 DROP TABLE mode_snapshots;
                 ALTER TABLE sessions DROP COLUMN mode_snapshot_hash;
                 DROP INDEX idx_messages_task_history;
                 PRAGMA user_version=28;",
            )
            .unwrap();
    }

    #[test]
    fn schema_28_upgrades_with_data_preserved_and_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        assert!(!has_column(
            &Connection::open(&path).unwrap(),
            "sessions",
            "mode_snapshot_hash"
        ));

        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert_eq!(SCHEMA_VERSION, 30);
        assert!(has_column(db.conn(), "sessions", "mode_snapshot_hash"));
        for table in ["mode_snapshots", "mode_runs", "mode_gate_results"] {
            assert!(has_table(db.conn(), table), "{table}");
        }
        let modes: Vec<(String, String, Option<String>)> = db
            .conn()
            .prepare("SELECT id, mode, mode_snapshot_hash FROM sessions ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            modes,
            vec![
                ("goal-session".into(), "goal".into(), None),
                ("plan-session".into(), "plan".into(), None)
            ]
        );
        let turns: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM turns", [], |row| row.get(0))
            .unwrap();
        assert_eq!(turns, 1);
        let backup = Connection::open(migration_backup_path(&path, 28)).unwrap();
        assert_eq!(version(&backup), 28);
        assert!(!has_table(&backup, "mode_runs"));
    }

    #[test]
    fn fresh_database_has_mode_tables_and_one_open_run_per_session() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_column(db.conn(), "sessions", "mode_snapshot_hash"));
        db.conn()
            .execute_batch(
                "INSERT INTO sessions(id,created_at,updated_at) VALUES ('s',1,1);
                 INSERT INTO mode_snapshots(hash,json,created_at) VALUES ('h','{}','t');
                 INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
                   state,artifact_paths,created_at,updated_at)
                   VALUES ('r1','s','review','h','go','draft','paused','{}',1,1);",
            )
            .unwrap();
        let second = db.conn().execute(
            "INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
               state,artifact_paths,created_at,updated_at)
               VALUES ('r2','s','review','h','go','draft','running','{}',1,1)",
            [],
        );
        assert!(second.is_err(), "a second open run must be refused");
        db.conn()
            .execute_batch(
                "UPDATE mode_runs SET state='finished' WHERE id='r1';
                 INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,
                   state,artifact_paths,created_at,updated_at)
                   VALUES ('r2','s','review','h','go','draft','running','{}',1,1);",
            )
            .unwrap();
        // A waiting run must say why; any other state must not.
        assert!(db
            .conn()
            .execute("UPDATE mode_runs SET state='waiting' WHERE id='r2'", [])
            .is_err());
        // Deleting the session removes its runs.
        db.conn()
            .execute("DELETE FROM sessions WHERE id='s'", [])
            .unwrap();
        let runs: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM mode_runs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(runs, 0);
    }

    #[test]
    fn future_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        db.conn()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(db);
        let error = Database::open(&path)
            .err()
            .expect("future schema must be refused");
        assert!(error.to_string().contains("is newer than supported"));
    }

    #[test]
    fn schema_27_chains_through_the_project_path_step_into_30() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 27)
            .unwrap();
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), SCHEMA_VERSION);
        assert!(has_table(db.conn(), "mode_runs"));
        for schema in [27, 28, 29] {
            let backup = Connection::open(migration_backup_path(&path, schema)).unwrap();
            assert_eq!(version(&backup), schema);
        }
    }

    #[test]
    fn read_only_failure_keeps_source_schema_and_can_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 29)
            .unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "query_only", true).unwrap();
        assert!(super::migrate(&conn, &path).is_err());
        assert_eq!(version(&conn), 29);
        assert!(!has_table(&conn, "mode_runs"));
        conn.pragma_update(None, "query_only", false).unwrap();
        super::migrate(&conn, &path).unwrap();
        assert_eq!(version(&conn), 30);
        assert!(has_table(&conn, "mode_runs"));
    }

    fn has_history_index(conn: &Connection) -> bool {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='idx_messages_task_history' AND type='index')",
            [], |row| row.get(0),
        ).unwrap()
    }

    #[test]
    fn both_v29_variants_reconcile_losslessly_and_reopen_idempotently() {
        for upstream in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("pi.sqlite");
            v28_database(&path);
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "INSERT INTO projects(id,path,name,created_at,last_opened_at) VALUES(42,'/missing/project','Saved project',1,2);
                 UPDATE sessions SET project_id=42;
                 INSERT INTO messages(id,session_id,seq,role,tool_name,created_at)
                   VALUES('task','plan-session',1,'tool','Task',1);
                 INSERT INTO kv(ns,key,value_json,updated_at) VALUES
                   ('sessionDelegation','plan-session','{\"version\":1,\"modelKeys\":[\"p/m\"],\"modelApprovals\":{\"p/m\":\"ask\"}}',1),
                   ('delegationApprovalHistory','v1','{\"version\":1,\"entries\":[]}',1),
                   ('projectGroups','group','{\"id\":\"group\",\"roots\":[\"/missing/project\"]}',1);
                 PRAGMA user_version=29;"
            ).unwrap();
            if upstream {
                conn.execute_batch("ALTER TABLE sessions ADD COLUMN mode_snapshot_hash TEXT;")
                    .unwrap();
                conn.execute_batch(super::MODE_RUNS_SCHEMA).unwrap();
                conn.execute_batch(
                    "INSERT INTO mode_snapshots VALUES('saved-hash','{\"id\":\"saved\"}','saved-time');
                     UPDATE sessions SET mode_snapshot_hash='saved-hash' WHERE id='plan-session';
                     INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,state,artifact_paths,created_at,updated_at)
                       VALUES('saved-run','plan-session','saved','saved-hash','saved input','draft','paused','{}',1,2);
                     INSERT INTO mode_gate_results(run_id,stage_id,gate_index,action,passed,evidence,created_at)
                       VALUES('saved-run','draft',0,'require',1,'saved evidence',1);"
                ).unwrap();
            } else {
                conn.execute_batch(super::super::delegation_history_migration::DDL)
                    .unwrap();
            }
            let saved_kv: Vec<(String, String, String)> = conn
                .prepare("SELECT ns,key,value_json FROM kv ORDER BY ns,key")
                .unwrap()
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let transcript = dir.path().join("transcripts/plan-session.jsonl");
            std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
            std::fs::write(&transcript, b"preserved transcript bytes\n").unwrap();
            drop(conn);

            for _ in 0..2 {
                let db = Database::open(&path).unwrap();
                assert_eq!(version(db.conn()), 30);
                assert!(has_history_index(db.conn()));
                assert!(has_column(db.conn(), "sessions", "mode_snapshot_hash"));
                let kv: Vec<(String, String, String)> = db
                    .conn()
                    .prepare("SELECT ns,key,value_json FROM kv ORDER BY ns,key")
                    .unwrap()
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                assert_eq!(kv, saved_kv);
                assert_eq!(
                    std::fs::read(&transcript).unwrap(),
                    b"preserved transcript bytes\n"
                );
                let owner: i64 = db
                    .conn()
                    .query_row(
                        "SELECT project_id FROM sessions WHERE id='plan-session'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(owner, 42);
                let messages: i64 = db
                    .conn()
                    .query_row(
                        "SELECT count(*) FROM messages WHERE tool_name='Task'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(messages, 1);
                if upstream {
                    let saved: (String, String, String) = db.conn().query_row(
                        "SELECT s.mode_snapshot_hash,r.input,g.evidence FROM sessions s JOIN mode_runs r ON r.session_id=s.id JOIN mode_gate_results g ON g.run_id=r.id",
                        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    ).unwrap();
                    assert_eq!(
                        saved,
                        (
                            "saved-hash".into(),
                            "saved input".into(),
                            "saved evidence".into()
                        )
                    );
                }
            }
            let backup_path = migration_backup_path(&path, 29);
            let original = std::fs::read(&backup_path).unwrap();
            let backup = Connection::open(&backup_path).unwrap();
            assert_eq!(version(&backup), 29);
            assert_eq!(has_table(&backup, "mode_runs"), upstream);
            assert_eq!(has_history_index(&backup), !upstream);
            drop(backup);
            drop(Database::open(&path).unwrap());
            assert_eq!(std::fs::read(backup_path).unwrap(), original);
        }
    }

    #[test]
    fn late_v30_failure_rolls_back_added_tables_column_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        v28_database(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA user_version=29;
             CREATE TABLE idx_messages_task_history(blocked TEXT);",
        )
        .unwrap();
        assert!(super::migrate(&conn, &path).is_err());
        for candidate in [&path, &migration_backup_path(&path, 29)] {
            let original = Connection::open(candidate).unwrap();
            assert_eq!(version(&original), 29);
            assert!(!has_column(&original, "sessions", "mode_snapshot_hash"));
            assert!(!has_table(&original, "mode_runs"));
            assert!(!has_table(&original, "mode_snapshots"));
            assert!(!has_history_index(&original));
        }
        conn.execute_batch("DROP TABLE idx_messages_task_history;")
            .unwrap();
        super::migrate(&conn, &path).unwrap();
        assert_eq!(version(&conn), 30);
        assert!(has_history_index(&conn));
    }
}
