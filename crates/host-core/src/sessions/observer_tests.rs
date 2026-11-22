use super::*;

fn message() -> UiMessage {
    serde_json::from_value(json!({
        "id": "observer-message", "role": "assistant", "content": "Synthetic reply",
        "createdAt": "2026-01-01T00:00:00Z", "status": "complete",
        "runDiagnostics": {
            "elapsedMs": 17,
            "observer": { "version": 1, "mode": "observe", "assessment": { "status": "clear" } }
        }
    }))
    .unwrap()
}

#[test]
fn observer_defaults_off_for_legacy_wire_and_new_conversations() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    assert_eq!(session.observer_mode, ObserverMode::Off);
    let mut legacy = serde_json::to_value(&session).unwrap();
    assert_eq!(legacy["observerMode"], "off");
    legacy.as_object_mut().unwrap().remove("observerMode");
    let restored: SessionSummary = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(restored.observer_mode, ObserverMode::Off);
    for invalid in [
        json!(null),
        json!(true),
        json!(false),
        json!([]),
        json!({}),
        json!({"guard": null}),
        json!(1),
        json!("Guard"),
        json!("enabled"),
        json!("observe"),
    ] {
        legacy["observerMode"] = invalid;
        assert!(serde_json::from_value::<SessionSummary>(legacy.clone()).is_err());
    }
}

#[test]
fn observer_diagnostics_and_mode_survive_reopen_search_and_trash_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session_with_options(
        &db,
        SessionCreateOptions {
            title: Some("Observer fixture".into()),
            observer_mode: ObserverMode::Guard,
            ..Default::default()
        },
    )
    .unwrap();
    let message = message();
    append_message(&db, &session.id, &message, None).unwrap();
    drop(db);

    let db = Database::open_in_dir(dir.path()).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.summary.observer_mode, ObserverMode::Guard);
    assert_eq!(detail.messages[0].run_diagnostics, message.run_diagnostics);
    let records = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
    assert_eq!(
        records[0].meta.as_ref().unwrap()["runDiagnostics"],
        message.run_diagnostics.clone().unwrap()
    );
    let hits = crate::session_search::search(&db, "Observer", 0, 30).unwrap();
    assert_eq!(hits.hits[0].session.observer_mode, ObserverMode::Guard);
    assert!(crate::session_trash::trash(&db, &session.id).unwrap());
    assert_eq!(
        crate::session_trash::list(&db).unwrap()[0]
            .session
            .observer_mode,
        ObserverMode::Guard
    );
    assert!(crate::session_trash::restore(&db, &session.id).unwrap());
    assert_eq!(
        session_summary(&db, &session.id)
            .unwrap()
            .unwrap()
            .observer_mode,
        ObserverMode::Guard
    );
    assert!(delete_session(&db, &session.id).unwrap());
    assert!(session_summary(&db, &session.id).unwrap().is_none());
}

#[test]
fn observer_forks_default_off_without_mutating_source_or_other_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    for observer_mode in [ObserverMode::Endless, ObserverMode::Guard] {
        let source = create_session_with_options(
            &db,
            SessionCreateOptions {
                title: Some("Source".into()),
                mode: Some("plan".into()),
                provider_id: Some("saved-provider".into()),
                model_id: Some("saved-model".into()),
                project_path: Some(project.to_string_lossy().into_owned()),
                thinking_level: Some("high".into()),
                permission_mode: Some("ask".into()),
                fast_mode: true,
                observer_mode,
            },
        )
        .unwrap();
        let delegation = json!(["saved-provider/worker"]);
        db.kv_set(
            crate::session_delegation::NAMESPACE,
            &source.id,
            &delegation,
        )
        .unwrap();
        let mut source_message = message();
        source_message.id = format!("observer-{}", source.id);
        append_message(&db, &source.id, &source_message, None).unwrap();
        for anchor in [None, Some(source_message.id.as_str())] {
            let ForkSessionResult::Created(fork) =
                fork_session_through(&db, &source.id, None, anchor).unwrap()
            else {
                panic!("expected independent fork");
            };
            assert_eq!(fork.summary.observer_mode, ObserverMode::Off);
            let child = session_summary(&db, &fork.summary.id).unwrap().unwrap();
            assert_eq!(child.observer_mode, ObserverMode::Off);
            assert_eq!(child.mode, source.mode);
            assert_eq!(child.permission_mode, source.permission_mode);
            assert_eq!(child.thinking_level, source.thinking_level);
            assert_eq!(child.fast_mode, source.fast_mode);
            assert_eq!(child.provider_id, source.provider_id);
            assert_eq!(child.model_id, source.model_id);
            assert_eq!(child.project_path, source.project_path);
            assert_eq!(
                child.delegation_model_keys,
                Some(vec!["saved-provider/worker".into()])
            );
            assert_ne!(fork.messages[0].id, source_message.id);
        }
        assert_eq!(
            session_summary(&db, &source.id)
                .unwrap()
                .unwrap()
                .observer_mode,
            observer_mode
        );
        assert_eq!(
            get_session(&db, &source.id).unwrap().unwrap().messages[0].id,
            source_message.id
        );
    }
}

