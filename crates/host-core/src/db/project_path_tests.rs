use super::*;

fn schema_combination_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn schema_combination_has_index(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_task_history')",
        [], |row| row.get(0),
    ).unwrap()
}

fn schema_combination_owners(conn: &Connection, table: &str) -> Vec<i64> {
    conn.prepare(&format!("SELECT project_id FROM {table} ORDER BY id"))
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn schema_combination_fixture(
    version: i64,
    history_index: bool,
    repaired: bool,
) -> (tempfile::TempDir, PathBuf, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let folder = root.join("Project");
    std::fs::create_dir(&folder).unwrap();
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    // A trailing separator aliases the same real directory on every platform.
    let alias = format!("{canonical}/");
    let file = root.join("pi.sqlite");
    let db = Database::open(&file).unwrap();
    for (id, path, pinned, opened) in [(101, &canonical, 0, 20), (202, &alias, 1, 10)] {
        db.conn().execute(
            "INSERT INTO projects(id,path,name,pinned,created_at,last_opened_at) VALUES(?1,?2,'Retained project',?3,1,?4)",
            params![id, path, pinned, opened],
        ).unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES(?1,?2,1,1)",
                params![format!("session-{id}"), id],
            )
            .unwrap();
        db.conn().execute(
            "INSERT INTO scheduled_tasks(id,title,prompt,project_id,created_at,updated_at) VALUES(?1,'Task','Retained prompt',?2,1,1)",
            params![format!("task-{id}"), id],
        ).unwrap();
        db.kv_set("projectMemory", path, &serde_json::json!({"memory": id}))
            .unwrap();
    }
    db.kv_set("app", "currentProjectId", &serde_json::json!(202))
        .unwrap();
    if repaired {
        super::project_path_migration::reconcile_project_paths(db.conn(), None).unwrap();
    }
    if !history_index {
        db.conn()
            .execute_batch("DROP INDEX idx_messages_task_history;")
            .unwrap();
    }
    db.conn()
        .pragma_update(None, "user_version", version)
        .unwrap();
    drop(db);
    (dir, file, canonical, alias)
}

fn assert_schema_combination_upgrade(version: i64, history_index: bool, repaired: bool) {
    let (_dir, file, canonical, alias) =
        schema_combination_fixture(version, history_index, repaired);
    let db = Database::open(&file).unwrap();
    // Query raw SQL first: list_projects/ensure_project can otherwise hide a skipped migration.
    let projects: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        projects, 1,
        "schema {version} must reconcile before any project API read"
    );
    assert!(
        schema_combination_has_index(db.conn()),
        "schema {version} must gain the history index"
    );
    assert_eq!(schema_combination_version(db.conn()), 30);
    assert_eq!(
        schema_combination_owners(db.conn(), "sessions"),
        vec![101, 101]
    );
    assert_eq!(
        schema_combination_owners(db.conn(), "scheduled_tasks"),
        vec![101, 101]
    );
    assert_eq!(
        db.kv_get("app", "currentProjectId").unwrap(),
        Some(serde_json::json!(101))
    );
    assert_eq!(
        db.kv_get("projectMemory", &canonical).unwrap(),
        Some(serde_json::json!({"memory": 101}))
    );
    assert_eq!(
        db.kv_get("projectMemory", &alias).unwrap(),
        Some(serde_json::json!({"memory": 202}))
    );
    let project: (String, bool) = db
        .conn()
        .query_row("SELECT path,pinned FROM projects", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(project, (canonical, true));
    let backup_path = migration_backup_path(&file, version);
    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(schema_combination_version(&backup), version);
    assert_eq!(schema_combination_has_index(&backup), history_index);
    assert_eq!(
        schema_combination_owners(&backup, "sessions"),
        if repaired {
            vec![101, 101]
        } else {
            vec![101, 202]
        }
    );
    if version < 29 {
        let intermediate = Connection::open(migration_backup_path(&file, 28)).unwrap();
        assert_eq!(schema_combination_version(&intermediate), 28);
        assert_eq!(schema_combination_has_index(&intermediate), history_index);
    }
    drop(backup);
    drop(db);
    let bytes = std::fs::read(&backup_path).unwrap();
    let db = Database::open(&file).unwrap();
    assert_eq!(schema_combination_version(db.conn()), 30);
    assert_eq!(
        std::fs::read(backup_path).unwrap(),
        bytes,
        "reopen preserves the original backup"
    );
}

