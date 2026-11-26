use super::*;
use crate::file_resources::FileResources;
use crate::tool_budget::ToolBudget;
use std::pin::Pin;

struct SearchGate {
    key: GateKey,
    leave: Option<std::sync::mpsc::Sender<()>>,
}

impl SearchGate {
    fn new(root: &Path, path: &str) -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (leave, wait) = std::sync::mpsc::channel();
        let key = (root.to_owned(), path.to_owned());
        GATES.get_or_init(Default::default).lock().unwrap().insert(
            key.clone(),
            Arc::new(Gate {
                entered: StdMutex::new(Some(entered_tx)),
                leave: StdMutex::new(wait),
            }),
        );
        (
            Self {
                key,
                leave: Some(leave),
            },
            entered_rx,
        )
    }
    fn release(&mut self) {
        self.leave.take().unwrap().send(()).unwrap();
    }
}

impl Drop for SearchGate {
    fn drop(&mut self) {
        self.leave.take();
        GATES.get().unwrap().lock().unwrap().remove(&self.key);
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("search path stalled")
}

async fn pending_once<T>(future: Pin<&mut impl Future<Output = T>>) {
    let mut future = future;
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

async fn execute(
    budget: &ToolBudget,
    root: &Path,
    session: &str,
    name: &str,
    args: &Value,
    store: &HashlineStore,
) -> ToolsExecuteResult {
    let resources = FileResources::resolve(Some(root), &ContainedRoots::new(), name, args, false);
    let permit = budget
        .acquire_files(session, name, false, resources.clone(), None)
        .await
        .unwrap();
    execute_tool_with_file_lease(
        Some(root),
        None,
        name,
        args,
        ToolExecutionOptions {
            timeout_ms: None,
            bash_options: None,
            allow_external_paths: false,
            write_scope: None,
            hashline: Some(HashlineContext {
                session_id: session,
                store,
            }),
            visualization_root: None,
        },
        Some(Arc::new(permit)),
        Some(resources),
    )
    .await
}

#[tokio::test]
async fn grep_protects_current_hard_link_but_unrelated_write_completes() {
    let dir = tempfile::tempdir().unwrap();
    let root = simple_canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("actual"), "needle\n").unwrap();
    std::fs::hard_link(root.join("actual"), root.join("alias")).unwrap();
    let path = root.join("alias");
    let (mut gate, entered) = SearchGate::new(&root, path.to_str().unwrap());
    let budget = ToolBudget::new();
    let store = HashlineStore::new();
    let args = json!({"path":".","include":"alias","pattern":"needle"});
    let mut grep = Box::pin(execute(&budget, &root, "search", "Grep", &args, &store));
    pending_once(grep.as_mut()).await;
    bounded(entered).await.unwrap();
    // This is a real new-file Write, not just an admission assertion.
    let other = bounded(execute(
        &budget,
        &root,
        "writer",
        "Write",
        &json!({"path":"new","content":"unrelated"}),
        &store,
    ))
    .await;
    assert!(other.ok, "{:?}", other.content);
    assert_eq!(
        std::fs::read_to_string(root.join("new")).unwrap(),
        "unrelated"
    );
    let write_args = json!({"path":"actual","content":"changed\n"});
    let mut writer = Box::pin(execute(
        &budget,
        &root,
        "writer",
        "Write",
        &write_args,
        &store,
    ));
    pending_once(writer.as_mut()).await;
    assert_eq!(
        std::fs::read_to_string(root.join("actual")).unwrap(),
        "needle\n"
    );
    gate.release();
    let found = bounded(grep).await;
    assert!(found.ok, "{:?}", found.content);
    assert_eq!(found.content["matches"][0]["text"], "needle");
    assert!(found.content["tags"]["alias"].is_string());
    assert!(bounded(writer).await.ok);
    assert_eq!(
        std::fs::read_to_string(root.join("alias")).unwrap(),
        "changed\n"
    );
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn grep_tag_can_edit_the_returned_match() {
    let dir = tempfile::tempdir().unwrap();
    let root = simple_canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("a"), "needle\nother\n").unwrap();
    let budget = ToolBudget::new();
    let store = HashlineStore::new();
    let found = execute(
        &budget,
        &root,
        "s",
        "Grep",
        &json!({"path":"a","pattern":"needle"}),
        &store,
    )
    .await;
    assert!(found.ok, "{:?}", found.content);
    let tag = found.content["tags"]["a"].as_str().unwrap();
    let edited = execute(
        &budget,
        &root,
        "s",
        "Edit",
        &json!({"path":"a","tag":tag,"ops":"PUT 1.=1:\n+changed"}),
        &store,
    )
    .await;
    assert!(edited.ok, "{:?}", edited.content);
    assert_eq!(
        std::fs::read_to_string(root.join("a")).unwrap(),
        "changed\nother\n"
    );
}

#[tokio::test]
async fn cancelled_search_releases_capacity_and_does_not_read_next_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = simple_canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("a"), "needle\n").unwrap();
    let budget = ToolBudget::new();
    let store = HashlineStore::new();
    for name in ["Glob", "Grep"] {
        // Pause before enumeration, then cancel the real async tool waiter.
        let (mut gate, entered) = SearchGate::new(&root, ".");
        let path = root.join("a");
        let (_next_gate, mut next_entered) = SearchGate::new(&root, path.to_str().unwrap());
        let args = json!({"path":".","pattern":"needle"});
        let mut search = Box::pin(execute(&budget, &root, "s", name, &args, &store));
        pending_once(search.as_mut()).await;
        bounded(entered).await.unwrap();
        let other = bounded(execute(
            &budget,
            &root,
            "other",
            "Write",
            &json!({"path":"independent","content":"ok"}),
            &store,
        ))
        .await;
        assert!(
            other.ok,
            "metadata enumeration blocked an independent write"
        );
        drop(search);
        assert_eq!(
            budget.snapshot().active,
            1,
            "blocking task must retain ownership until it exits"
        );
        gate.release();
        let exclusive =
            bounded(budget.acquire_session_exclusive("s", Duration::from_secs(5))).await;
        assert!(exclusive.is_some());
        assert!(
            next_entered.try_recv().is_err(),
            "cancelled search read another file"
        );
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }
}

