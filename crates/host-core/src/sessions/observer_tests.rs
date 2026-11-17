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
    for observer_mode in [ObserverMode::Observe, ObserverMode::Guard] {
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