#[test]
fn schema_combination_fresh_has_history_index() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert!(schema_combination_has_index(db.conn()));
    assert_eq!(schema_combination_version(db.conn()), 30);
}

#[test]
fn schema_combination_v27_applies_both_migrations() {
    assert_schema_combination_upgrade(27, false, false);
}

#[test]
fn schema_combination_main_v28_gains_history_index() {
    assert_schema_combination_upgrade(28, false, true);
}

#[test]
fn schema_combination_notification_v28_reconciles_projects() {
    assert_schema_combination_upgrade(28, true, false);
}

#[test]
fn schema_combination_both_v29_shapes_reconcile_projects() {
    assert_schema_combination_upgrade(29, false, false);
    assert_schema_combination_upgrade(29, true, true);
}

#[test]
fn schema_combination_failure_rolls_back_ownership_and_retains_backup() {
    assert_schema_combination_failure(28);
    assert_schema_combination_failure(29);
}

fn assert_schema_combination_failure(version: i64) {
    let (_dir, file, canonical, alias) = schema_combination_fixture(version, false, false);
    let conn = Connection::open(&file).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_combined_migration AFTER UPDATE OF path ON projects BEGIN SELECT RAISE(ABORT,'blocked combined migration'); END;").unwrap();
    drop(conn);
    let error = Database::open(&file)
        .err()
        .expect("failed repair must refuse open");
    assert!(format!("{error:#}").contains("blocked combined migration"));
    for path in [&file, &migration_backup_path(&file, version)] {
        let conn = Connection::open(path).unwrap();
        assert_eq!(schema_combination_version(&conn), version);
        assert!(!schema_combination_has_index(&conn));
        assert_eq!(schema_combination_owners(&conn, "sessions"), vec![101, 202]);
        assert_eq!(
            schema_combination_owners(&conn, "scheduled_tasks"),
            vec![101, 202]
        );
        let owner: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE ns='app' AND key='currentProjectId'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owner, "202");
        for (key, id) in [(&canonical, 101), (&alias, 202)] {
            let value: String = conn
                .query_row(
                    "SELECT value_json FROM kv WHERE ns='projectMemory' AND key=?1",
                    params![key],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&value).unwrap(),
                serde_json::json!({"memory": id})
            );
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }
}

#[test]
fn unicode_case_aliases_use_the_same_native_project_identity() {
    for (name, alias) in [("Älpha", "älpha"), ("Σ", "ς")] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let folder = root.join(name);
        let alias = root.join(alias);
        let db = Database::open(&root.join("pi.sqlite")).unwrap();
        let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
        std::fs::create_dir(&folder).unwrap();
        if !alias.exists() {
            continue;
        }
        assert_eq!(
            db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
            first
        );
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }
}

#[test]
fn project_path_upgrade_preserves_every_owner_and_reuses_the_project() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha").to_string_lossy().replace('\\', "/");
    std::fs::create_dir(&folder).unwrap();
    if !std::path::Path::new(&alias).exists() {
        return; // Distinct directories on a case-sensitive filesystem.
    }
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let file = root.join("pi.sqlite");
    let (first, second);
    {
        let db = Database::open(&file).unwrap();
        first = db.ensure_project(&canonical, false).unwrap();
        db.conn().execute(
            "INSERT INTO projects(path,name,pinned,created_at,last_opened_at) VALUES(?1,'Keep this name',1,1,2)",
            params![alias],
        ).unwrap();
        second = db.conn().last_insert_rowid();
        for (id, project) in [("canonical", first), ("alias", second)] {
            db.conn()
                .execute(
                    "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES(?1,?2,1,1)",
                    params![id, project],
                )
                .unwrap();
            db.conn().execute("INSERT INTO scheduled_tasks(id,title,prompt,project_id,created_at,updated_at) VALUES(?1,'Task','Prompt',?2,1,1)", params![id, project]).unwrap();
        }
        db.kv_set("app", "currentProjectId", &serde_json::json!(second))
            .unwrap();
        db.conn().pragma_update(None, "user_version", 27).unwrap();
    }
    let db = Database::open(&file).unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
    let keep = db.ensure_project(&alias, false).unwrap();
    assert_eq!(db.ensure_project(&canonical, false).unwrap(), keep);
    let owners: Vec<i64> = db
        .conn()
        .prepare("SELECT project_id FROM sessions ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(owners, vec![keep, keep]);
    let tasks: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM scheduled_tasks WHERE project_id=?1",
            params![keep],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tasks, 2);
    assert!(db.get_project(keep).unwrap().unwrap().pinned);
    assert_eq!(
        db.kv_get("app", "currentProjectId").unwrap(),
        Some(serde_json::json!(keep))
    );
    assert!(migration_backup_path(&file, 27).exists());
}

