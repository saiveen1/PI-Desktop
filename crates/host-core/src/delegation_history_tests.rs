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
        session_id: None,
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
fn session_scope_precedes_pagination_and_composes_with_existing_filters() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let a = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let b = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let project = crate::db::upsert_project_row(db.conn(), "/history-session-project", false)
        .unwrap()
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET project_id=?1 WHERE id=?2",
            params![project, a.id],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO turns(id,session_id,status,started_at) VALUES ('active',?1,'running',1)",
            [&a.id],
        )
        .unwrap();
    sessions::append_message(&db, &a.id, &task("a-old", "completed"), None).unwrap();
    sessions::append_message(&db, &b.id, &task("b-old", "completed"), None).unwrap();
    sessions::append_message(&db, &a.id, &task("a-running", "running"), Some("active")).unwrap();
    sessions::append_message(&db, &b.id, &task("b-new", "completed"), None).unwrap();
    let scoped = |offset, status, path| Query {
        session_id: Some(a.id.clone()),
        ..query(offset, 1, status, path)
    };
    let first = list(&db, scoped(0, "running", Some("/history-session-project"))).unwrap();
    assert_eq!(first["entries"][0]["messageId"], "a-running");
    assert_eq!(first["entries"][0]["status"], "running");
    assert_eq!(first["nextOffset"], 1);
    let second = list(&db, scoped(1, "ended", Some("/history-session-project"))).unwrap();
    assert_eq!(second["entries"][0]["messageId"], "a-old");
    assert!(second["nextOffset"].is_null());
    let filtered = list(&db, scoped(0, "ended", Some("/history-session-project"))).unwrap();
    assert_eq!(filtered["entries"], json!([]));
    assert_eq!(filtered["nextOffset"], 1);
    assert_eq!(
        list(&db, scoped(0, "all", Some("/other-project"))).unwrap()["entries"],
        json!([])
    );
    let missing = Query {
        session_id: Some("missing".into()),
        ..Query::default()
    };
    assert_eq!(
        list(&db, missing).unwrap(),
        json!({"entries":[],"nextOffset":null})
    );
    db.conn()
        .execute("UPDATE sessions SET deleted_at=1 WHERE id=?1", [&a.id])
        .unwrap();
    let deleted = list(&db, scoped(0, "all", None)).unwrap();
    assert_eq!(deleted["entries"], json!([]));
    assert_eq!(deleted["nextOffset"], 1);
}

#[test]
fn session_identity_validation_matches_the_shared_boundary() {
    for id in [
        "",
        " ",
        " s",
        "s ",
        "\u{feff}s",
        &"x".repeat(257),
        &"😀".repeat(129),
    ] {
        let query: Query = serde_json::from_value(json!({"sessionId":id})).unwrap();
        assert!(check(&query).is_err(), "accepted {id:?}");
    }
    for id in ["s", &"😀".repeat(128)] {
        let query: Query = serde_json::from_value(json!({"sessionId":id})).unwrap();
        assert!(check(&query).is_ok());
    }
    for value in [json!(null), json!(42)] {
        assert!(serde_json::from_value::<Query>(json!({"sessionId":value})).is_err());
    }
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

#[test]
fn recorded_usage_survives_reload_without_copying_unbounded_operation_data() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let mut row = task("metrics", "completed");
    let details = &mut row.tool_result.as_mut().unwrap()["details"];
    details["usage"] = json!({"inputTokens":80,"outputTokens":20,"totalTokens":100,
        "operations":[{"private":"never projected"}]});
    details["turns"] = json!(3);
    details["toolCalls"] = json!(2);
    sessions::append_message(&db, &session.id, &row, None).unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let page = list(&db, Query::default()).unwrap();
    let entry = &page["entries"][0];
    assert_eq!(entry["startedAt"], ms_to_ts(1793880000000));
    assert_eq!(
        entry["usage"],
        json!({"inputTokens":80,"outputTokens":20,"totalTokens":100})
    );
    assert_eq!(entry["turns"], 3);
    assert_eq!(entry["toolCalls"], 2);

    let mut legacy = task("legacy-metrics", "completed");
    let details = legacy.tool_result.as_mut().unwrap()["details"]
        .as_object_mut()
        .unwrap();
    details.remove("startedAt");
    details.insert(
        "usage".into(),
        json!({"inputTokens":1,"outputTokens":-1,"totalTokens":0}),
    );
    details.insert("turns".into(), json!(1.5));
    sessions::append_message(&db, &session.id, &legacy, None).unwrap();
    let page = list(&db, Query::default()).unwrap();
    let entry = &page["entries"][0];
    assert!(entry.get("startedAt").is_none());
    assert!(entry.get("usage").is_none());
    assert!(entry.get("turns").is_none());
    assert!(entry.get("toolCalls").is_none());
}