fn refresh(message: &UiMessage, turn: &str, snapshot: Value) -> UiMessage {
    let mut diagnostics = snapshot;
    diagnostics["turnId"] = json!(turn);
    diagnostics["startedAt"] = json!(1000);
    diagnostics["refreshOnly"] = json!(true);
    serde_json::from_value(json!({
        "id": message.id, "role": "assistant", "content": "",
        "createdAt": message.created_at, "runDiagnostics": diagnostics,
    }))
    .unwrap()
}

#[test]
fn observer_late_diagnostics_stay_on_the_settled_candidate_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    let mut original = message();
    original.thinking = Some("original thinking".into());
    original.provider_id = Some("original-provider".into());
    original.run_diagnostics = None;
    let usage =
        json!({"inputTokens": 4, "outputTokens": 2, "totalTokens": 6, "operationId": "request-1"});
    original.usage = Some(serde_json::from_value(usage.clone()).unwrap());
    append_message(&db, &session.id, &original, Some(&turn)).unwrap();
    assert!(record_usage(&db, &session.id, &turn, &usage).unwrap());
    let mut stored = indexed_message_record(&db, &session.id, &original.id)
        .unwrap()
        .unwrap();
    stored.meta.as_mut().unwrap()["futureMetadata"] = json!({"keep": true});
    assert!(transcripts::update_message(db.data_dir(), &session.id, &stored).unwrap());

    let mut assessment = json!({ "messageId": original.id, "mode": "guard", "status": "checking", "startedAt": 2000 });
    let checking = refresh(&original, &turn, json!({"observer": assessment}));
    append_message(&db, &session.id, &checking, Some(&turn)).unwrap();
    assert_eq!(
        get_session(&db, &session.id).unwrap().unwrap().messages[0]
            .run_diagnostics
            .as_ref()
            .unwrap()["observer"]["status"],
        "checking"
    );

    assessment["status"] = json!("assessed");
    assessment["endedAt"] = json!(3000);
    assessment["continued"] = json!(true);
    assessment["reviewedToolCount"] = json!(1);
    assessment["toolOutputIncluded"] = json!(false);
    for (max, used) in [
        (None, json!(1)),
        (Some(3), json!(0)),
        (Some(3), json!(-1)),
        (Some(3), json!(1.5)),
        (Some(3), json!(4)),
        (Some(3), json!("1")),
        (Some(3), Value::Null),
        (Some(101), json!(1)),
    ] {
        let mut invalid = assessment.clone();
        invalid["endlessRecoveriesUsed"] = used;
        if let Some(max) = max {
            invalid["maxContinuations"] = json!(max);
        }
        let invalid = refresh(&original, &turn, json!({"observer": invalid}));
        append_message(&db, &session.id, &invalid, Some(&turn)).unwrap();
    }
    assessment["endlessRecoveriesUsed"] = json!(3);
    assessment["maxContinuations"] = json!(3);
    let assessed = refresh(&original, &turn, json!({"observer": assessment}));
    append_message(&db, &session.id, &assessed, Some(&turn)).unwrap();
    append_message(&db, &session.id, &checking, Some(&turn)).unwrap();

    let mut continuation = original.clone();
    continuation.id = "continued-answer".into();
    continuation.content = "I finished the work".into();
    append_message(&db, &session.id, &continuation, Some(&turn)).unwrap();
    let final_update = refresh(
        &continuation,
        &turn,
        json!({"endedAt": 5000, "requestCount": 2}),
    );
    append_message(&db, &session.id, &final_update, Some(&turn)).unwrap();
    end_turn(&db, &turn, "completed", None, None, false).unwrap();
    drop(db);

    let db = Database::open_in_dir(dir.path()).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), 2);
    let diagnostics = detail.messages[0].run_diagnostics.as_ref().unwrap();
    assert_eq!(diagnostics["observer"], assessment);
    assert!(diagnostics.get("endedAt").is_none());
    assert!(diagnostics.get("refreshOnly").is_none());
    assert_eq!(
        detail.messages[1].run_diagnostics.as_ref().unwrap()["endedAt"],
        5000
    );
    assert!(detail.messages[1]
        .run_diagnostics
        .as_ref()
        .unwrap()
        .get("observer")
        .is_none());

    let mut candidate = transcripts::read_transcript(db.data_dir(), &session.id)
        .unwrap()
        .into_iter()
        .rev()
        .find(|record| record.id == original.id)
        .unwrap();
    candidate
        .meta
        .as_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("runDiagnostics");
    assert_eq!(
        serde_json::to_value(candidate).unwrap(),
        serde_json::to_value(stored).unwrap()
    );
    let turn_usage: String = db
        .conn()
        .query_row(
            "SELECT usage_json FROM turns WHERE id = ?1",
            [&turn],
            |row| row.get(0),
        )
        .unwrap();
    let turn_usage: Value = serde_json::from_str(&turn_usage).unwrap();
    assert_eq!(turn_usage, usage);
}

