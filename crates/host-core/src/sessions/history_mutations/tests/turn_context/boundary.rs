use super::*;

fn toggle(db: &Database, snap: &Value, enabled: bool) -> Result<Value> {
    edit_turn_context(
        db,
        &serde_json::from_value(json!({
            "sessionId":snap["sessionId"], "anchorMessageId":snap["anchorMessageId"],
            "expectedRevision":snap["revision"], "edits":[], "excludePreviousTurns":enabled
        }))?,
    )
}

fn stamped(db: &Database, session: &str, through: &str, prompt: &str) -> Result<()> {
    append_compaction(
        db,
        session,
        &serde_json::from_value(
            json!({"id":"checkpoint", "summary":"post-cut summary", "tokensBefore":10, "throughMessageId":through, "createdAt":"now", "details":{"contextBoundaryMessageId":prompt}}),
        )?,
    )
}

fn before(messages: &[UiMessage]) -> Vec<&str> {
    messages
        .iter()
        .filter(|m| m.excluded_by_context_boundary)
        .map(|m| m.id.as_str())
        .collect()
}

#[test]
fn historical_markers_are_independent_and_reset_invalidates_all_checkpoints() {
    let (_dir, db, session) = fixture();
    append_message(&db, &session, &message("prefix", "system", "first"), None).unwrap();
    populate(&db, &session);
    let original = canon(&db, &session);
    let old = read(&db, &session, "old").unwrap();
    assert_eq!(old["excludePreviousTurns"], false);
    let result = toggle(&db, &old, true).unwrap();
    assert_eq!(
        result["updates"],
        json!([{"messageId":"old-user","contextOverride":{"version":1,"excludePreviousTurns":true}}])
    );
    stamped(&db, &session, "old", "old-user").unwrap();
    let tail = read(&db, &session, "final").unwrap();
    assert_eq!(tail["excludePreviousTurns"], false);
    let marked = toggle(&db, &tail, true).unwrap();
    assert_eq!(marked["updates"][0]["messageId"], "user");
    assert!(toggle(&db, &tail, false)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    let current = get_session(&db, &session).unwrap().unwrap();
    assert!(current.compactions.is_empty());
    assert_eq!(before(&current.messages), ["prefix", "old-user", "old"]);
    let page = get_session_with_options(
        &db,
        &session,
        SessionReadOptions {
            message_limit: Some(1),
            message_around: Some("old".into()),
            content_limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(before(&page.messages), ["old"]);
    let end = get_session_with_options(
        &db,
        &session,
        SessionReadOptions {
            message_limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert!(before(&end.messages).is_empty());
    assert!(json!(end.messages[0])
        .get("excludedByContextBoundary")
        .is_none());
    let rejected: CompactionRecord = serde_json::from_value(json!({"id":"stale","summary":"stale","tokensBefore":10,"throughMessageId":"old","createdAt":"now"})).unwrap();
    assert!(append_compaction(&db, &session, &rejected)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    assert!(stamped(&db, &session, "old", "user").is_err());
    assert!(stamped(&db, &session, "final", "old-user").is_err());
    stamped(&db, &session, "final", "user").unwrap();
    let fresh = read(&db, &session, "final").unwrap();
    let restored = save(&db, &fresh, json!([]), true).unwrap();
    assert_eq!(restored["snapshot"]["excludePreviousTurns"], true);
    stamped(&db, &session, "final", "user").unwrap();
    let cleared = toggle(&db, &read(&db, &session, "final").unwrap(), false).unwrap();
    assert_eq!(
        cleared["updates"],
        json!([{"messageId":"user","contextOverride":null}])
    );
    let current = get_session(&db, &session).unwrap().unwrap();
    assert!(current.compactions.is_empty());
    assert_eq!(before(&current.messages), ["prefix"]);
    assert_eq!(canon(&db, &session), original);
    let file =
        std::fs::read_to_string(transcripts::transcript_path(db.data_dir(), &session).unwrap())
            .unwrap();
    assert!(!file.contains("excludedByContextBoundary"));
}

#[test]
fn forks_before_and_after_the_cut_and_revision_switch_recompute_the_prefix() {
    let (_dir, db, session) = fixture();
    populate(&db, &session);
    let marked = toggle(&db, &read(&db, &session, "final").unwrap(), true).unwrap();
    stamped(&db, &session, "final", "user").unwrap();
    for (anchor, includes_marker) in [("old", false), ("final", true)] {
        let ForkSessionResult::Created(fork) =
            fork_session_through(&db, &session, None, Some(anchor)).unwrap()
        else {
            panic!("expected fork")
        };
        assert_eq!(
            before(&fork.messages).len(),
            if includes_marker { 2 } else { 0 }
        );
        let child = read(&db, &fork.summary.id, &fork.messages.last().unwrap().id).unwrap();
        assert_eq!(child["excludePreviousTurns"], includes_marker);
        assert_eq!(fork.compaction.is_some(), includes_marker);
        if let Some(c) = &fork.compaction {
            assert_eq!(
                c.details.as_ref().unwrap()["contextBoundaryMessageId"],
                fork.messages[2].id
            );
        }
        if includes_marker {
            toggle(&db, &child, false).unwrap();
        }
    }
    let detail = get_session(&db, &session).unwrap().unwrap();
    save_message_revision(&db, &session, "user", &detail.messages[2..], true).unwrap();
    assert_eq!(marked["snapshot"]["excludePreviousTurns"], true);
    toggle(&db, &read(&db, &session, "final").unwrap(), false).unwrap();
    let detail = get_session(&db, &session).unwrap().unwrap();
    save_message_revision(&db, &session, "user", &detail.messages[2..], true).unwrap();
    for (revision, expected) in [(1, 2), (2, 0)] {
        if revision == 1 {
            checkpoint(&db, &session, "branch-summary", "final");
        } else {
            stamped(&db, &session, "final", "user").unwrap();
        }
        let restored =
            activate_message_revision_canonical(&db, &session, "user", revision).unwrap();
        assert_eq!(before(&restored).len(), expected);
        let current = get_session(&db, &session).unwrap().unwrap();
        assert_eq!(before(&current.messages).len(), expected);
        assert!(current.compactions.is_empty());
    }
}
