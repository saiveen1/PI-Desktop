use super::*;

fn choose(
    db: &Database,
    session: &str,
    id: &str,
    before: &str,
    after: &str,
    mode: &str,
) -> Result<Value> {
    let edit = serde_json::from_value(json!({"sessionId":session, "messageId":id,
        "expectedContent":before, "content":after, "thinkingContext":mode}))?;
    Ok(serde_json::to_value(edit_assistant_reply(db, &edit)?)?)
}

fn thinking(id: &str, text: &str) -> UiMessage {
    let mut row = message(id, "assistant", text);
    row.thinking = Some(format!("reason {id}"));
    row.provider_replay = Some(json!({"version":1,"blocks":[{"type":"thinking","signature":id}]}));
    row
}

fn populate(db: &Database, session: &str, final_thinking: bool) {
    let old = begin_turn(db, session, None, None).unwrap();
    for row in [
        message("old-user", "user", "old question"),
        thinking("old", "old answer"),
    ] {
        append_message(db, session, &row, Some(&old)).unwrap();
    }
    end_turn(db, &old, "completed", None, None, false).unwrap();
    checkpoint(db, session, "old-summary", "old", "old summary");
    let turn = begin_turn(db, session, None, None).unwrap();
    let mut steer = message("steer", "user", "steering");
    steer.steering = Some(true);
    let mut nested_user = message("nested-user", "user", "delegate prompt");
    nested_user.parent_tool_call_id = Some("task".into());
    let mut delegated = thinking("delegate", "delegate answer");
    delegated.parent_tool_call_id = Some("task".into());
    let mut nested = thinking("nested", "nested answer");
    nested.nested_parent_tool_call_id = Some("task".into());
    let mut named = thinking("named", "named answer");
    named.agent_name = Some("fixer".into());
    let mut tool = message("tool1", "tool", "evidence");
    tool.tool_name = Some("Read".into());
    tool.tool_call_id = Some("call1".into());
    tool.thinking = Some("tool annotation".into());
    for row in [
        message("user", "user", "question"),
        thinking("a1", "first call"),
        tool,
    ] {
        append_message(db, session, &row, Some(&turn)).unwrap();
    }
    checkpoint(db, session, "cover-a1", "a1", "summary of first reasoning");
    for row in [
        steer,
        thinking("a2", ""),
        message("tool2", "tool", "more evidence"),
        nested_user,
        delegated,
        nested,
        named,
    ] {
        append_message(db, session, &row, Some(&turn)).unwrap();
    }
    let final_row = if final_thinking {
        thinking("a3", "answer")
    } else {
        message("a3", "assistant", "answer")
    };
    append_message(db, session, &final_row, Some(&turn)).unwrap();
    // Even a later checkpoint pointing backwards depends on the invalidated chain.
    checkpoint(db, session, "dependent", "old", "dependent summary");
    end_turn(db, &turn, "completed", None, None, false).unwrap();
}

fn updates(ids: &[&str], excluded: bool) -> Value {
    json!({"ok":true, "thinkingContextUpdates":ids.iter().map(|id|
        json!({"messageId":id,"excludeThinkingFromContext":excluded})).collect::<Vec<_>>()})
}

