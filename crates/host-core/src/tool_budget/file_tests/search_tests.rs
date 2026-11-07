use super::*;
use std::path::Path;

fn resolve(root: &Path, name: &str, path: &str) -> Arc<FileResources> {
    FileResources::resolve(
        Some(root),
        &ContainedRoots::new(),
        name,
        &json!({"path":path}),
        false,
    )
}

#[tokio::test]
async fn searches_at_session_limit_can_finish_ahead_of_capacity_blocked_writer() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    let budget = ToolBudget::new();
    let mut searches = Vec::new();
    for _ in 0..MAX_IN_FLIGHT_PER_SESSION {
        searches.push(Arc::new(
            budget
                .acquire_files("s", "Grep", false, resolve(dir.path(), "Grep", "."), None)
                .await
                .unwrap(),
        ));
    }
    let mut writer = Box::pin(budget.acquire_files(
        "s",
        "Write",
        false,
        resolve(dir.path(), "Write", "a"),
        None,
    ));
    pending(writer.as_mut()).await;
    let file =
        ready(Box::pin(searches[0].acquire_search_read(resolve(dir.path(), "Read", "a"))).as_mut())
            .await
            .unwrap();
    assert_eq!(budget.snapshot().active, MAX_IN_FLIGHT_PER_SESSION);
    pending(writer.as_mut()).await;
    drop(file);
    drop(searches);
    drop(ready(writer.as_mut()).await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn per_file_search_reads_preserve_alias_exclusion_and_writer_fairness() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    std::fs::hard_link(dir.path().join("a"), dir.path().join("alias")).unwrap();
    std::fs::write(dir.path().join("other"), "other").unwrap();
    let budget = ToolBudget::new();
    let search = Arc::new(
        budget
            .acquire_files("s", "Grep", false, resolve(dir.path(), "Grep", "."), None)
            .await
            .unwrap(),
    );
    let first = search
        .acquire_search_read(resolve(dir.path(), "Read", "alias"))
        .await
        .unwrap();
    let mut writer = Box::pin(budget.acquire_files(
        "writer",
        "Write",
        false,
        resolve(dir.path(), "Write", "a"),
        None,
    ));
    pending(writer.as_mut()).await;
    let mut later = Box::pin(search.acquire_search_read(resolve(dir.path(), "Read", "alias")));
    pending(later.as_mut()).await;
    let mut independent =
        Box::pin(search.acquire_search_read(resolve(dir.path(), "Read", "other")));
    drop(ready(independent.as_mut()).await.unwrap());
    drop(first);
    let writer = ready(writer.as_mut()).await.unwrap();
    pending(later.as_mut()).await;
    drop(writer);
    drop(independent);
    drop(ready(later.as_mut()).await.unwrap());
    drop(later);
    drop(search);
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
}

#[tokio::test]
async fn pending_session_exclusive_cannot_prevent_search_from_draining() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    let budget = ToolBudget::new();
    let search = Arc::new(
        budget
            .acquire_files("s", "Grep", false, resolve(dir.path(), "Grep", "."), None)
            .await
            .unwrap(),
    );
    let mut exclusive = Box::pin(budget.acquire_session_exclusive("s", Duration::from_secs(5)));
    pending(exclusive.as_mut()).await;
    let file =
        ready(Box::pin(search.acquire_search_read(resolve(dir.path(), "Read", "a"))).as_mut())
            .await
            .unwrap();
    drop(search);
    pending(exclusive.as_mut()).await; // the child still owns its parent slot
    drop(file);
    drop(ready(exclusive.as_mut()).await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn search_source_order_still_blocks_later_same_batch_write() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    let budget = ToolBudget::new();
    let a = call(0, "Grep", ".");
    let b = call(1, "Write", "a");
    let ta = budget.register_file_call(a.clone()).unwrap();
    let tb = budget.register_file_call(b.clone()).unwrap();
    budget.seal_file_batch("batch", "s").unwrap();
    let _pa = budget
        .begin_file_call(&ta, "s", None, &a.tool_call_id, "Grep", &a.args)
        .unwrap();
    let _pb = budget
        .begin_file_call(&tb, "s", None, &b.tool_call_id, "Write", &b.args)
        .unwrap();
    let search = Arc::new(
        budget
            .acquire_files(
                "s",
                "Grep",
                false,
                resolve(dir.path(), "Grep", "."),
                Some(ta),
            )
            .await
            .unwrap(),
    );
    let mut writer = Box::pin(budget.acquire_files(
        "s",
        "Write",
        false,
        resolve(dir.path(), "Write", "a"),
        Some(tb),
    ));
    pending(writer.as_mut()).await;
    let mut file = Box::pin(search.acquire_search_read(resolve(dir.path(), "Read", "a")));
    drop(ready(file.as_mut()).await.unwrap());
    drop(file);
    drop(search);
    drop(ready(writer.as_mut()).await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
}
