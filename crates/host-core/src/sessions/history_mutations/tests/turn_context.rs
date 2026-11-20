use super::*;

fn read(db: &Database, session: &str, anchor: &str) -> Result<Value> {
    let request = serde_json::from_value(json!({"sessionId":session,"anchorMessageId":anchor}))?;
    Ok(get_turn_context(db, &request)?["snapshot"].clone())
}

fn save(db: &Database, snapshot: &Value, edits: Value, restore: bool) -> Result<Value> {
    let request = serde_json::from_value(json!({
        "sessionId":snapshot["sessionId"],"anchorMessageId":snapshot["anchorMessageId"],
        "expectedRevision":snapshot["revision"],"edits":edits,"restore":restore,
    }))?;
    edit_turn_context(db, &request)
}

fn edit(id: &str, overlay: Value) -> Value {
    json!({"messageId":id,"contextOverride":overlay})
}

fn checkpoint(db: &Database, session: &str, id: &str, anchor: &str) {
    let record = serde_json::from_value(json!({
        "id":id,"throughMessageId":anchor,"summary":"summary","tokensBefore":100,
        "details":{"retainedReasoning":[{"thinking":"signed reasoning"}]},
        "createdAt":"2026-10-26T00:00:00Z",
    }))
    .unwrap();
    append_compaction(db, session, &record).unwrap();
}

fn completed_tool(id: &str, args: Value, result: Value) -> UiMessage {
    let mut tool = message(id, "tool", "");
    tool.tool_name = Some("Read".into());
    tool.tool_call_id = Some(format!("call-{id}"));
    tool.tool_status = Some("completed".into());
    tool.tool_args = Some(args);
    tool.tool_result = Some(result);
    tool.tool_duration_ms = Some(102);
    tool.tool_completed_at = Some(tool.created_at.clone());
    tool
}

fn populate(db: &Database, session: &str) -> String {
    let old = begin_turn(db, session, None, None).unwrap();
    for row in [
        message("old-user", "user", "old prompt"),
        message("old", "assistant", "old answer"),
    ] {
        append_message(db, session, &row, Some(&old)).unwrap();
    }
    end_turn(db, &old, "completed", None, None, false).unwrap();
    checkpoint(db, session, "prior", "old");
    let turn = begin_turn(db, session, None, None).unwrap();
    let mut first = message("first", "assistant", "I will check");
    first.thinking = Some("full\nvisible thinking".into());
    first.exclude_thinking_from_context = Some(true);
    let mut opaque = message("opaque", "assistant", "");
    opaque.provider_replay =
        Some(json!({"version":1,"blocks":[{"type":"thinking","length":0,"signature":"opaque"}]}));
    let mut steer = message("steer", "user", "steering prompt");
    steer.steering = Some(true);
    let mut child_prompt = message("child-user", "user", "delegate prompt");
    child_prompt.parent_tool_call_id = Some("call-t1".into());
    let mut child = message("child", "assistant", "delegated answer");
    child.nested_parent_tool_call_id = Some("call-t1".into());
    let mut child_tool = completed_tool("child-tool", json!({}), json!("delegated result"));
    child_tool.agent_name = Some("fixer".into());
    for row in [
        message("user", "user", "real prompt"),
        first,
        completed_tool(
            "t1",
            json!({"path":"old"}),
            json!({"data":[1,2],"details":{"receipt":true}}),
        ),
        steer,
        opaque,
        child_prompt,
        child,
        child_tool,
        completed_tool("t2", json!({"limit":5}), json!("literal\nlast line")),
        message("final", "assistant", "originalneedle answer"),
        message("sys", "system", "notice"),
    ] {
        append_message(db, session, &row, Some(&turn)).unwrap();
    }
    checkpoint(db, session, "cover", "t1");
    checkpoint(db, session, "dependent", "old");
    end_turn(db, &turn, "completed", None, None, false).unwrap();
    turn
}

