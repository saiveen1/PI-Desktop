use super::*;
use std::io::Write;

fn edit(db: &Database, session: &str, id: &str, before: &str, after: &str) -> Result<()> {
    edit_assistant_reply(
        db,
        &EditAssistantReply {
            session_id: session.into(),
            message_id: id.into(),
            expected_content: before.into(),
            content: after.into(),
        },
    )
}

fn checkpoint(db: &Database, session: &str, id: &str, anchor: &str, summary: &str) {
    let cp = serde_json::from_value(json!({"id":id, "throughMessageId":anchor, "summary":summary,
        "retainedTail":[{"text":summary}], "details":{"retainedReasoning":[{"thinking":"reason", "text":summary}]},
        "createdAt":"2026-10-26T00:00:00Z", "tokensBefore":100})).unwrap();
    append_compaction(db, session, &cp).unwrap();
}

#[test]
fn cold_read_replaces_only_answer_and_dependent_checkpoints_including_search() {
    let (dir, db, session) = fixture();
    let turn = begin_turn(&db, &session, None, None).unwrap();
    let mut tool = message("tool", "tool", "tool evidence");
    tool.tool_name = Some("Read".into());
    tool.tool_call_id = Some("call".into());
    tool.tool_result = Some(json!({"details":{"opaque":[1,2,3]}}));
    for row in [message("user", "user", "question"), tool] {
        append_message(&db, &session, &row, Some(&turn)).unwrap();
    }
    checkpoint(&db, &session, "keep", "tool", "earlier context");
    let old = "  oldneedle\n";
    let new = "  newneedle\n"; // Same length: stale provider signatures would otherwise still match.
    let mut reply = message("reply", "assistant", old);
    reply.status = Some("complete".into());
    reply.thinking = Some("reason".into());
    reply.provider_id = Some("provider".into());
    reply.model_id = Some("model".into());
    reply.hosted_search = Some(json!({"replay":[],"sources":[]}));
    reply.provider_replay = Some(json!({"version":1,"blocks":[
        {"type":"thinking","length":6,"signature":"reasoning_content"},
        {"type":"text","length":old.encode_utf16().count(),"signature":"old"}
    ]}));
    let (mut record, _) = ui_to_record(&reply);
    record.meta.as_mut().unwrap()["futureMetadata"] = json!({"must":"survive"});
    *record.blocks.as_array_mut().unwrap().last_mut().unwrap() =
        json!({"type":"text","text":"  old"});
    record
        .blocks
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"text","text":"needle\n"}));
    let created = session_created_at(&db, &session).unwrap();
    append_record(&db, &session, &created, &record, Some(old), Some(&turn)).unwrap();
    // Old outbox retries may duplicate a physical row. A bounded read of either
    // occurrence must agree with the canonical keep-last read after editing.
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let line = raw.lines().last().unwrap().strip_suffix('}').unwrap();
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        r#"{line},"futureProducerField":42}}"#
    )
    .unwrap();
    append_message(
        &db,
        &session,
        &message("sys", "system", "notice"),
        Some(&turn),
    )
    .unwrap();
    checkpoint(&db, &session, "stale", "sys", old);
    checkpoint(&db, &session, "dependent", "reply", old);
    end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let opaque = r#"{"type":"future_event","payload":"opaque content"}"#;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        "{opaque}"
    )
    .unwrap();
    let before = get_session(&db, &session).unwrap().unwrap();
    let index = |db: &Database| {
        db.conn()
            .query_row(
                "SELECT mid, seq, turn_id FROM messages WHERE id='reply'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap()
    };
    let attribution = index(&db);
    assert_eq!(
        crate::session_search::search(&db, "oldneedle", 0, 10)
            .unwrap()
            .hits
            .len(),
        1
    );
    edit(&db, &session, "reply", old, new).unwrap();
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let after = get_session(&db, &session).unwrap().unwrap();
    assert_eq!(after.summary.message_count, before.summary.message_count);
    assert_eq!(after.messages.len(), 4);
    for i in [0, 1, 3] {
        assert_eq!(json!(before.messages[i]), json!(after.messages[i]));
    }
    let mut expected = json!(reply);
    expected.as_object_mut().unwrap().remove("providerReplay");
    expected["content"] = json!(new);
    assert_eq!(json!(after.messages[2]), expected);
    assert_eq!(after.compactions.len(), 1);
    assert_eq!(after.compaction.unwrap().id, "keep");
    assert_eq!(index(&db), attribution);
    assert!(crate::session_search::search(&db, "oldneedle", 0, 10)
        .unwrap()
        .hits
        .is_empty());
    assert_eq!(
        crate::session_search::search(&db, "newneedle", 0, 10)
            .unwrap()
            .hits
            .len(),
        1
    );
    let raw = std::fs::read_to_string(path).unwrap();
    assert!(raw.contains(opaque));
    assert!(raw.contains(r#""futureProducerField":42"#));
    assert!(!raw.contains("oldneedle"));
    let rows: Vec<_> = transcripts::read_transcript(db.data_dir(), &session)
        .unwrap()
        .into_iter()
        .filter(|r| r.id == "reply")
        .collect();
    assert_eq!(rows.len(), 2);
    for r in rows {
        assert_eq!(r.meta.unwrap()["futureMetadata"], json!({"must":"survive"}));
        assert_eq!(r.blocks[2], json!({"type":"text","text":new}));
    }
}

#[test]
fn rejects_stale_busy_wrong_owner_source_and_nonterminal_without_rewriting() {
    let (_dir, db, session) = fixture();
    let other = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &session, None, None).unwrap();
    append_message(
        &db,
        &session,
        &message("a", "assistant", " original "),
        Some(&turn),
    )
    .unwrap();
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let before = std::fs::read(&path).unwrap();
    let check = |s: &str, expected: &str, new: &str, code: &str| {
        let error = edit(&db, s, "a", expected, new).unwrap_err();
        assert!(error.to_string().starts_with(code), "{error}");
    };
    check(&session, " original ", "new", "AGENT_BUSY");
    check(&other.id, " original ", "new", "NOT_FOUND");
    end_turn(&db, &turn, "completed", None, None, false).unwrap();
    check(&session, " original ", " \n", "INVALID_PARAMS");
    check(&session, "original", "new", "CONFLICT");
    db.conn()
        .execute(
            "UPDATE sessions SET source='system' WHERE id=?1",
            [&session],
        )
        .unwrap();
    check(&session, " original ", "new", "PERMISSION_DENIED");
    db.conn()
        .execute(
            "UPDATE sessions SET source='desktop' WHERE id=?1",
            [&session],
        )
        .unwrap();
    db.conn().execute("INSERT INTO session_import_origins(plugin_id,source_id,external_id,session_id,created_at) VALUES ('plugin','desktop','ext',?1,0)", [&session]).unwrap();
    check(&session, " original ", "new", "PERMISSION_DENIED");
    db.conn()
        .execute(
            "DELETE FROM session_import_origins WHERE session_id=?1",
            [&session],
        )
        .unwrap();
    db.conn().execute("INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at) VALUES ('q',?1,'user','h','q','ask',0,0)", [&session]).unwrap();
    check(&session, " original ", "new", "AGENT_BUSY");
    db.conn()
        .execute("DELETE FROM turn_queue WHERE session_id=?1", [&session])
        .unwrap();
    save_inflight_message(
        &db,
        &session,
        Some(&turn),
        &message("other", "assistant", "in flight"),
    )
    .unwrap();
    check(&session, " original ", "new", "AGENT_BUSY");
    assert!(transcripts::read_inflight(db.data_dir(), &session)
        .unwrap()
        .is_some());
    transcripts::remove_inflight(db.data_dir(), &session).unwrap();
    db.conn()
        .execute("UPDATE turns SET status='aborted' WHERE id=?1", [&turn])
        .unwrap();
    check(&session, " original ", "new", "CONFLICT");
    db.conn()
        .execute("UPDATE sessions SET deleted_at=1 WHERE id=?1", [&session])
        .unwrap();
    check(&session, " original ", "new", "NOT_FOUND");
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn only_top_level_complete_answer_rows_with_answer_text_are_editable() {
    for (role, text, extra) in [
        ("user", "prompt", json!({})),
        ("system", "notice", json!({})),
        ("tool", "result", json!({})),
        ("assistant", "", json!({"thinking":"only thinking"})),
        ("assistant", " \n", json!({})),
        ("assistant", "partial", json!({"status":"aborted"})),
        ("assistant", "partial", json!({"status":"streaming"})),
        ("assistant", "partial", json!({"status":"error"})),
        ("assistant", "partial", json!({"isError":true})),
        ("assistant", "partial", json!({"error":{"code":"failure"}})),
        ("assistant", "delegated", json!({"parentToolCallId":"task"})),
        (
            "assistant",
            "delegated",
            json!({"nestedParentToolCallId":"task"}),
        ),
        ("assistant", "delegated", json!({"agentName":"fixer"})),
        (
            "assistant",
            "mixed",
            json!({"attachments":[{"kind":"file","name":"file","ref":"existing"}]}),
        ),
    ] {
        let (_dir, db, session) = fixture();
        let mut raw = json!(message("a", role, text));
        raw.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        append_message(
            &db,
            &session,
            &serde_json::from_value(raw.clone()).unwrap(),
            None,
        )
        .unwrap();
        assert!(edit(&db, &session, "a", text, "new").is_err(), "{raw}");
        assert_eq!(
            get_session(&db, &session).unwrap().unwrap().messages[0].content,
            text
        );
    }
}

#[test]
fn later_chat_or_tool_blocks_edit_but_manual_fork_can_edit_its_own_last_reply() {
    for role in ["user", "assistant", "tool"] {
        let (_dir, db, session) = fixture();
        append_message(&db, &session, &message("a", "assistant", "old"), None).unwrap();
        append_message(&db, &session, &message("later", role, "later"), None).unwrap();
        assert!(edit(&db, &session, "a", "old", "new").is_err());
        let ForkSessionResult::Created(fork) =
            fork_session_through(&db, &session, None, Some("a")).unwrap()
        else {
            panic!("expected a fork")
        };
        edit(&db, &fork.summary.id, &fork.messages[0].id, "old", "new").unwrap();
        assert_eq!(
            get_session(&db, &fork.summary.id)
                .unwrap()
                .unwrap()
                .messages[0]
                .content,
            "new"
        );
        assert_eq!(
            get_session(&db, &session).unwrap().unwrap().messages[0].content,
            "old"
        );
    }
}

#[test]
fn failed_splice_rolls_back_fts_and_a_noop_can_repair_a_lagging_index() {
    let (_dir, db, session) = fixture();
    append_message(&db, &session, &message("a", "assistant", "original"), None).unwrap();
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let before = std::fs::read(&path).unwrap();
    std::fs::create_dir(path.with_extension("jsonl.tmp")).unwrap();
    assert!(edit(&db, &session, "a", "original", "replacement").is_err());
    let count = |text| {
        crate::session_search::search(&db, text, 0, 10)
            .unwrap()
            .hits
            .len()
    };
    assert_eq!((count("original"), count("replacement")), (1, 0));
    db.conn()
        .execute("UPDATE messages SET text='lagging' WHERE id='a'", [])
        .unwrap();
    assert_eq!(count("lagging"), 1);
    edit(&db, &session, "a", "original", "original").unwrap();
    assert_eq!((count("original"), count("lagging")), (1, 0));
    assert_eq!(std::fs::read(path).unwrap(), before);
}