#[test]
fn observer_diagnostic_refresh_cannot_insert_or_rewrite_unowned_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let other = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    let other_turn = begin_turn(&db, &other.id, None, None).unwrap();
    let mut main = message();
    main.run_diagnostics = None;
    let mut delegate = main.clone();
    delegate.id = "delegated".into();
    delegate.parent_tool_call_id = Some("task-call".into());
    let mut streaming = main.clone();
    streaming.id = "streaming".into();
    streaming.status = Some("streaming".into());
    let mut legacy = main.clone();
    legacy.id = "unbound-legacy".into();
    append_message(&db, &session.id, &legacy, None).unwrap();
    for row in [&main, &delegate, &streaming] {
        append_message(&db, &session.id, row, Some(&turn)).unwrap();
    }
    let snapshot = |id: &str| {
        json!({"observer": {
            "messageId": id, "mode": "endless", "status": "skipped", "startedAt": 2000,
            "endedAt": 2001, "continuationReason": "user_input_pending",
            "continuationCount": 0, "maxContinuations": 3,
            "blockingTool": {"toolCallId": "some-call", "toolName": "Write"},
        }})
    };
    let mut missing = main.clone();
    missing.id = "not-persisted".into();
    for row in [&delegate, &streaming, &legacy, &missing] {
        append_message(
            &db,
            &session.id,
            &refresh(row, &turn, snapshot(&row.id)),
            Some(&turn),
        )
        .unwrap();
    }
    let patch = refresh(&main, &turn, snapshot(&main.id));
    let mut forged = patch.clone();
    forged.content = "replace the answer".into();
    append_message(&db, &session.id, &forged, Some(&turn)).unwrap();
    forged.content.clear();
    forged.thinking = Some("replace thinking".into());
    forged.error = Some(json!({"code": "PROVIDER_ERROR"}));
    forged.tool_result = Some(json!({"forged": true}));
    forged.output_truncated = Some(true);
    append_message(&db, &session.id, &forged, Some(&turn)).unwrap();
    let mut wrong_created_at = patch.clone();
    wrong_created_at.created_at = "2026-01-02T00:00:00Z".into();
    append_message(&db, &session.id, &wrong_created_at, Some(&turn)).unwrap();
    let wrong_message = refresh(&main, &turn, snapshot(&delegate.id));
    append_message(&db, &session.id, &wrong_message, Some(&turn)).unwrap();
    for (key, value) in [
        ("decision", json!("retry")),
        ("continuationCount", json!(-1)),
        ("continuationCount", json!(1.5)),
        ("endlessRecoveriesUsed", json!(-1)),
        ("endlessRecoveriesUsed", json!(1.5)),
        ("endlessRecoveriesUsed", json!(4)),
        ("maxContinuations", json!(101)),
        ("maxContinuations", json!(0)),
        ("modelKey", json!("provider/model")),
        ("thinkingLevel", json!("off")),
        ("usage", json!({})),
        ("verdict", json!("complete")),
        ("confidence", json!("high")),
    ] {
        let mut invalid = snapshot(&main.id);
        invalid["observer"][key] = value;
        append_message(
            &db,
            &session.id,
            &refresh(&main, &turn, invalid),
            Some(&turn),
        )
        .unwrap();
    }
    let wrong_termination = refresh(
        &main,
        &turn,
        json!({"endedAt": 2500, "termination": {"messageId": delegate.id}}),
    );
    append_message(&db, &session.id, &wrong_termination, Some(&turn)).unwrap();
    append_message(&db, &session.id, &patch, None).unwrap();
    append_message(&db, &other.id, &patch, Some(&turn)).unwrap();
    let wrong_turn = refresh(&main, &other_turn, snapshot(&main.id));
    append_message(&db, &other.id, &wrong_turn, Some(&other_turn)).unwrap();

    end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let next_turn = begin_turn(&db, &session.id, None, None).unwrap();
    let stale_owner = refresh(&main, &next_turn, snapshot(&main.id));
    append_message(&db, &session.id, &stale_owner, Some(&next_turn)).unwrap();
    let original_rows = get_session(&db, &session.id).unwrap().unwrap().messages;
    assert_eq!(original_rows.len(), 4);
    assert!(original_rows
        .iter()
        .all(|row| row.run_diagnostics.is_none()));
    assert!(get_session(&db, &other.id)
        .unwrap()
        .unwrap()
        .messages
        .is_empty());
    assert_eq!(original_rows[1].content, main.content);
    assert_eq!(original_rows[3].status.as_deref(), Some("streaming"));

    // A delayed outbox replay may reach its rightful row after the real turn ended.
    append_message(&db, &session.id, &patch, Some(&turn)).unwrap();
    let final_update = refresh(&main, &turn, json!({"endedAt": 3000}));
    append_message(&db, &session.id, &final_update, Some(&turn)).unwrap();
    let diagnostics = get_session(&db, &session.id).unwrap().unwrap().messages[1]
        .run_diagnostics
        .clone()
        .unwrap();
    assert_eq!(diagnostics["observer"], snapshot(&main.id)["observer"]);
    assert_eq!(diagnostics["endedAt"], 3000);

    let mut failed = main.clone();
    failed.id = "observer-error".into();
    append_message(&db, &session.id, &failed, Some(&next_turn)).unwrap();
    let error = refresh(
        &failed,
        &next_turn,
        json!({"observer": {
            "messageId": failed.id, "mode": "guard", "status": "error", "errorCode": "TIMEOUT",
            "startedAt": 2000, "endedAt": 3000
        }}),
    );
    append_message(&db, &session.id, &error, Some(&next_turn)).unwrap();
    let response = indexed_message_record(&db, &session.id, &failed.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        response.meta.unwrap()["runDiagnostics"]["observer"]["status"],
        "error"
    );
}