fn canon(db: &Database, session: &str) -> Vec<Value> {
    dedupe_records(transcripts::read_transcript(db.data_dir(), session).unwrap())
        .into_iter()
        .map(|mut row| {
            if let Some(meta) = row.meta.as_mut().and_then(Value::as_object_mut) {
                meta.remove("contextOverride");
                meta.remove("excludeThinkingFromContext");
                if meta.is_empty() {
                    row.meta = None;
                }
            }
            json!(row)
        })
        .collect()
}

#[test]
fn project_save_exclude_and_restore_without_changing_execution_history() {
    let (dir, db, session) = fixture();
    populate(&db, &session);
    let original = canon(&db, &session);
    let snap = read(&db, &session, "final").unwrap();
    let rows = snap["messages"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["messageId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["first", "t1", "opaque", "t2", "final"]
    );
    assert_eq!(rows[0]["thinking"], "full\nvisible thinking");
    assert_eq!(rows[0]["legacyExcludeThinking"], true);
    assert_eq!(rows[1]["toolName"], "Read");
    assert_eq!(rows[1]["toolArgs"], json!({"path":"old"}));
    assert_eq!(
        serde_json::from_str::<Value>(rows[1]["toolResultText"].as_str().unwrap()).unwrap(),
        json!({"data":[1,2],"details":{"receipt":true}})
    );
    assert_eq!(rows[2]["content"], "");
    assert_eq!(rows[2]["hasThinking"], true);
    assert!(!rows[2].as_object().unwrap().contains_key("thinking"));
    assert_eq!(rows[3]["toolResultText"], "literal\nlast line");
    assert_eq!(rows[4]["final"], true);

    db.conn()
        .execute(
            "UPDATE sessions SET updated_at = 0 WHERE id = ?1",
            [&session],
        )
        .unwrap();
    let edits = json!([
        edit(
            "first",
            json!({"version":1,"excludeThinking":false,"excludeContent":true})
        ),
        edit(
            "t1",
            json!({"version":1,"toolArgs":{"path":"context-only"},"toolResultText":"new context"})
        ),
        edit("opaque", json!({"version":1,"excludeThinking":true})),
        edit("t2", json!({"version":1,"excludeTool":true})),
        edit(
            "final",
            json!({"version":1,"content":"contextneedle answer"})
        ),
    ]);
    let result = save(&db, &snap, edits, false).unwrap();
    let updated = &result["snapshot"];
    assert_ne!(updated["revision"], snap["revision"]);
    assert_eq!(result["updates"].as_array().unwrap().len(), 5);
    assert_eq!(result["updates"][0]["excludeThinkingFromContext"], true);
    assert_eq!(
        result["updates"][0]["contextOverride"]["excludeThinking"],
        false
    );
    assert_eq!(canon(&db, &session), original);
    let db_text: String = db
        .conn()
        .query_row(
            "SELECT text FROM messages WHERE session_id=?1 AND id='final'",
            [&session],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(db_text, "originalneedle answer");
    let timestamp: i64 = db
        .conn()
        .query_row(
            "SELECT updated_at FROM sessions WHERE id=?1",
            [&session],
            |row| row.get(0),
        )
        .unwrap();
    assert!(timestamp > 0);
    let checkpoints = transcripts::read_compactions(db.data_dir(), &session).unwrap();
    assert_eq!(
        checkpoints
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ["prior"]
    );
    assert!(save(&db, &snap, json!([]), true)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    let legacy = serde_json::from_value(json!({"sessionId":session,"messageId":"final","expectedContent":"originalneedle answer","content":"new"})).unwrap();
    assert!(edit_assistant_reply(&db, &legacy)
        .unwrap_err()
        .to_string()
        .contains("turn context editor"));

    let cleared_first = save(&db, updated, json!([edit("first", Value::Null)]), false).unwrap();
    assert_eq!(
        cleared_first["updates"],
        json!([{"messageId":"first","contextOverride":null,"excludeThinkingFromContext":false}])
    );
    assert!(cleared_first["snapshot"]["messages"][0]
        .get("legacyExcludeThinking")
        .is_none());
    assert!(cleared_first["snapshot"]["messages"][1]
        .get("override")
        .is_some());
    drop(db);
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    assert_eq!(
        read(&db, &session, "final").unwrap(),
        cleared_first["snapshot"]
    );
    let ui = get_session(&db, &session).unwrap().unwrap().messages;
    let receipt = ui.iter().find(|m| m.id == "t1").unwrap();
    assert_eq!(receipt.tool_call_id.as_deref(), Some("call-t1"));
    assert_eq!(receipt.tool_args, Some(json!({"path":"old"})));
    assert_eq!(
        receipt.context_override.as_ref().unwrap()["toolArgs"],
        json!({"path":"context-only"})
    );
    let restored = save(&db, &cleared_first["snapshot"], json!([]), true).unwrap();
    assert_eq!(restored["updates"].as_array().unwrap().len(), 4);
    assert_eq!(
        restored["snapshot"]["messages"][0]["thinking"],
        "full\nvisible thinking"
    );
    assert!(restored["snapshot"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("override").is_none() && row.get("legacyExcludeThinking").is_none()));
    assert_eq!(canon(&db, &session), original);
}

#[test]
fn rejects_wrong_role_types_foreign_ids_and_stale_source_or_membership_atomically() {
    let (_dir, db, session) = fixture();
    populate(&db, &session);
    let snap = read(&db, &session, "final").unwrap();
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let before = std::fs::read(&path).unwrap();
    for bad in [
        edit("final", json!({"version":1,"content":" \n "})),
        edit("final", json!({"version":2,"content":"valid"})),
        edit("final", json!({"version":1,"thinking":null})),
        edit("final", json!({"version":1,"toolArgs":{}})),
        edit("opaque", json!({"version":1,"excludeThinking":"true"})),
        edit("t1", json!({"version":1,"toolArgs":[]})),
        edit("t1", json!({"version":1,"toolResultText":{"result":1}})),
        edit("t1", json!({"version":1,"toolCallId":"new-id"})),
        edit("old", Value::Null),
        edit("sys", Value::Null),
        edit("user", Value::Null),
        edit("child", Value::Null),
        edit("unknown", Value::Null),
        edit("first", Value::Null),
    ] {
        let err = save(
            &db,
            &snap,
            json!([
                edit("first", json!({"version":1,"thinking":"replacement"})),
                bad
            ]),
            false,
        )
        .unwrap_err();
        assert!(err.to_string().starts_with("INVALID_PARAMS:"), "{err:#}");
    }
    assert!(save(&db, &snap, json!([edit("t1", Value::Null)]), true).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);

    let mut native = dedupe_records(transcripts::read_transcript(db.data_dir(), &session).unwrap())
        .into_iter()
        .find(|r| r.id == "t1")
        .unwrap();
    native.blocks[0]["args"] = json!("native unsupported shape");
    transcripts::update_message(db.data_dir(), &session, &native).unwrap();
    assert!(save(&db, &snap, json!([]), false)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
    let fresh = read(&db, &session, "final").unwrap();
    assert!(fresh["messages"][1].get("toolArgs").is_none());
    assert!(save(
        &db,
        &fresh,
        json!([edit("t1", json!({"version":1,"toolArgs":{}}))]),
        false
    )
    .unwrap_err()
    .to_string()
    .contains("read-only"));
    db.conn()
        .execute(
            "UPDATE messages SET turn_id=NULL WHERE session_id=?1 AND id='sys'",
            [&session],
        )
        .unwrap();
    assert!(save(&db, &fresh, json!([]), false)
        .unwrap_err()
        .to_string()
        .starts_with("CONFLICT:"));
}

#[test]
fn fork_uses_real_prompt_and_splice_failure_leaves_overlays_and_checkpoints_unchanged() {
    let (_dir, db, session) = fixture();
    populate(&db, &session);
    let snap = read(&db, &session, "final").unwrap();
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::create_dir(&tmp).unwrap();
    let edits = json!([edit(
        "first",
        json!({"version":1,"thinking":"context only"})
    )]);
    assert!(save(&db, &snap, edits.clone(), false).is_err());
    assert_eq!(read(&db, &session, "final").unwrap(), snap);
    assert_eq!(
        transcripts::read_compactions(db.data_dir(), &session)
            .unwrap()
            .len(),
        3
    );
    std::fs::remove_dir(tmp).unwrap();
    let source = save(&db, &snap, edits, false).unwrap()["snapshot"].clone();
    let ForkSessionResult::Created(fork) =
        fork_session_through(&db, &session, None, Some("final")).unwrap()
    else {
        panic!("expected fork")
    };
    let anchor = &fork.messages.last().unwrap().id;
    let child = read(&db, &fork.summary.id, anchor).unwrap();
    assert_ne!(child["revision"], source["revision"]);
    assert_eq!(child["messages"].as_array().unwrap().len(), 5);
    assert_eq!(child["messages"][0]["override"]["thinking"], "context only");
    assert_eq!(
        save(&db, &child, json!([]), true).unwrap()["updates"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(read(&db, &session, "final").unwrap(), source);
    let running = begin_turn(&db, &session, None, None).unwrap();
    assert!(read(&db, &session, "final")
        .unwrap_err()
        .to_string()
        .starts_with("AGENT_BUSY:"));
    assert!(save(&db, &source, json!([]), true)
        .unwrap_err()
        .to_string()
        .starts_with("AGENT_BUSY:"));
    end_turn(&db, &running, "aborted", None, None, false).unwrap();
}

#[test]
fn fallback_uses_canonical_prompt_and_splice_keeps_distinct_original_receipts() {
    let (_dir, db, session) = fixture();
    let original = completed_tool("tool", json!({"path":"old"}), json!("old receipt"));
    let mut rows = vec![message("user", "user", "real prompt"), original];
    rows.extend((0..8).map(|i| message(&format!("a-{i}"), "assistant", "step")));
    rows.push(message("steer", "user", "steering prompt"));
    replace_messages(&db, &session, &rows).unwrap();
    let created = session_created_at(&db, &session).unwrap();
    let mut steer = rows.pop().unwrap();
    steer.steering = Some(true);
    for row in [
        steer,
        completed_tool("tool", json!({"path":"new"}), json!("new receipt")),
    ] {
        let (record, _) = ui_to_record(&row);
        transcripts::append_message(db.data_dir(), &session, &created, &record).unwrap();
    }
    append_message(
        &db,
        &session,
        &message("final", "assistant", "answer"),
        None,
    )
    .unwrap();
    let before = read(&db, &session, "final").unwrap();
    assert_eq!(before["messages"][0]["messageId"], "tool");
    assert_eq!(before["messages"][0]["toolResultText"], "new receipt");
    let overlay = json!({"version":1,"toolResultText":"model receipt"});
    let updated = save(&db, &before, json!([edit("tool", overlay.clone())]), false).unwrap();
    let physical = transcripts::read_transcript(db.data_dir(), &session).unwrap();
    let tools: Vec<_> = physical.iter().filter(|row| row.id == "tool").collect();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].blocks[0]["result"], "old receipt");
    assert_eq!(tools[1].blocks[0]["result"], "new receipt");
    assert!(tools
        .iter()
        .all(|row| row.meta.as_ref().unwrap()["contextOverride"] == overlay));
    assert_eq!(read(&db, &session, "final").unwrap(), updated["snapshot"]);
}

#[test]
fn final_content_can_be_excluded_and_restored_without_changing_original() {
    let (_dir, db, session) = fixture();
    populate(&db, &session);
    let original = canon(&db, &session);
    let snap = read(&db, &session, "final").unwrap();
    let excluded = save(
        &db,
        &snap,
        json!([edit(
            "final",
            json!({
                "version":1,"excludeContent":true,"content":""
            })
        )]),
        false,
    )
    .unwrap();
    assert_eq!(
        excluded["snapshot"]["messages"][4]["override"]["excludeContent"],
        true
    );
    assert_eq!(
        excluded["snapshot"]["messages"][4]["content"],
        "originalneedle answer"
    );
    assert_eq!(canon(&db, &session), original);
    assert!(save(
        &db,
        &excluded["snapshot"],
        json!([edit(
            "final",
            json!({
                "version":1,"excludeContent":false,"content":" "
            })
        )]),
        false
    )
    .unwrap_err()
    .to_string()
    .starts_with("INVALID_PARAMS:"));
    let restored = save(&db, &excluded["snapshot"], json!([]), true).unwrap();
    assert_eq!(
        restored["updates"],
        json!([
            {"messageId":"first","contextOverride":null,"excludeThinkingFromContext":false},
            {"messageId":"final","contextOverride":null}
        ])
    );
    assert!(restored["snapshot"]["messages"][4]
        .get("override")
        .is_none());
    assert_eq!(canon(&db, &session), original);
}

#[test]
fn snapshot_redacts_nested_media_without_modifying_canonical_results() {
    let (_dir, db, session) = fixture();
    let media = json!({"data":"business data must stay", "nested":[
        {"type":"image","mimeType":"image/png","data":"IMAGEPAYLOAD123=="},
        {"mimeType":"audio/wav","data":"AUDIOPAYLOAD123=="},
        {"url":"data:image/png;base64,URLPAYLOAD123=="},
        {"text":"before data:audio/wav;base64,EMBEDPAYLOAD123== after"},
        {"data":"ordinary-field"},
        {"resource":{"mimeType":"image/png","blob":"BLOBPAYLOAD123=="}}
    ]});
    let rows = [
        message("user", "user", "prompt"),
        completed_tool("tool", json!({}), media.clone()),
        message("final", "assistant", "answer"),
    ];
    for row in &rows {
        append_message(&db, &session, row, None).unwrap();
    }
    let original = canon(&db, &session);
    let path = transcripts::transcript_path(db.data_dir(), &session).unwrap();
    let original_file = std::fs::read(&path).unwrap();
    let snap = read(&db, &session, "final").unwrap();
    let text = snap["messages"][0]["toolResultText"].as_str().unwrap();
    for payload in [
        "IMAGEPAYLOAD123",
        "AUDIOPAYLOAD123",
        "URLPAYLOAD123",
        "EMBEDPAYLOAD123",
        "BLOBPAYLOAD123",
    ] {
        assert!(!text.contains(payload));
    }
    assert_eq!(
        text.matches("[binary media omitted from editor]").count(),
        5
    );
    assert!(text.contains("business data must stay"));
    assert!(text.contains("ordinary-field"));
    assert!(text.contains("before [binary media omitted from editor] after"));
    assert!(snap["messages"][0].get("override").is_none());
    assert_eq!(std::fs::read(&path).unwrap(), original_file);
    assert_eq!(canon(&db, &session), original);
    let ui = get_session(&db, &session).unwrap().unwrap().messages;
    assert_eq!(ui[1].tool_result, Some(media));
    assert!(ui[1].context_override.is_none());
}

#[test]
fn row_and_byte_limits_fail_without_truncation_or_mutation() {
    let (_dir, db, session) = fixture();
    let rows = (0..1024).map(|i| message(&format!("a-{i}"), "assistant", "step"));
    let mut messages = vec![message("user", "user", "prompt")];
    messages.extend(rows);
    messages.push(message("final", "assistant", "answer"));
    replace_messages(&db, &session, &messages).unwrap();
    assert!(read(&db, &session, "final")
        .unwrap_err()
        .to_string()
        .starts_with("LIMIT_EXCEEDED:"));
    let mut messages = vec![
        message("user", "user", "prompt"),
        message("final", "assistant", "answer"),
    ];
    replace_messages(&db, &session, &messages).unwrap();
    let snap = read(&db, &session, "final").unwrap();
    let huge = "A".repeat(8 * 1024 * 1024);
    assert!(save(
        &db,
        &snap,
        json!([edit("final", json!({"version":1,"content":huge}))]),
        false
    )
    .unwrap_err()
    .to_string()
    .starts_with("LIMIT_EXCEEDED:"));
    assert_eq!(read(&db, &session, "final").unwrap(), snap);
    messages.insert(1, completed_tool("large", json!({}), json!({"data":huge})));
    replace_messages(&db, &session, &messages).unwrap();
    assert!(read(&db, &session, "final")
        .unwrap_err()
        .to_string()
        .starts_with("LIMIT_EXCEEDED:"));
}