#[test]
fn lifecycle_projection_is_bounded_allowlisted_and_durable() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let mut row = task("observation", "completed");
    let observed = json!({"version":1,"selectedModel":"account/model","phase":"ended",
        "lastActivityAt":120,"executionStartedAt":100,"executionEndedAt":120,
        "reportProducedAt":120,"reportDeliveredAt":125,"lastMeaningfulProgressAt":110,
        "diagnostic":{"state":"ended","observedAt":120,"thresholdMs":30000,"reason":"Run ended"},
        "attemptCount":1,"attemptsOmitted":0,"approvalsOmitted":0,"completedToolCalls":0,
        "failedToolCalls":0,"pendingToolsOmitted":0,"confirmedWritePathsOmitted":0,
        "attempts":[{"sequence":1,"model":"account/model","startedAt":100,"finishedAt":120,
            "outcome":"completed","providerDurationMs":20,"usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15},
            "credentials":"must not escape"}],"approvals":[],"pendingTools":[],"recentTools":[],
        "confirmedWritePaths":[],"thinking":"must not escape"});
    row.tool_result.as_mut().unwrap()["details"]["observation"] = observed.clone();
    sessions::append_message(&db, &session.id, &row, None).unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let page = list(&db, Query::default()).unwrap();
    let result = &page["entries"][0]["observation"];
    assert_eq!(result["reportDeliveredAt"], 125);
    assert_eq!(result["attempts"][0]["usage"]["outputTokens"], 5);
    assert!(result.get("thinking").is_none());
    assert!(result["attempts"][0].get("credentials").is_none());
    let mut unresolved = observed.clone();
    unresolved["attempts"] =
        json!([{"sequence":1,"model":"account/model","startedAt":100,"outcome":"unresolved"}]);
    let projected = observation::project(&unresolved).unwrap();
    assert_eq!(projected["attempts"][0]["outcome"], "unresolved");
    assert!(projected["attempts"][0].get("finishedAt").is_none());
    assert!(projected["attempts"][0].get("providerDurationMs").is_none());
    let mut invalid = observed.clone();
    invalid["attempts"] = json!(vec![observed["attempts"][0].clone(); 65]);
    assert!(observation::project(&invalid).is_none());
    invalid = observed.clone();
    invalid["attemptCount"] = json!(2);
    assert!(observation::project(&invalid).is_none());
    invalid = observed;
    invalid["attempts"][0]["usage"]["outputTokens"] = json!(-1);
    assert!(observation::project(&invalid).is_none());
}

#[test]
fn history_preserves_only_recorded_valid_effort_without_inventing_legacy_values() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let cases = [
        (None, None),
        (Some(json!("off")), Some("off")),
        (Some(json!("omit")), Some("omit")),
        (Some(json!("minimal")), Some("minimal")),
        (Some(json!("low")), Some("low")),
        (Some(json!("medium")), Some("medium")),
        (Some(json!("high")), Some("high")),
        (Some(json!("xhigh")), Some("xhigh")),
        (Some(json!("max")), Some("max")),
        (Some(json!("unknown")), None),
        (Some(json!(" high")), None),
        (Some(json!(null)), None),
        (Some(json!(3)), None),
        (Some(json!(["high"])), None),
    ];
    for (index, (recorded, expected)) in cases.iter().enumerate() {
        let id = format!("effort-{index}");
        let mut message = task(&id, "completed");
        message.tool_args.as_mut().unwrap()["thinkingLevel"] = json!("low");
        if let Some(value) = recorded {
            message.tool_result.as_mut().unwrap()["details"]["thinkingLevel"] = value.clone();
        }
        sessions::append_message(&db, &session.id, &message, None).unwrap();
        let page = list(&db, Query::default()).unwrap();
        let entry = page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["messageId"] == id)
            .unwrap();
        assert_eq!(entry["modelId"], "actual");
        assert_eq!(entry["requestedModel"], "requested");
        assert_eq!(entry["status"], "completed");
        assert_eq!(
            entry.get("thinkingLevel"),
            expected.map(|s| json!(s)).as_ref()
        );
    }
}

#[test]
fn history_uses_recorded_scheduling_metadata_when_resume_args_omit_selection() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let message: sessions::UiMessage = serde_json::from_value(json!({
        "id": "resume-row",
        "role": "tool",
        "toolName": "Task",
        "content": "Task resumed",
        "createdAt": "2026-11-05T12:00:00.000Z",
        "toolArgs": {"agent": "reviewer", "task": "continue", "resume": "prior"},
        "toolResult": {"details": {
            "delegationId": "next",
            "agent": "reviewer",
            "status": "completed",
            "modelId": "actual",
            "thinkingLevel": "low",
            "requestedThinkingLevel": "high",
            "scheduling": {"requestedModel": "account/specialist", "modelReason": "The specialist owns this review.", "decisions": []}
        }}
    })).unwrap();
    sessions::append_message(&db, &session.id, &message, None).unwrap();
    let entry = list(&db, Query::default()).unwrap()["entries"][0].clone();
    assert_eq!(entry["requestedModel"], "account/specialist");
    assert_eq!(entry["modelReason"], "The specialist owns this review.");
    assert_eq!(entry["thinkingLevel"], "low");
}