#[test]
fn observer_endless_decisions_and_legacy_assessment_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session.id, None, None).unwrap();
    let mut assessments = Vec::new();
    for (index, mode, decision, reason) in [
        (0, "endless", Some("continue"), None),
        (1, "endless", Some("stop"), Some("decision_stop")),
        (2, "endless", None, Some("continuation_limit")),
        (3, "observe", None, Some("observe_only")),
    ] {
        let mut row = message();
        row.id = format!("candidate-{index}");
        row.run_diagnostics = None;
        append_message(&db, &session.id, &row, Some(&turn)).unwrap();
        let mut assessment =
            json!({"messageId":row.id, "mode":mode, "status":"assessed", "startedAt":2000});
        if mode == "endless" {
            assessment["continuationCount"] = json!(index);
            assessment["maxContinuations"] = json!(3);
        }
        if index == 2 {
            assessment["endlessRecoveriesUsed"] = json!(1);
        }
        if let Some(decision) = decision {
            assessment["decision"] = json!(decision);
        }
        if let Some(reason) = reason {
            assessment["continuationReason"] = json!(reason);
        }
        let patch = refresh(&row, &turn, json!({"observer": assessment}));
        append_message(&db, &session.id, &patch, Some(&turn)).unwrap();
        assessments.push(assessment);
    }
    end_turn(&db, &turn, "completed", None, None, false).unwrap();
    drop(db);

    let db = Database::open_in_dir(dir.path()).unwrap();
    let detail = get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(detail.messages.len(), assessments.len());
    for (row, expected) in detail.messages.iter().zip(assessments) {
        assert_eq!(row.run_diagnostics.as_ref().unwrap()["observer"], expected);
    }
}
