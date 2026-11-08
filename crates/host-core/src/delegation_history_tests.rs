use super::*;
fn task(id: &str, status: &str) -> sessions::UiMessage {
    serde_json::from_value(json!({"id":id,"role":"tool","toolName":"Task","content":"Task result",
        "createdAt":"2026-11-05T12:00:00.000Z","toolArgs":{"task":"文".repeat(TEXT_LIMIT+1),"description":"Original objective","reason":"Task fit","model":"requested"},
        "toolResult":{"details":{"delegationId":format!("d-{id}"),"agent":"reviewer","status":status,
        "startedAt":1793880000000i64,"completedAt":1793880001000i64,"modelId":"actual","report":"x".repeat(TEXT_LIMIT+1)}}})).unwrap()
}
fn query(offset: u64, limit: u64, status: &str, path: Option<&str>) -> Query {
    Query {
        offset: Some(offset),
        limit: Some(limit),
        status: Some(status.into()),
        project_path: path.map(str::to_owned),
    }
}
#[test]
fn canonical_old_rows_projects_deleted_and_candidate_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let a = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let b = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let p = crate::db::upsert_project_row(db.conn(), "/history-project-a", false)
        .unwrap()
        .unwrap();
    let q = crate::db::upsert_project_row(db.conn(), "/history-project-b", false)
        .unwrap()
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET project_id=?1 WHERE id=?2",
            params![p, a.id],
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET project_id=?1 WHERE id=?2",
            params![q, b.id],
        )
        .unwrap();
    sessions::append_message(&db, &a.id, &task("old", "completed"), None).unwrap();
    sessions::append_message(&db, &b.id, &task("new", "running"), None).unwrap();
    let first = list(&db, query(0, 1, "all", Some("/history-project-a"))).unwrap();
    assert_eq!(first["entries"], json!([]));
    assert_eq!(first["nextOffset"], 1);
    let second = list(&db, query(1, 1, "ended", Some("/history-project-a"))).unwrap();
    let row = &second["entries"][0];
    assert_eq!(row["messageId"], "old");
    assert_eq!(row["status"], "completed");
    assert_eq!(row["createdAt"], ms_to_ts(1793880000000));
    assert_eq!(row["completedAt"], ms_to_ts(1793880001000));
    assert_eq!(row["description"], "Original objective");
    assert_eq!(row["modelId"], "actual");
    assert_eq!(row["taskTruncated"], true);
    assert_eq!(row["reportTruncated"], true);
    assert_eq!(row["task"].as_str().unwrap().chars().count(), TEXT_LIMIT);
    assert!(second["nextOffset"].is_null());
    let interrupted = list(&db, query(0, 1, "ended", None)).unwrap();
    assert_eq!(interrupted["entries"][0]["status"], "interrupted");
    assert_eq!(
        list(&db, query(0, 1, "running", None)).unwrap()["entries"],
        json!([])
    );
    db.conn()
        .execute("UPDATE sessions SET deleted_at=1 WHERE id=?1", [&b.id])
        .unwrap();
    assert_eq!(
        list(&db, query(0, 1, "all", None)).unwrap()["entries"],
        json!([])
    );
    assert_eq!(
        list(&db, query(1, 1, "all", None)).unwrap()["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn terminal_turn_interrupts_running_snapshot_and_preserves_other_terminal_states() {
    let c = Candidate {
        id: "m".into(),
        session: "s".into(),
        title: "Title".into(),
        path: None,
        project: None,
        turn_status: Some("completed".into()),
        ended: Some(1000),
    };
    assert_eq!(
        project(&c, task("m", "running")).unwrap()["status"],
        "interrupted"
    );
    for status in [
        "completed",
        "failed",
        "stopped",
        "aborted",
        "timed_out",
        "interrupted",
    ] {
        assert_eq!(project(&c, task("m", status)).unwrap()["status"], status);
    }
    let active = Candidate {
        turn_status: Some("running".into()),
        ..c
    };
    assert_eq!(
        project(&active, task("m", "running")).unwrap()["status"],
        "running"
    );
}
#[test]
fn migration_is_backed_up_rebuildable_and_preserves_existing_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = sessions::create_session(&db, None, None, None, None, None).unwrap();
    sessions::append_message(&db, &s.id, &task("legacy", "completed"), None).unwrap();
    db.conn()
        .execute_batch("DROP INDEX idx_messages_task_history; PRAGMA user_version=27;")
        .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
    assert!(dir.path().join("pi.sqlite.v27.bak").exists());
    assert!(dir.path().join("pi.sqlite.v28.bak").exists());
    assert_eq!(
        list(&db, Query::default()).unwrap()["entries"][0]["messageId"],
        "legacy"
    );
}

#[test]
fn truncation_never_exceeds_the_shared_utf16_bound() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let mut row = task("emoji", "completed");
    row.tool_args = Some(json!({ "task": "😀".repeat(20_000) }));
    let details = &mut row.tool_result.as_mut().unwrap()["details"];
    details["agent"] = json!("😀".repeat(2_000));
    details["report"] = json!("😀".repeat(20_000));
    details["error"] = json!({"code":"😀".repeat(200), "message":"😀".repeat(20_000)});
    sessions::append_message(&db, &session.id, &row, None).unwrap();
    let page = list(&db, Query::default()).unwrap();
    let entry = &page["entries"][0];
    assert_eq!(entry["taskTruncated"], true);
    assert!(entry["task"].as_str().unwrap().encode_utf16().count() <= TEXT_LIMIT);
    assert_eq!(entry["reportTruncated"], true);
    for (field, limit) in [("agentName", 1024), ("report", TEXT_LIMIT)] {
        assert!(entry[field].as_str().unwrap().encode_utf16().count() <= limit);
    }
    assert!(
        entry["error"]["code"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count()
            <= 256
    );
    assert!(
        entry["error"]["message"]
            .as_str()
            .unwrap()
            .encode_utf16()
            .count()
            <= TEXT_LIMIT
    );
}
