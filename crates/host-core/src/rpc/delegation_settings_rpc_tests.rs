use super::delegation_settings::tests::{invalid_policies, policy};
use super::*;

#[tokio::test]
async fn session_delegation_pool_preserves_inheritance_and_activity_across_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({"title": "Scoped delegation", "mode": "agent"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_owned();
    let updated = created["session"]["updatedAt"].clone();
    let saved = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": ["account/model"]}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved["session"]["delegationModelKeys"],
        json!(["account/model"])
    );
    assert_eq!(saved["session"]["updatedAt"], updated);
    let rejected = handle_request(state.clone(), "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": ["account/model", "account/model"]}), tx.clone()).await;
    assert!(rejected.is_err());
    drop(state);
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let read = handle_request(
        state.clone(),
        "session.delegationPolicy",
        json!({"id": id}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(read["modelKeys"], json!(["account/model"]));
    let disabled = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": []}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(disabled["session"]["delegationModelKeys"], json!([]));
    let inherited = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": null}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert!(inherited["session"].get("delegationModelKeys").is_none());
    let read = handle_request(
        state.clone(),
        "session.delegationPolicy",
        json!({"id": id}),
        tx,
    )
    .await
    .unwrap();
    assert!(read["modelKeys"].is_null());
}

#[tokio::test]
async fn delegation_settings_roundtrips_and_omitted_patch_preserves_policy() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    handle_request(
        state.clone(),
        "settings.set",
        json!({"theme": "dark", "unrelated": {"keep": true}}),
        tx.clone(),
    )
    .await
    .unwrap();
    let legacy = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert!(
        legacy.get("delegation").is_none(),
        "absence must remain legacy"
    );
    handle_request(
        state.clone(),
        "settings.set",
        json!({"delegation": policy()}),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({"theme": "light"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let saved = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(saved["delegation"], policy());
    assert_eq!(saved["theme"], "light");
    assert_eq!(saved["unrelated"], json!({"keep": true}));
    drop(state);
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let reopened = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        reopened, saved,
        "policy must persist across reopening the host"
    );
    let empty = json!({"version": 1, "approvalTimeoutSeconds": 0, "models": []});
    handle_request(
        state.clone(),
        "settings.set",
        json!({"delegation": empty}),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({"fontScale": 1.1}),
        tx.clone(),
    )
    .await
    .unwrap();
    let saved = handle_request(state.clone(), "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(
        saved["delegation"], empty,
        "empty models must remain authoritative"
    );
    assert_eq!(
        state.lock().await.db.get_setting("app").unwrap().unwrap(),
        saved
    );
}

#[tokio::test]
async fn delegation_settings_invalid_writes_leave_saved_settings_unchanged() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    handle_request(
        state.clone(),
        "settings.set",
        json!({"delegation": policy(), "theme": "dark"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let saved = state.lock().await.db.get_setting("app").unwrap().unwrap();
    let mut patches: Vec<Value> = invalid_policies()
        .into_iter()
        .map(|delegation| json!({"delegation": delegation, "theme": "light"}))
        .collect();
    patches.extend([
        Value::Null,
        json!([]),
        json!(false),
        json!("reset"),
        json!(1),
    ]);
    for patch in patches {
        let error = handle_request(state.clone(), "settings.set", patch.clone(), tx.clone())
            .await
            .expect_err("invalid write must not erase or downgrade the saved policy");
        assert_eq!(error.code, 1002, "{patch}");
        assert_eq!(
            error.data.unwrap()["errorCode"],
            "INVALID_PARAMS",
            "{patch}"
        );
        assert_eq!(
            state.lock().await.db.get_setting("app").unwrap().as_ref(),
            Some(&saved),
            "{patch}"
        );
    }
    assert_eq!(
        handle_request(state, "settings.get", json!({}), tx)
            .await
            .unwrap(),
        saved
    );
}