#[tokio::test]
async fn closing_search_owner_interrupts_file_lease_wait() {
    let dir = tempfile::tempdir().unwrap();
    let root = simple_canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("a"), "before").unwrap();
    let budget = ToolBudget::new();
    let resources = FileResources::resolve(
        Some(&root),
        &ContainedRoots::new(),
        "Write",
        &json!({"path":"a"}),
        false,
    );
    let writer = budget
        .acquire_files("writer", "Write", false, resources, None)
        .await
        .unwrap();
    let search_resources = FileResources::resolve(
        Some(&root),
        &ContainedRoots::new(),
        "Grep",
        &json!({"path":"."}),
        false,
    );
    let search = Arc::new(
        budget
            .acquire_files("search", "Grep", false, search_resources, None)
            .await
            .unwrap(),
    );
    let (owner, control) = search_control::SearchControl::new(Some(search));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let worker = tokio::task::spawn_blocking(move || {
        started_tx.send(()).unwrap();
        control
            .read_file(&root, &ContainedRoots::new(), &root.join("a"), false)
            .err()
            .unwrap()
            .0
    });
    bounded(started_rx).await.unwrap();
    drop(owner);
    assert_eq!(bounded(worker).await.unwrap(), "TOOL_ABORTED");
    assert_eq!(budget.snapshot().active, 1);
    assert_eq!(budget.snapshot().queued, 0);
    drop(writer);
}

#[test]
fn clipped_single_line_checks_cancellation_between_buffered_chunks() {
    let input = std::io::Cursor::new(vec![b'x'; 256 * 1024]);
    let mut reader = LineReader {
        reader: BufReader::with_capacity(64, input),
    };
    let mut checks = 0;
    let result = reader.next_line_checked(16, || {
        checks += 1;
        if checks == 3 {
            Err(std::io::Error::new(ErrorKind::Interrupted, "cancelled"))
        } else {
            Ok(())
        }
    });
    assert!(matches!(result, Err(error) if error.kind() == ErrorKind::Interrupted));
    assert_eq!(checks, 3);
}

#[tokio::test]
async fn grep_content_truncation_counts_only_returned_files() {
    let long_line = format!("needle{}\n", "x".repeat(MAX_LINE_CHARS - 6));
    for (text, head_limit) in [
        ("needle\nneedle\n".to_string(), 1),
        ("needle\n".to_string(), 1),
        (long_line.repeat(32), BUDGET_SEARCH.max_lines),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = simple_canonicalize(dir.path()).unwrap();
        for name in ["a", "b"] {
            std::fs::write(root.join(name), &text).unwrap();
        }
        let result = execute(
            &ToolBudget::new(),
            &root,
            "s",
            "Grep",
            &json!({"path":".","pattern":"needle","outputMode":"content","headLimit":head_limit}),
            &HashlineStore::new(),
        )
        .await;
        assert!(result.ok, "{:?}", result.content);
        assert_eq!(result.content["truncated"], true);
        let matches = result.content["matches"].as_array().unwrap();
        assert!(!matches.is_empty());
        let returned_files: std::collections::HashSet<_> = matches
            .iter()
            .map(|hit| hit["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            result.content["files"].as_u64().unwrap(),
            returned_files.len() as u64
        );
        assert_eq!(
            result.content["tags"].as_object().unwrap().len(),
            returned_files.len()
        );
        for path in returned_files {
            assert!(result.content["tags"][path].is_string());
        }
    }
}