#[test]
fn project_created_before_directory_exists_is_not_duplicated_when_it_appears() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let second = db.ensure_project(folder.to_str().unwrap(), false).unwrap();
    assert_eq!(first, second);
    assert_eq!(db.list_projects().unwrap().len(), 1);
}

#[test]
fn case_sensitive_project_identities_stay_distinct() {
    let root = tempfile::tempdir().unwrap();
    let upper = root.path().join("Alpha");
    let lower = root.path().join("alpha");
    std::fs::create_dir(&upper).unwrap();
    if lower.exists() {
        return;
    }
    std::fs::create_dir(&lower).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    assert_ne!(
        db.ensure_project(upper.to_str().unwrap(), false).unwrap(),
        db.ensure_project(lower.to_str().unwrap(), false).unwrap()
    );
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn opaque_remote_project_identities_are_not_case_folded() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    for path in ["remote-project:Alpha", "remote-project:alpha"] {
        db.conn()
            .execute(
                "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Remote',1,1)",
                params![path],
            )
            .unwrap();
    }
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn historical_group_case_alias_keeps_its_context_and_remains_addressable() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let mut group = db
        .create_project_group("Kept group", &[folder.to_string_lossy().into_owned()])
        .unwrap();
    group.primary_path = alias.to_string_lossy().replace('\\', "/");
    group.roots[0].path = group.primary_path.clone();
    db.kv_set(
        "projectGroups",
        &group.id,
        &serde_json::to_value(&group).unwrap(),
    )
    .unwrap();
    db.set_project_group_instructions(&group.id, "Preserve group instructions")
        .unwrap();
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let restored = db
        .stored_project_group_for_path(&canonical)
        .unwrap()
        .unwrap();
    assert_eq!(restored.id, group.id);
    assert_eq!(restored.primary_path, canonical);
    assert_eq!(
        db.get_project_group_instructions(&group.id).unwrap(),
        "Preserve group instructions"
    );
}

#[cfg(unix)]
#[test]
fn deleting_a_stored_symlink_path_does_not_retarget_to_another_project() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("unrelated");
    let link = root.path().join("old-link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    let unrelated = db.ensure_project(target.to_str().unwrap(), false).unwrap();
    db.conn()
        .execute(
            "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Stored',1,1)",
            params![link.to_str()],
        )
        .unwrap();
    assert!(db.delete_project(link.to_str().unwrap()).unwrap());
    assert!(db.get_project(unrelated).unwrap().is_some());
}

#[test]
fn path_repair_is_atomic_and_can_run_inside_an_import_transaction() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let tx = db.conn().unchecked_transaction().unwrap();
    assert_eq!(
        db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
        first
    );
    tx.rollback().unwrap();
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        normalize_project_path(alias.to_str().unwrap()).unwrap()
    );
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    db.conn()
        .execute(
            "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Duplicate',1,1)",
            params![canonical],
        )
        .unwrap();
    db.conn().execute_batch("CREATE TRIGGER reject_merge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    assert!(db.list_projects().is_err());
    let count: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        normalize_project_path(alias.to_str().unwrap()).unwrap()
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_merge")
        .unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
}
