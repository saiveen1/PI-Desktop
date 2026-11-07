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
        json!({"id": id, "mode": "agent", "delegationModelKeys": ["account/model"],
            "delegationModelApprovals": {"account/model": "auto"}}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved["session"]["delegationModelKeys"],
        json!(["account/model"])
    );
    assert_eq!(saved["session"]["updatedAt"], updated);
    assert_eq!(
        saved["session"]["delegationModelApprovals"],
        json!({"account/model": "auto"})
    );
    let rejected = handle_request(state.clone(), "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": ["account/model", "account/model"]}), tx.clone()).await;
    assert!(rejected.is_err());
    let before_failure = {
        let app = state.lock().await;
        let summary =
            serde_json::to_value(sessions::session_summary(&app.db, &id).unwrap()).unwrap();
        app.db
            .conn()
            .execute_batch(
                "CREATE TRIGGER reject_delegation_pool BEFORE INSERT ON kv
             WHEN NEW.ns = 'sessionDelegation'
             BEGIN SELECT RAISE(ABORT, 'injected delegation storage failure'); END;",
            )
            .unwrap();
        summary
    };
    let failed_write = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "plan", "permissionMode": "auto", "fastMode": true,
            "delegationModelKeys": ["account/replacement"],
            "delegationModelApprovals": {"account/replacement": "ask"}}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert!(failed_write
        .message
        .contains("injected delegation storage failure"));
    assert_eq!(failed_write.code, 1000);
    assert_eq!(failed_write.data.unwrap()["errorCode"], "INTERNAL");
    {
        let app = state.lock().await;
        assert_eq!(
            serde_json::to_value(sessions::session_summary(&app.db, &id).unwrap()).unwrap(),
            before_failure,
            "a failed pool write must roll back configuration and activity together",
        );
        app.db
            .conn()
            .execute_batch("DROP TRIGGER reject_delegation_pool")
            .unwrap();
    }
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
    assert_eq!(read["modelApprovals"], json!({"account/model": "auto"}));
    let disabled = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelKeys": []}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(disabled["session"]["delegationModelKeys"], json!([]));
    assert!(disabled["session"]
        .get("delegationModelApprovals")
        .is_none());
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
    assert!(read["modelApprovals"].is_null());
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

#[tokio::test]
async fn session_delegation_approvals_validate_prune_and_follow_session_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    let created = handle_request(
        state.clone(),
        "session.create",
        json!({"mode": "agent"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap().to_owned();
    macro_rules! configure {
        ($patch:expr) => {{
            let mut params = $patch;
            params["id"] = json!(id);
            params["mode"] = json!("agent");
            handle_request(state.clone(), "session.configure", params, tx.clone())
                .await
                .unwrap()
        }};
    }
    for approvals in [json!({"account/model": "auto"}), json!({})] {
        assert!(handle_request(
            state.clone(),
            "session.configure",
            json!({"id": id, "mode": "agent", "delegationModelApprovals": approvals}),
            tx.clone()
        )
        .await
        .is_err());
    }
    // Historical arrays remain readable and do not invent approval consent.
    state
        .lock()
        .await
        .db
        .kv_set(
            crate::session_delegation::NAMESPACE,
            &id,
            &json!(["account/model", "account/other"]),
        )
        .unwrap();
    let legacy = handle_request(
        state.clone(),
        "session.delegationPolicy",
        json!({"id": id}),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        legacy["modelKeys"],
        json!(["account/model", "account/other"])
    );
    assert!(legacy["modelApprovals"].is_null());
    let approvals = json!({"account/model": "auto", "account/other": "ask"});
    let saved = configure!(json!({"delegationModelApprovals": approvals}));
    assert_eq!(
        saved["session"]["updatedAt"],
        created["session"]["updatedAt"]
    );
    assert_eq!(saved["session"]["delegationModelApprovals"], approvals);
    let omitted = configure!(json!({"fastMode": false}));
    assert_eq!(omitted["session"]["delegationModelApprovals"], approvals);
    for invalid in [
        json!([]),
        json!(false),
        json!({"account/model": "always"}),
        json!({"account/model": true}),
        json!({"account/missing": "auto"}),
        json!({"bad key": "ask"}),
        json!({"account/model ": "auto"}),
    ] {
        let failed = handle_request(state.clone(), "session.configure", json!({"id": id, "mode": "plan", "permissionMode": "auto", "fastMode": true, "delegationModelApprovals": invalid}), tx.clone()).await.unwrap_err();
        assert_eq!(failed.code, 1002);
        let current = handle_request(state.clone(), "session.get", json!({"id": id}), tx.clone())
            .await
            .unwrap();
        assert_eq!(current["session"]["delegationModelApprovals"], approvals);
        assert_eq!(current["session"]["mode"], "agent");
        assert_eq!(
            current["session"]["permissionMode"],
            omitted["session"]["permissionMode"]
        );
        assert_eq!(
            current["session"]["fastMode"],
            omitted["session"]["fastMode"]
        );
        assert_eq!(
            current["session"]["updatedAt"],
            omitted["session"]["updatedAt"]
        );
    }
    let forked = handle_request(
        state.clone(),
        "session.fork",
        json!({"sessionId": id}),
        tx.clone(),
    )
    .await
    .unwrap();
    let fork_id = forked["session"]["id"].as_str().unwrap();
    assert_eq!(forked["session"]["delegationModelApprovals"], approvals);
    let listed = handle_request(state.clone(), "session.list", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == id)
            .unwrap()["delegationModelApprovals"],
        approvals
    );
    {
        let app = state.lock().await;
        assert!(sessions::delete_session(&app.db, fork_id).unwrap());
        assert!(app
            .db
            .kv_get(crate::session_delegation::NAMESPACE, fork_id)
            .unwrap()
            .is_none());
    }
    let pruned = configure!(json!({"delegationModelKeys": ["account/model"]}));
    assert_eq!(
        pruned["session"]["delegationModelApprovals"],
        json!({"account/model": "auto"})
    );
    let cleared = configure!(json!({"delegationModelApprovals": null}));
    assert!(cleared["session"].get("delegationModelApprovals").is_none());
    assert_eq!(
        cleared["session"]["delegationModelKeys"],
        json!(["account/model"])
    );
    configure!(json!({"delegationModelApprovals": {"account/model": "ask"}}));
    let turn = handle_request(
        state.clone(),
        "session.beginTurn",
        json!({"sessionId": id}),
        tx.clone(),
    )
    .await
    .unwrap();
    let busy = handle_request(
        state.clone(),
        "session.configure",
        json!({"id": id, "mode": "agent", "delegationModelApprovals": {"account/model": "auto"}}),
        tx.clone(),
    )
    .await
    .unwrap_err();
    assert!(busy.message.contains("PLAN_CONFIGURATION_BLOCKED"));
    handle_request(
        state.clone(),
        "session.endTurn",
        json!({"turnId": turn["turnId"], "status": "completed", "createNotification": false}),
        tx.clone(),
    )
    .await
    .unwrap();
    let inherited = configure!(json!({"delegationModelKeys": null}));
    assert!(inherited["session"].get("delegationModelKeys").is_none());
    assert!(inherited["session"]
        .get("delegationModelApprovals")
        .is_none());
}
