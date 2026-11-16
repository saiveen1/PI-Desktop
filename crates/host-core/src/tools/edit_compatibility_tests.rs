//! Public file-tool regressions for optional Edit fields and retained read ranges.
use super::*;

async fn session_tool(
    root: &Path,
    store: &HashlineStore,
    session: &str,
    name: &str,
    args: Value,
) -> ToolsExecuteResult {
    execute_tool_with_path_access(
        Some(root),
        None,
        name,
        &args,
        ToolExecutionOptions {
            timeout_ms: Some(5_000),
            bash_options: None,
            allow_external_paths: false,
            hashline: Some(HashlineContext {
                session_id: session,
                store,
            }),
            visualization_root: None,
        },
    )
    .await
}

#[tokio::test]
async fn legacy_empty_tag_defaults_match_omitted_tag() {
    for tag in [None, Some(""), Some(" \r\n\t")] {
        for ops in [None, Some(""), Some(" \r\n\t")] {
            for (new, expected) in [("B\n", "a\nB\nc\n"), ("", "a\nc\n")] {
                let (dir, path, _) = edit_fixture("a\nb\nc\n");
                let store = HashlineStore::new();
                let read = session_tool(
                    dir.path(),
                    &store,
                    "s",
                    "Read",
                    json!({"path":"fixture.txt"}),
                )
                .await;
                assert!(read.ok, "{:?}", read.content);
                let mut args = json!({"path":"fixture.txt", "old_string":"b\n", "new_string":new});
                if let Some(tag) = tag {
                    args["tag"] = json!(tag);
                }
                if let Some(ops) = ops {
                    args["ops"] = json!(ops);
                }
                let edited = session_tool(dir.path(), &store, "s", "Edit", args.clone()).await;
                assert!(edited.ok, "{args}: {:?}", edited.content);
                assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
                assert_ne!(edited.content["tag"], read.content["tag"]);
            }
        }
    }
}

