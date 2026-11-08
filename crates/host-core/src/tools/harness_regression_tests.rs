//! Synthetic user-path regressions for Edit harness compatibility and runner environment.
use super::*;

fn edit_fixture(input: &str) -> (tempfile::TempDir, PathBuf, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.txt");
    std::fs::write(&path, input).unwrap();
    let tag = hashline::tag_of_lf_text(&hashline::normalize_file(input.as_bytes()).text);
    (dir, path, tag)
}

#[tokio::test]
async fn blank_ops_legacy_replacement_and_deletion() {
    for ops in ["", " \r\n\t"] {
        for (new, expected) in [("B", "a\nB\nc\n"), ("", "a\nc\n")] {
            let (dir, path, _) = edit_fixture("a\nb\nc\n");
            let read = execute_tool(
                Some(dir.path()),
                None,
                "Read",
                &json!({"path":"fixture.txt"}),
                5_000,
            )
            .await;
            assert!(read.ok, "{:?}", read.content);
            let result = execute_tool(
                Some(dir.path()),
                None,
                "Edit",
                &json!({"path":"fixture.txt", "tag":read.content["tag"], "ops":ops,
                    "old_string":if new.is_empty() { "b\n" } else { "b" }, "new_string":new}),
                5_000,
            )
            .await;
            assert!(result.ok, "ops={ops:?}, new={new:?}: {:?}", result.content);
            assert_eq!(std::fs::read_to_string(path).unwrap(), expected);
            assert_eq!(result.content["tag"].as_str().unwrap().len(), 4);
        }
    }
}

#[tokio::test]
async fn blank_ops_legacy_guards_and_missing_pairs() {
    let input = "a\nb\nb\nc\n";
    let (dir, path, tag) = edit_fixture(input);
    for (fields, code) in [
        (json!({}), "EDIT_PARSE_FAILED"),
        (json!({"old_string":"a"}), "EDIT_PARSE_FAILED"),
        (json!({"new_string":"A"}), "EDIT_PARSE_FAILED"),
        (
            json!({"old_string":"", "new_string":""}),
            "EDIT_PARSE_FAILED",
        ),
        (
            json!({"old_string":"b", "new_string":"B"}),
            "EDIT_LEGACY_MATCH_FAILED",
        ),
        (
            json!({"old_string":"missing", "new_string":"B"}),
            "EDIT_LEGACY_MATCH_FAILED",
        ),
        (
            json!({"old_string":"a", "new_string":"a"}),
            "EDIT_NO_CHANGE",
        ),
        (
            json!({"old_string":"a", "new_string":"A", "tag":"0000"}),
            "EDIT_TAG_MISMATCH",
        ),
    ] {
        let mut args = json!({"path":"fixture.txt", "tag":tag, "ops":" \n\t"});
        args.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let result = execute_tool(Some(dir.path()), None, "Edit", &args, 5_000).await;
        assert!(!result.ok, "unexpected success: {args}");
        assert_eq!(
            result.error_code.as_deref(),
            Some(code),
            "{args}: {:?}",
            result.content
        );
        assert_eq!(std::fs::read(&path).unwrap(), input.as_bytes());
    }
}

#[test]
fn blank_ops_legacy_still_requires_seen_lines() {
    let input = "a\nb\nc\n";
    let (dir, path, tag) = edit_fixture(input);
    let store = HashlineStore::default();
    let ctx = HashlineContext {
        session_id: "synthetic",
        store: &store,
    };
    let file = hashline::normalize_file(input.as_bytes());
    store.record(
        "synthetic",
        &hashline::canonical_key(&path),
        &file,
        &tag,
        Some([1].into_iter().collect()),
    );
    let args =
        json!({"path":"fixture.txt", "tag":tag, "ops":"", "old_string":"b", "new_string":"B"});
    let error = tool_edit(
        Some(dir.path()),
        &ContainedRoots::new(),
        &args,
        false,
        Some(&ctx),
    )
    .unwrap_err();
    assert_eq!(error.code, "EDIT_LINES_UNSEEN");
    assert_eq!(error.extra["merged"], true);
    assert_eq!(error.extra["revealTruncated"], false);
    assert_eq!(error.extra["unseenLines"][0]["line"], 2);
    assert_eq!(std::fs::read(&path).unwrap(), input.as_bytes());
    tool_edit(
        Some(dir.path()),
        &ContainedRoots::new(),
        &args,
        false,
        Some(&ctx),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nB\nc\n");
}

#[tokio::test]
async fn nonempty_ops_reject_populated_legacy_but_accept_empty_defaults() {
    let input = "a\nb\nc\n";
    let (dir, path, tag) = edit_fixture(input);
    for fields in [
        json!({"old_string":"b", "new_string":"legacy"}),
        json!({"old_string":"b", "new_string":""}),
        json!({"old_string":"b"}),
        json!({"new_string":"legacy"}),
    ] {
        let mut args = json!({"path":"fixture.txt", "tag":tag, "ops":"PUT 2.=2:\n+ops\n"});
        args.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let result = execute_tool(Some(dir.path()), None, "Edit", &args, 5_000).await;
        assert!(!result.ok, "ambiguous payload must fail: {args}");
        assert_eq!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        assert_eq!(std::fs::read(&path).unwrap(), input.as_bytes());
    }
    let result = execute_tool(Some(dir.path()), None, "Edit", &json!({
        "path":"fixture.txt", "tag":tag, "ops":"PUT 2.=2:\n+ops\n", "old_string":"", "new_string":""
    }), 5_000).await;
    assert!(
        result.ok,
        "empty defaults are not another edit intent: {:?}",
        result.content
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), "a\nops\nc\n");
}

