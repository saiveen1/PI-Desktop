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
        project(&c, &task("m", "running")).unwrap()["status"],
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
        assert_eq!(project(&c, &task("m", status)).unwrap()["status"], status);
    }
    let active = Candidate {
        turn_status: Some("running".into()),
        ..c
    };
    assert_eq!(
        project(&active, &task("m", "running")).unwrap()["status"],
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

const STEERED_RESULT: &str = "Skipped because new user input is waiting.";
const UNKNOWN_RESULT: &str =
    "Unknown delegation \"missing\". No reusable subagent sessions in this conversation.";

fn failed_task(id: &str, result: Value) -> sessions::UiMessage {
    serde_json::from_value(json!({
        "id": id, "role": "tool", "toolName": "Task", "toolStatus": "error",
        "content": "not a source of attempt evidence", "status": "complete", "isError": true,
        "createdAt": "2026-11-05T12:00:00.000Z",
        "toolArgs": {"agent": "reviewer", "description": "Resume review", "task": "Continue", "resume": "missing"},
        "toolResult": result,
    }))
    .unwrap()
}

#[test]
fn session_attempts_share_the_candidate_cursor_without_becoming_runs() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let a = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let b = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let old = failed_task(
        "legacy",
        json!("Unknown delegation \"missing\". Reusable: reviewer / hidden-reference."),
    );
    let mut skipped = failed_task(
        "skip",
        json!({"content":[{"type":"text","text":STEERED_RESULT}],"details":{}}),
    );
    skipped.tool_call_id = Some("call-skip".into());
    skipped.tool_args = Some(json!({"agent":"reviewer","task":"Review"}));
    let not_projected = failed_task("other-error", json!("Operation aborted"));
    let mut run = task("actual-run", "failed");
    run.tool_status = Some("error".into());
    run.is_error = Some(true);
    run.tool_result.as_mut().unwrap()["details"]["error"] =
        json!({"code":"FAILED","message":STEERED_RESULT});
    for row in [&old, &run, &skipped, &not_projected] {
        sessions::append_message(&db, &a.id, row, None).unwrap();
    }
    sessions::append_message(
        &db,
        &b.id,
        &failed_task("other-session", json!(UNKNOWN_RESULT)),
        None,
    )
    .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let scoped = |offset, status, path| Query {
        session_id: Some(a.id.clone()),
        ..query(offset, 1, status, path)
    };
    let first = list(&db, scoped(0, "ended", None)).unwrap();
    assert_eq!(first, json!({"entries":[],"nextOffset":1}));
    let second = list(
        &db,
        scoped(first["nextOffset"].as_u64().unwrap(), "ended", None),
    )
    .unwrap();
    assert_eq!(
        second,
        json!({"entries":[],"nextOffset":2,"attempts":[{
            "messageId":"skip","toolCallId":"call-skip","createdAt":"2026-11-05T12:00:00.000Z",
            "agentName":"reviewer","task":"Review","outcome":"skipped","reason":STEERED_RESULT
        }]})
    );
    let third = list(
        &db,
        scoped(second["nextOffset"].as_u64().unwrap(), "ended", None),
    )
    .unwrap();
    assert_eq!(third["entries"][0]["messageId"], "actual-run");
    assert_eq!(third["entries"][0]["status"], "failed");
    assert!(third.get("attempts").is_none());
    let fourth = list(
        &db,
        scoped(third["nextOffset"].as_u64().unwrap(), "ended", None),
    )
    .unwrap();
    assert_eq!(
        fourth,
        json!({"entries":[],"nextOffset":null,"attempts":[{
            "messageId":"legacy","createdAt":"2026-11-05T12:00:00.000Z","agentName":"reviewer",
            "description":"Resume review","task":"Continue","resume":"missing","outcome":"rejected",
            "reason":"Unknown delegation."
        }]})
    );
    let empty = json!({"entries":[],"nextOffset":2});
    assert_eq!(list(&db, scoped(1, "running", None)).unwrap(), empty);
    assert_eq!(
        list(&db, scoped(1, "all", Some("/other-project"))).unwrap(),
        empty
    );
    let global = list(&db, Query::default()).unwrap();
    assert_eq!(global["entries"].as_array().unwrap().len(), 1);
    assert!(global.get("attempts").is_none());
    let other = list(
        &db,
        Query {
            session_id: Some(b.id),
            ..Query::default()
        },
    )
    .unwrap();
    assert_eq!(other["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(other["attempts"][0]["messageId"], "other-session");
    db.conn()
        .execute("UPDATE sessions SET deleted_at=1 WHERE id=?1", [&a.id])
        .unwrap();
    assert_eq!(list(&db, scoped(1, "all", None)).unwrap(), empty);
}

#[test]
fn only_known_terminal_parent_task_results_project_bounded_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let mut canonical = failed_task(
        "canonical",
        json!({"content":[{"type":"text","text":UNKNOWN_RESULT}],"details":{"error":UNKNOWN_RESULT}}),
    );
    canonical.tool_args.as_mut().unwrap()["description"] = json!("😀".repeat(3000));
    canonical.tool_args.as_mut().unwrap()["task"] = json!("😀".repeat(3000));
    canonical.tool_args.as_mut().unwrap()["agent"] = json!("😀".repeat(600));
    canonical.tool_args.as_mut().unwrap()["private"] = json!("must not escape");
    sessions::append_message(&db, &s.id, &canonical, None).unwrap();

    let mut unfinished = failed_task("unfinished", json!(UNKNOWN_RESULT));
    unfinished.tool_status = Some("running".into());
    unfinished.status = Some("streaming".into());
    let mut nested = failed_task("nested", json!(STEERED_RESULT));
    nested.parent_tool_call_id = Some("parent".into());
    let mut nested_tool = failed_task("nested-tool", json!(STEERED_RESULT));
    nested_tool.nested_parent_tool_call_id = Some("parent".into());
    let mut mismatch = failed_task("different-resume", json!(UNKNOWN_RESULT));
    mismatch.tool_args.as_mut().unwrap()["resume"] = json!("other");
    let mut content_only = failed_task("content-only", json!("unrecognized result"));
    content_only.content = STEERED_RESULT.into();
    let mut successful = failed_task("successful", json!(STEERED_RESULT));
    successful.tool_status = Some("success".into());
    successful.is_error = None;
    let denied = failed_task(
        "approval",
        json!({"details":{"error":UNKNOWN_RESULT,"code":"approval_denied"}}),
    );
    let malformed = failed_task(
        "malformed",
        json!({"content":[{"type":"text","text":STEERED_RESULT}],"details":{"delegationId":"existing"}}),
    );
    for row in [
        unfinished,
        nested,
        nested_tool,
        mismatch,
        content_only,
        successful,
        denied,
        malformed,
    ] {
        sessions::append_message(&db, &s.id, &row, None).unwrap();
    }
    let page = list(
        &db,
        Query {
            session_id: Some(s.id),
            ..Query::default()
        },
    )
    .unwrap();
    let attempts = page["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 1);
    let attempt = &attempts[0];
    assert_eq!(attempt["messageId"], "canonical");
    assert_eq!(attempt["outcome"], "rejected");
    assert_eq!(attempt["reason"], "Unknown delegation.");
    assert!(attempt.get("private").is_none());
    assert!(attempt.get("toolResult").is_none());
    for (field, limit) in [("agentName", 1024), ("description", 4096), ("task", 4096)] {
        assert_eq!(
            attempt[field].as_str().unwrap().encode_utf16().count(),
            limit
        );
    }
}

#[test]
fn runtime_resume_error_envelopes_project_the_live_reason_after_reload() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    // delegation-chain.ts builds the diagnostic; runtime.ts writes the same
    // text to content and details.error, spreading metadata into details.code.
    let hint = "At most 2 settled chains per agent are retained. Check TaskList's resumable entries for the intended task, or use its recorded report; do not substitute another chain or repeat completed work.";
    let retained_error = format!("Delegation \"missing\" was recorded in this session but its chain is no longer retained for resume. {hint} Reusable: reviewer / hidden-reference.");
    let unknown_error = format!("Unknown delegation \"missing\". No matching Task record is available in this session. {hint} No reusable subagent sessions in this conversation.");
    let runtime_result = |text: &str, code: &str| {
        json!({
            "content": [{"type":"text", "text":text}], "details": {"error":text, "code":code}
        })
    };
    let not_retained = runtime_result(&retained_error, "DELEGATION_RESUME_NOT_RETAINED");
    let unknown = runtime_result(&unknown_error, "DELEGATION_RESUME_UNKNOWN");
    let valid = [
        failed_task("coded-not-retained", not_retained.clone()),
        failed_task("coded-unknown", unknown.clone()),
        failed_task("legacy-unknown", json!(UNKNOWN_RESULT)),
    ];
    let mut no_target = failed_task("no-resume", not_retained.clone());
    no_target
        .tool_args
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("resume");
    let mut blank_target = failed_task("blank-resume", not_retained.clone());
    blank_target.tool_args.as_mut().unwrap()["resume"] = json!("  ");
    let mut running = failed_task("running", not_retained.clone());
    running.tool_status = Some("running".into());
    let mut nested = failed_task("nested", not_retained.clone());
    nested.parent_tool_call_id = Some("parent".into());
    let mut denied = failed_task("denied", not_retained.clone());
    denied.tool_status = Some("denied".into());
    let mut existing_id = not_retained.clone();
    existing_id["details"]["delegationId"] = json!("real-run");
    let mut conflicting_text = not_retained.clone();
    conflicting_text["details"]["error"] = json!("Different error");
    let invalid = [
        no_target,
        blank_target,
        running,
        nested,
        denied,
        failed_task("existing-id", existing_id),
        failed_task("conflicting-text", conflicting_text),
        failed_task(
            "arbitrary-code",
            runtime_result(UNKNOWN_RESULT, "PROVIDER_ERROR"),
        ),
        failed_task("uncoded-not-retained", json!(retained_error)),
        failed_task(
            "metadata-object",
            json!({"content":[{"type":"text","text":unknown_error}],"details":{"error":unknown_error,"metadata":{"code":"DELEGATION_RESUME_UNKNOWN"}}}),
        ),
    ];
    for row in valid.iter().chain(invalid.iter()) {
        sessions::append_message(&db, &session.id, row, None).unwrap();
    }
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let page = list(
        &db,
        Query {
            session_id: Some(session.id),
            ..Query::default()
        },
    )
    .unwrap();
    assert_eq!(page["entries"], json!([]));
    let attempts = page["attempts"].as_array().unwrap();
    assert_eq!(
        attempts
            .iter()
            .map(|attempt| (
                attempt["messageId"].as_str().unwrap(),
                attempt["reason"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("legacy-unknown", "Unknown delegation."),
            ("coded-unknown", "Unknown delegation."),
            ("coded-not-retained", "Resume chain no longer retained."),
        ]
    );
    for entry in attempts {
        assert_eq!(entry["outcome"], "rejected");
        assert_eq!(entry["resume"], "missing");
        assert!(entry.get("delegationId").is_none());
        assert!(entry.get("code").is_none());
    }
    assert!(!page.to_string().contains("hidden-reference"));
}

#[test]
fn legacy_details_only_resume_rejection_survives_reload_without_bypassing_guards() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let error = "Unknown delegation \"old\". Reusable: reviewer / hidden-reference.";
    let legacy = |id, result| {
        let mut row = failed_task(id, result);
        row.tool_args.as_mut().unwrap()["resume"] = json!("old");
        row
    };
    let result = json!({"details":{"error":error}});
    let valid = legacy("legacy-details-only", result.clone());
    let mut denied = legacy("denied", result.clone());
    denied.tool_status = Some("denied".into());
    let mut running = legacy("running", result.clone());
    running.tool_status = Some("running".into());
    let mut nested = legacy("nested", result.clone());
    nested.parent_tool_call_id = Some("parent".into());
    let mut nested_tool = legacy("nested-tool", result.clone());
    nested_tool.nested_parent_tool_call_id = Some("parent".into());
    let invalid = [
        denied,
        running,
        nested,
        nested_tool,
        legacy("wrong-target", json!({"details":{"error":UNKNOWN_RESULT}})),
        legacy(
            "arbitrary-error",
            json!({"details":{"error":"Permission denied"}}),
        ),
        legacy("uncoded-skip", json!({"details":{"error":STEERED_RESULT}})),
        legacy(
            "existing-id",
            json!({"details":{"error":error,"delegationId":"real-run"}}),
        ),
        legacy(
            "unrelated-field",
            json!({"details":{"error":error,"approval":true}}),
        ),
        legacy(
            "unsupported-code-shape",
            json!({"details":{"error":error,"code":"DELEGATION_RESUME_UNKNOWN"}}),
        ),
        legacy(
            "conflict",
            json!({"content":[{"type":"text","text":"Permission denied"}],"details":{"error":error}}),
        ),
        legacy(
            "null-content",
            json!({"content":null,"details":{"error":error}}),
        ),
        legacy(
            "extra-envelope-field",
            json!({"details":{"error":error},"metadata":{}}),
        ),
        legacy(
            "wrong-error-type",
            json!({"details":{"error":{"message":error}}}),
        ),
    ];
    for row in std::iter::once(&valid).chain(invalid.iter()) {
        sessions::append_message(&db, &session.id, row, None).unwrap();
    }
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let page = list(
        &db,
        Query {
            session_id: Some(session.id),
            ..Query::default()
        },
    )
    .unwrap();
    assert_eq!(
        page,
        json!({"entries":[],"nextOffset":null,"attempts":[{
            "messageId":"legacy-details-only","createdAt":"2026-11-05T12:00:00.000Z",
            "agentName":"reviewer","description":"Resume review","task":"Continue",
            "resume":"old","outcome":"rejected","reason":"Unknown delegation."
        }]})
    );
}