#[test]
fn three_calls_tools_steering_earlier_turn_and_reversible_keep_survive_restart() {
    let (dir, db, session) = fixture();
    populate(&db, &session, true);
    let before = get_session(&db, &session).unwrap().unwrap();
    // Unknown fields on earlier rows must survive the metadata-only batch splice.
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let raw = raw
        .lines()
        .map(|line| {
            if line.contains("\"id\":\"a1\"") {
                let mut value: Value = serde_json::from_str(line).unwrap();
                value["futureProducerField"] = json!(42);
                value["meta"]["futureMetadata"] = json!({"opaque":true});
                value.to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&path, raw).unwrap();
    assert_eq!(
        choose(&db, &session, "a3", "answer", "answer", "reply").unwrap(),
        updates(&["a3"], true)
    );
    assert_eq!(
        get_session(&db, &session)
            .unwrap()
            .unwrap()
            .compactions
            .len(),
        3
    );
    assert_eq!(
        choose(&db, &session, "a3", "answer", "edited", "turn").unwrap(),
        updates(&["a1", "a2"], true)
    );
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let after = get_session(&db, &session).unwrap().unwrap();
    assert_eq!(after.compactions.len(), 1);
    assert_eq!(after.compactions[0].id, "old-summary");
    assert_eq!(after.summary.message_count, before.summary.message_count);
    for (original, current) in before.messages.iter().zip(&after.messages) {
        if ["a1", "a2", "a3"].contains(&current.id.as_str()) {
            assert_eq!(current.exclude_thinking_from_context, Some(true));
            assert_eq!(current.thinking, original.thinking);
            if current.id != "a3" {
                assert_eq!(current.provider_replay, original.provider_replay);
            } else {
                assert!(current.provider_replay.is_none());
            }
        } else {
            assert_eq!(json!(current), json!(original));
        }
    }
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("\"futureProducerField\":42"));
    assert!(raw.contains("\"futureMetadata\":{\"opaque\":true}"));
    checkpoint(&db, &session, "excluded-summary", "a1", "without thinking");
    assert_eq!(
        choose(&db, &session, "a3", "edited", "edited", "keep").unwrap(),
        updates(&["a1", "a2", "a3"], false)
    );
    let restored = get_session(&db, &session).unwrap().unwrap();
    assert_eq!(restored.compactions.len(), 1);
    for row in restored
        .messages
        .iter()
        .filter(|r| ["a1", "a2", "a3"].contains(&r.id.as_str()))
    {
        assert_eq!(row.exclude_thinking_from_context, Some(false));
        assert!(row.thinking.is_some());
        if row.id != "a3" {
            assert!(row.provider_replay.is_some());
        }
        let (record, _) = ui_to_record(row);
        assert_eq!(
            record_to_ui(record).exclude_thinking_from_context,
            Some(false)
        );
    }
    let before_noop = std::fs::read(&path).unwrap();
    assert_eq!(
        choose(&db, &session, "a3", "edited", "edited", "keep").unwrap(),
        updates(&[], false)
    );
    assert_eq!(std::fs::read(&path).unwrap(), before_noop);
}

#[test]
fn no_thinking_final_reply_does_not_reach_back_but_turn_and_fork_keep_do() {
    let (_dir, db, session) = fixture();
    populate(&db, &session, false);
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let raw = std::fs::read(&path).unwrap();
    assert_eq!(
        choose(&db, &session, "a3", "answer", "answer", "reply").unwrap(),
        updates(&[], true)
    );
    assert_eq!(std::fs::read(&path).unwrap(), raw);
    assert_eq!(
        choose(&db, &session, "a3", "answer", "answer", "turn").unwrap(),
        updates(&["a1", "a2"], true)
    );
    let ForkSessionResult::Created(fork) =
        fork_session_through(&db, &session, None, Some("a3")).unwrap()
    else {
        panic!("expected fork")
    };
    let final_id = &fork.messages.last().unwrap().id;
    assert!(message_turn(&db, &fork.summary.id, final_id)
        .unwrap()
        .is_none());
    let excluded: Vec<_> = fork
        .messages
        .iter()
        .filter(|r| r.exclude_thinking_from_context == Some(true))
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(excluded.len(), 2);
    assert_eq!(
        choose(&db, &fork.summary.id, final_id, "answer", "answer", "keep").unwrap(),
        updates(&excluded, false)
    );
    assert_eq!(
        choose(&db, &fork.summary.id, final_id, "answer", "answer", "turn").unwrap(),
        updates(&excluded, true)
    );
    let branch = get_session(&db, &fork.summary.id).unwrap().unwrap();
    assert_eq!(
        branch
            .messages
            .iter()
            .filter(|r| r.exclude_thinking_from_context == Some(true))
            .count(),
        2
    );
    assert!(branch
        .messages
        .iter()
        .find(|r| r.content == "old answer")
        .unwrap()
        .exclude_thinking_from_context
        .is_none());
    assert!(branch
        .messages
        .last()
        .unwrap()
        .exclude_thinking_from_context
        .is_none());
    assert_eq!(
        get_session(&db, &session)
            .unwrap()
            .unwrap()
            .messages
            .iter()
            .filter(|r| r.exclude_thinking_from_context == Some(true))
            .count(),
        2
    );
}

#[test]
fn durable_turn_ownership_wins_over_unmarked_prompt_shaped_rows() {
    let (_dir, db, session) = fixture();
    populate(&db, &session, true);
    let mut steer = get_session(&db, &session)
        .unwrap()
        .unwrap()
        .messages
        .into_iter()
        .find(|r| r.id == "steer")
        .unwrap();
    steer.steering = None;
    let (record, _) = ui_to_record(&steer);
    transcripts::update_message(db.data_dir(), &session, &record).unwrap();
    assert_eq!(
        choose(&db, &session, "a3", "answer", "answer", "turn").unwrap(),
        updates(&["a1", "a2", "a3"], true)
    );
}

#[test]
fn failed_batch_splice_rolls_back_text_flags_summaries_and_index() {
    let (_dir, db, session) = fixture();
    populate(&db, &session, true);
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let raw = std::fs::read(&path).unwrap();
    let before = json!(get_session(&db, &session).unwrap().unwrap());
    std::fs::create_dir(path.with_extension("jsonl.tmp")).unwrap();
    assert!(choose(&db, &session, "a3", "answer", "replacementneedle", "turn").is_err());
    assert_eq!(std::fs::read(&path).unwrap(), raw);
    assert_eq!(json!(get_session(&db, &session).unwrap().unwrap()), before);
    assert!(
        crate::session_search::search(&db, "replacementneedle", 0, 10)
            .unwrap()
            .hits
            .is_empty()
    );
}

#[test]
fn archived_revisions_restore_both_included_and_excluded_thinking() {
    let (dir, db, session) = fixture();
    append_message(&db, &session, &message("user", "user", "question"), None).unwrap();
    append_message(&db, &session, &thinking("a3", "answer"), None).unwrap();
    choose(&db, &session, "a3", "answer", "answer", "turn").unwrap();
    let excluded = get_session(&db, &session).unwrap().unwrap().messages;
    save_message_revision(&db, &session, "user", &excluded, true).unwrap();
    choose(&db, &session, "a3", "answer", "answer", "keep").unwrap();
    let included = get_session(&db, &session).unwrap().unwrap().messages;
    save_message_revision(&db, &session, "user", &included, true).unwrap();
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    for (revision, excluded) in [(1, true), (2, false)] {
        let restored = activate_message_revision(&db, &session, "user", revision, &[]).unwrap();
        assert_eq!(restored[1].exclude_thinking_from_context, Some(excluded));
        assert_eq!(restored[1].thinking.as_deref(), Some("reason a3"));
        assert!(restored[1].provider_replay.is_some());
        assert_eq!(
            get_session(&db, &session).unwrap().unwrap().messages[1].exclude_thinking_from_context,
            Some(excluded)
        );
    }
}

#[test]
fn turn_then_reply_restores_earlier_rows_and_invalidates_dependent_summaries() {
    for forked in [false, true] {
        let (_dir, db, source) = fixture();
        populate(&db, &source, true);
        let (session, ids) = if forked {
            let ForkSessionResult::Created(fork) =
                fork_session_through(&db, &source, None, Some("a3")).unwrap()
            else {
                panic!("expected fork")
            };
            let ids: Vec<_> = fork
                .messages
                .iter()
                .filter(|r| {
                    ["first call", "", "answer"].contains(&r.content.as_str())
                        && r.role == "assistant"
                        && r.agent_name.is_none()
                        && r.parent_tool_call_id.is_none()
                        && r.nested_parent_tool_call_id.is_none()
                })
                .map(|r| r.id.clone())
                .collect();
            (fork.summary.id, ids)
        } else {
            (source.clone(), vec!["a1".into(), "a2".into(), "a3".into()])
        };
        assert_eq!(ids.len(), 3);
        let refs: Vec<_> = ids.iter().map(String::as_str).collect();
        let before = get_session(&db, &session).unwrap().unwrap();
        assert_eq!(
            choose(&db, &session, &ids[2], "answer", "answer", "turn").unwrap(),
            updates(&refs, true)
        );
        checkpoint(&db, &session, "covered", &ids[0], "excluded summary");
        let old_id = before
            .messages
            .iter()
            .find(|m| m.content == "old answer")
            .unwrap()
            .id
            .clone();
        checkpoint(
            &db,
            &session,
            "dependent-again",
            &old_id,
            "dependent summary",
        );
        assert_eq!(
            choose(&db, &session, &ids[2], "answer", "answer", "reply").unwrap(),
            updates(&refs[..2], false)
        );
        let after = get_session(&db, &session).unwrap().unwrap();
        assert!(!after
            .compactions
            .iter()
            .any(|c| c.id == "covered" || c.id == "dependent-again"));
        for (original, row) in before.messages.iter().zip(&after.messages) {
            if let Some(i) = ids.iter().position(|id| *id == row.id) {
                assert_eq!(row.exclude_thinking_from_context, Some(i == 2));
                assert_eq!(row.thinking, original.thinking);
                assert_eq!(row.provider_replay, original.provider_replay);
            } else {
                assert_eq!(json!(row), json!(original));
            }
        }
    }
}

#[test]
fn opaque_replay_thinking_is_excluded_without_discarding_replay_or_blocks() {
    for mode in ["reply", "turn"] {
        let (_dir, db, session) = fixture();
        append_message(&db, &session, &message("user", "user", "question"), None).unwrap();
        let mut row = message("a3", "assistant", "answer");
        row.provider_replay = Some(
            json!({"version":1,"blocks":[{"type":"thinking","length":0,"signature":"encrypted","redacted":true},{"type":"text","length":6}]}),
        );
        append_message(&db, &session, &row, None).unwrap();
        let original = transcripts::read_transcript(db.data_dir(), &session)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(
            choose(&db, &session, "a3", "answer", "answer", mode).unwrap(),
            updates(&["a3"], true)
        );
        let excluded = transcripts::read_transcript(db.data_dir(), &session)
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(excluded.blocks, original.blocks);
        assert_eq!(
            excluded.meta.as_ref().unwrap()["providerReplay"],
            original.meta.as_ref().unwrap()["providerReplay"]
        );
        assert_eq!(
            choose(&db, &session, "a3", "answer", "answer", "keep").unwrap(),
            updates(&["a3"], false)
        );
        assert_eq!(
            choose(&db, &session, "a3", "answer", "edited", mode).unwrap(),
            updates(&["a3"], true)
        );
        let edited = transcripts::read_transcript(db.data_dir(), &session)
            .unwrap()
            .pop()
            .unwrap();
        assert!(edited
            .meta
            .as_ref()
            .unwrap()
            .get("providerReplay")
            .is_none());
    }
}
