use super::super::{handle_request, resolve_tool_workspace};
use crate::session_worktrees::test_support::{git_cmd, init_repo};
use crate::state::AppState;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

async fn call(state: &Arc<Mutex<AppState>>, method: &str, params: Value) -> Result<Value, Value> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0)
        .await
        .map_err(|error| json!({ "message": error.message, "data": error.data }))
}

#[tokio::test]
async fn recycle_bin_worktree_user_path_and_restore_purge_race() {
    let dir = tempfile::tempdir().unwrap();
    let project = init_repo(&dir.path().join("project"));
    fs::write(project.join("f.txt"), "base\n").unwrap();
    git_cmd(&project, &["add", "f.txt"]);
    git_cmd(&project, &["commit", "-q", "-m", "initial"]);
    let mut app = AppState::open(&dir.path().join("data")).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let created = call(
        &state,
        "session.create",
        json!({
            "projectPath": project.to_string_lossy(), "isolated": true, "title": "Recycle me"
        }),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    let root = {
        let st = state.lock().await;
        PathBuf::from(resolve_tool_workspace(&st, id).unwrap().unwrap())
    };
    fs::write(root.join("uncommitted.txt"), "retain this").unwrap();
    assert!(call(&state, "session.deleteTrashed", json!({ "id": id }))
        .await
        .is_err());
    assert!(root.join("uncommitted.txt").exists());
    assert_eq!(
        call(&state, "session.trash", json!({ "id": id }))
            .await
            .unwrap()["ok"],
        true
    );
    assert!(root.join("uncommitted.txt").exists());
    assert!(
        call(&state, "session.list", json!({})).await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(call(&state, "session.get", json!({ "id": id }))
        .await
        .unwrap()["session"]
        .is_null());
    let trash = call(&state, "session.listTrashed", json!({}))
        .await
        .unwrap();
    assert_eq!(trash["sessions"][0]["id"], id);
    assert!(trash["sessions"][0]["deletedAt"].is_string());
    assert_eq!(
        call(&state, "session.restoreTrashed", json!({ "id": id }))
            .await
            .unwrap()["ok"],
        true
    );
    assert!(root.join("uncommitted.txt").exists());
    assert_eq!(
        call(&state, "session.list", json!({})).await.unwrap()["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    call(&state, "session.trash", json!({ "id": id }))
        .await
        .unwrap();
    // Deletion holds the gate while Git yields; restore must not resurrect it.
    let (deleted, restored) = tokio::join!(
        call(&state, "session.deleteTrashed", json!({ "id": id })),
        call(&state, "session.restoreTrashed", json!({ "id": id })),
    );
    assert_eq!(deleted.unwrap()["ok"], true);
    assert_eq!(restored.unwrap()["ok"], false);
    assert!(!root.exists());
    assert_eq!(fs::read_to_string(project.join("f.txt")).unwrap(), "base\n");
}

#[tokio::test]
async fn recycle_bin_rejects_nonlocal_ids_and_running_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = crate::sessions::create_session(&app.db, None, None, None, None, None).unwrap();
    crate::sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app));
    for method in [
        "session.trash",
        "session.restoreTrashed",
        "session.deleteTrashed",
    ] {
        for id in ["", "remote:host:session", "native-pi:session"] {
            let error = call(&state, method, json!({ "id": id })).await.unwrap_err();
            assert_eq!(error["data"]["errorCode"], "INVALID_ARGUMENT");
        }
        let error = call(&state, method, json!({ "id": session.id }))
            .await
            .unwrap_err();
        assert_eq!(error["data"]["errorCode"], "AGENT_BUSY");
    }
    assert!(call(&state, "session.listTrashed", json!({}))
        .await
        .unwrap()["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}