#[tokio::test]
async fn same_gap_diagnostics_identify_both_ops_and_leave_bytes_untouched() {
    let input = (1..=101)
        .map(|line| format!("line {line}\r\n"))
        .collect::<String>();
    for (first, second) in [
        ("PUT >99:", "PUT <100:"),
        ("PUT <100:", "PUT >99:"),
        ("PUT >$:", "PUT >$:"),
        ("PUT >101:", "PUT >$:"),
        ("PUT 100.=100:", "PUT >99:"),
    ] {
        let (dir, path, tag) = edit_fixture(&input);
        // Include a valid earlier mutation and a move: neither may land.
        let ops = format!("CUT 1.=1\n{first}\n+first\n{second}\n+second\nMV moved.txt\n");
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Edit",
            &json!({
                "path":"fixture.txt", "tag":tag, "ops":ops
            }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("EDIT_RANGE_INVALID"));
        let message = result.content["error"].as_str().unwrap();
        assert!(message.contains(&format!("op 2 ({first})")), "{message}");
        assert!(message.contains(&format!("op 3 ({second})")), "{message}");
        assert!(message.contains("single PUT"), "{message}");
        assert_eq!(std::fs::read(&path).unwrap(), input.as_bytes());
        assert!(!dir.path().join("moved.txt").exists());
    }
}

#[tokio::test]
async fn single_put_same_gap_repair_keeps_authored_order() {
    let (dir, path, tag) = edit_fixture("a\nb\nc\n");
    let result = execute_tool(
        Some(dir.path()),
        None,
        "Edit",
        &json!({
            "path":"fixture.txt", "tag":tag, "ops":"PUT >2:\n+first\n+second\n"
        }),
        5_000,
    )
    .await;
    assert!(result.ok, "{:?}", result.content);
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "a\nb\nfirst\nsecond\nc\n"
    );
}

#[tokio::test]
async fn blank_ops_legacy_without_tag_and_malformed_nonempty_ops() {
    let (dir, path, tag) = edit_fixture("a\nb\nc\n");
    let result = execute_tool(Some(dir.path()), None, "Edit", &json!({
        "path":"fixture.txt", "tag":tag, "ops":"PUT 2.=2\n+broken\n", "old_string":"", "new_string":""
    }), 5_000).await;
    assert_eq!(result.error_code.as_deref(), Some("EDIT_PARSE_FAILED"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\nb\nc\n");
    let result = execute_tool(
        Some(dir.path()),
        None,
        "Edit",
        &json!({
            "path":"fixture.txt", "ops":" \n", "old_string":"b", "new_string":"B"
        }),
        5_000,
    )
    .await;
    assert!(result.ok, "{:?}", result.content);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "a\nB\nc\n");
}

#[test]
fn runner_environment_preserves_extra_env_precedence() {
    let config = ToolRunnerStartConfig {
        program: PathBuf::from("synthetic"),
        args: Vec::new(),
        workspace: PathBuf::from("synthetic"),
        scratch_dir: Some("initial-scratch".into()),
        env_path: Some("initial-path".into()),
        extra_env: vec![
            ("PI_SCRATCH_DIR".into(), "explicit-scratch".into()),
            ("PATH".into(), "explicit-path".into()),
            ("PYTHONIOENCODING".into(), "ascii".into()),
        ],
    };
    let inherited = std::env::var_os("PYTHONIOENCODING");
    let mut command = Command::new(&config.program);
    runner_environment::apply(&mut command, &config);
    let env = command
        .as_std()
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().to_uppercase(),
                value.unwrap().to_string_lossy().into_owned(),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(env["PI_SCRATCH_DIR"], "explicit-scratch");
    assert_eq!(env["PATH"], "explicit-path");
    assert_eq!(env["PYTHONIOENCODING"], "ascii");
    assert!(!env.contains_key("PYTHONUTF8"));
    assert_eq!(std::env::var_os("PYTHONIOENCODING"), inherited);
}

#[cfg(not(windows))]
#[test]
fn runner_environment_has_no_python_default_on_non_windows() {
    let config = ToolRunnerStartConfig {
        program: PathBuf::from("synthetic"),
        args: Vec::new(),
        workspace: PathBuf::from("synthetic"),
        scratch_dir: None,
        env_path: None,
        extra_env: Vec::new(),
    };
    let mut command = Command::new(&config.program);
    runner_environment::apply(&mut command, &config);
    assert!(!command
        .as_std()
        .get_envs()
        .any(|(name, _)| name == "PYTHONIOENCODING"));
}