#[tokio::test]
async fn legacy_empty_tag_keeps_match_and_provenance_guards() {
    for tag in ["", " \t"] {
        let input = "a\nb\nb\nc\n";
        let (dir, path, _) = edit_fixture(input);
        let store = HashlineStore::new();
        let read = session_tool(
            dir.path(),
            &store,
            "s",
            "Read",
            json!({
                "path":"fixture.txt", "offset":0, "limit":1
            }),
        )
        .await;
        assert!(read.ok);
        for (old, code) in [
            ("missing", "EDIT_LEGACY_MATCH_FAILED"),
            ("b", "EDIT_LEGACY_MATCH_FAILED"),
            ("a", "EDIT_NO_CHANGE"),
        ] {
            let result = session_tool(
                dir.path(),
                &store,
                "s",
                "Edit",
                json!({
                    "path":"fixture.txt", "tag":tag, "ops":"", "old_string":old, "new_string":"a"
                }),
            )
            .await;
            assert_eq!(
                result.error_code.as_deref(),
                Some(code),
                "{:?}",
                result.content
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        }
        let args =
            json!({"path":"fixture.txt", "tag":tag, "ops":"", "old_string":"c", "new_string":"C"});
        let unseen = session_tool(dir.path(), &store, "s", "Edit", args.clone()).await;
        assert_eq!(
            unseen.error_code.as_deref(),
            Some("EDIT_LINES_UNSEEN"),
            "{:?}",
            unseen.content
        );
        assert_eq!(unseen.content["merged"], true);
        assert_eq!(unseen.content["revealTruncated"], false);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        let retry = session_tool(dir.path(), &store, "s", "Edit", args).await;
        assert!(retry.ok, "{:?}", retry.content);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nb\nb\nC\n");
    }
}

#[tokio::test]
async fn malformed_and_stale_nonempty_legacy_tags_remain_errors() {
    let input = "a\nb\nc\n";
    let (dir, path, tag) = edit_fixture(input);
    assert_ne!(tag, "0000");
    for (supplied, code) in [
        ("oops", "EDIT_TAG_REQUIRED"),
        ("ABCDE", "EDIT_TAG_REQUIRED"),
        ("ABCG", "EDIT_TAG_REQUIRED"),
        (" A1B2 ", "EDIT_TAG_REQUIRED"),
        ("0000", "EDIT_TAG_MISMATCH"),
    ] {
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Edit",
            &json!({
                "path":"fixture.txt", "tag":supplied, "ops":"", "old_string":"b", "new_string":"B"
            }),
            5_000,
        )
        .await;
        assert_eq!(
            result.error_code.as_deref(),
            Some(code),
            "{supplied}: {:?}",
            result.content
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
    }
}

#[tokio::test]
async fn empty_tag_does_not_relax_line_edits_or_mixed_intents() {
    let input = "a\nb\nc\n";
    let (dir, path, _) = edit_fixture(input);
    for tag in [None, Some(""), Some(" \t")] {
        let mut args = json!({"path":"fixture.txt", "ops":"PUT 2.=2:\n+B"});
        if let Some(tag) = tag {
            args["tag"] = json!(tag);
        }
        let result = execute_tool(Some(dir.path()), None, "Edit", &args, 5_000).await;
        assert_eq!(result.error_code.as_deref(), Some("EDIT_TAG_REQUIRED"));
        args["old_string"] = json!("b");
        args["new_string"] = json!("B");
        let mixed = execute_tool(Some(dir.path()), None, "Edit", &args, 5_000).await;
        assert_eq!(mixed.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
    }
}

#[tokio::test]
async fn paginated_read_keeps_previously_displayed_edit_anchors() {
    let input = (1..=438)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    let (dir, path, _) = edit_fixture(&input);
    let store = HashlineStore::new();
    let first = session_tool(
        dir.path(),
        &store,
        "delegate",
        "Read",
        json!({
            "path":"fixture.txt", "offset":120, "limit":110
        }),
    )
    .await;
    assert!(first.ok);
    assert!(first.content["content"]
        .as_str()
        .unwrap()
        .contains("163:line 163"));
    let second = session_tool(
        dir.path(),
        &store,
        "delegate",
        "Read",
        json!({
            "path":"./fixture.txt", "offset":0, "limit":105
        }),
    )
    .await;
    assert!(second.ok);
    assert_eq!(first.content["tag"], second.content["tag"]);
    let edit = session_tool(
        dir.path(),
        &store,
        "delegate",
        "Edit",
        json!({
            "path":"fixture.txt", "tag":first.content["tag"], "ops":"PUT 163.=167:\n+changed"
        }),
    )
    .await;
    assert!(edit.ok, "{:?}", edit.content);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        input.replace(
            "line 163\nline 164\nline 165\nline 166\nline 167\n",
            "changed\n"
        )
    );
}

#[tokio::test]
async fn grep_does_not_forget_full_read_or_share_another_sessions_provenance() {
    for mode in ["content", "filesWithMatches", "count"] {
        let input = (1..=210)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        let (dir, path, _) = edit_fixture(&input);
        let store = HashlineStore::new();
        let read = session_tool(
            dir.path(),
            &store,
            "delegate",
            "Read",
            json!({
                "path":"fixture.txt", "limit":250
            }),
        )
        .await;
        assert!(read.ok);
        assert_eq!(read.content["lineCount"], 210);
        let grep = session_tool(
            dir.path(),
            &store,
            "delegate",
            "Grep",
            json!({
                "path":"fixture.txt", "pattern":"^line 24$", "outputMode":mode
            }),
        )
        .await;
        assert!(grep.ok, "{:?}", grep.content);
        assert_eq!(grep.content["tags"]["fixture.txt"], read.content["tag"]);
        let other = session_tool(
            dir.path(),
            &store,
            "other",
            "Read",
            json!({
                "path":"fixture.txt", "limit":1
            }),
        )
        .await;
        assert!(other.ok);
        let args =
            json!({"path":"fixture.txt", "tag":read.content["tag"], "ops":"PUT >210:\n+appended"});
        let denied = session_tool(dir.path(), &store, "other", "Edit", args.clone()).await;
        assert_eq!(denied.error_code.as_deref(), Some("EDIT_LINES_UNSEEN"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), input);
        let edited = session_tool(dir.path(), &store, "delegate", "Edit", args).await;
        assert!(edited.ok, "{mode}: {:?}", edited.content);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{input}appended\n")
        );
    }
}

#[tokio::test]
async fn legacy_empty_tag_requires_nonempty_old_text() {
    for tag in ["", " \t"] {
        for ops in [None, Some(""), Some(" \t")] {
            let (dir, path, _) = edit_fixture("");
            let mut args =
                json!({"path":"fixture.txt", "tag":tag, "old_string":"", "new_string":"inserted"});
            if let Some(ops) = ops {
                args["ops"] = json!(ops);
            }
            let result = execute_tool(Some(dir.path()), None, "Edit", &args, 5_000).await;
            assert_eq!(result.error_code.as_deref(), Some("EDIT_TAG_REQUIRED"));
            assert_eq!(std::fs::read_to_string(path).unwrap(), "");
        }
    }
}
