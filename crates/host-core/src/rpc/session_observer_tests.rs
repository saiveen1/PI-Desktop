use super::*;

type State = Arc<Mutex<AppState>>;

fn fixture() -> (tempfile::TempDir, State) {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    (dir, Arc::new(Mutex::new(app)))
}

async fn call(state: &State, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

#[tokio::test]
async fn observer_rpc_create_configure_and_omission_preserve_independent_session_settings() {
    let (dir, state) = fixture();
    let parent =
        {
            let app = state.lock().await;
            app.db.set_setting("app", &json!({
            "defaultProviderId": "global-provider", "defaultModelId": "global-model",
            "observerModelKey": "global-provider/observer", "observerThinkingLevel": "high"
        })).unwrap();
            sessions::create_session_with_options(
                &app.db,
                sessions::SessionCreateOptions {
                    permission_mode: Some("auto".into()),
                    observer_mode: sessions::ObserverMode::Guard,
                    ..Default::default()
                },
            )
            .unwrap()
        };
    let default = call(
        &state,
        "session.create",
        json!({
            "mode": "plan", "inheritPermissionFromSessionId": parent.id
        }),
    )
    .await
    .unwrap();
    assert_eq!(default["session"]["observerMode"], "off");
    assert_eq!(default["session"]["permissionMode"], "auto");
    assert_eq!(default["session"]["providerId"], Value::Null);
    assert_eq!(default["session"]["modelId"], Value::Null);

    for observer in ["off", "endless", "guard"] {
        let created = call(
            &state,
            "session.create",
            json!({
                "mode": "plan", "observerMode": observer,
                "providerId": "provider", "modelId": "model", "thinkingLevel": "high",
                "fastMode": true
            }),
        )
        .await
        .unwrap();
        let id = created["session"]["id"].as_str().unwrap();
        assert_eq!(created["session"]["observerMode"], observer);
        let saved_mode = if observer == "guard" {
            "guard"
        } else {
            "endless"
        };
        for mode in ["endless", "guard", "off", saved_mode] {
            let configured = call(
                &state,
                "session.configure",
                json!({
                    "id": id, "mode": "plan", "observerMode": mode
                }),
            )
            .await
            .unwrap();
            let summary = &configured["session"];
            assert_eq!(summary["observerMode"], mode);
            assert_eq!(summary["mode"], "plan");
            assert_eq!(summary["permissionMode"], "inherit");
            assert_eq!(summary["thinkingLevel"], "high");
            assert_eq!(summary["fastMode"], true);
            assert_eq!(summary["providerId"], "provider");
            assert_eq!(summary["modelId"], "model");
        }
        let configured = call(
            &state,
            "session.configure",
            json!({
                "id": id, "mode": "agent", "providerId": "other", "modelId": "other-model"
            }),
        )
        .await
        .unwrap();
        assert_eq!(configured["session"]["observerMode"], saved_mode);
        assert_eq!(configured["session"]["mode"], "agent");
        assert_eq!(configured["session"]["permissionMode"], "inherit");
        let reopened = crate::db::Database::open_in_dir(dir.path()).unwrap();
        assert_eq!(
            serde_json::to_value(
                sessions::session_summary(&reopened, id)
                    .unwrap()
                    .unwrap()
                    .observer_mode
            )
            .unwrap(),
            saved_mode
        );
    }
    let app = state.lock().await;
    for table in ["turns", "messages", "plan_approvals", "mode_runs"] {
        let count: i64 = app
            .db
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "configuration must not start execution");
    }
    assert_eq!(
        sessions::session_summary(&app.db, &parent.id)
            .unwrap()
            .unwrap()
            .observer_mode,
        sessions::ObserverMode::Guard
    );
}

#[tokio::test]
async fn observer_rpc_rejects_explicit_invalid_values_without_partial_writes() {
    let (_dir, state) = fixture();
    let created = call(
        &state,
        "session.create",
        json!({ "observerMode": "endless" }),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    for invalid in [
        json!(null),
        json!(true),
        json!(false),
        json!([]),
        json!(["guard"]),
        json!({"mode":"guard"}),
        json!({"guard":null}),
        json!(0),
        json!(""),
        json!("auto"),
        json!("observe"),
        json!("Guard"),
        json!(" guard "),
    ] {
        for method in ["session.create", "session.configure"] {
            let error = call(&state, method, json!({
                "id": id, "mode": "agent", "providerId": "must-not-change", "observerMode": invalid
            })).await.unwrap_err();
            assert_eq!(error.code, 1002);
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        }
        let saved = call(&state, "session.get", json!({ "id": id }))
            .await
            .unwrap();
        assert_eq!(saved["session"]["observerMode"], "endless");
        assert_eq!(saved["session"]["providerId"], Value::Null);
    }
    assert_eq!(
        sessions::list_sessions(&state.lock().await.db)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn observer_rpc_preserves_handshake_existence_and_idle_authority() {
    let (_dir, state) = fixture();
    state.lock().await.handshook = false;
    let error = call(&state, "session.create", json!({ "observerMode": "guard" }))
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "UNAUTHORIZED");
    state.lock().await.handshook = true;
    for id in ["missing", "native:synthetic", "remote:synthetic"] {
        let error = call(
            &state,
            "session.configure",
            json!({
                "id": id, "mode": "agent", "observerMode": "guard"
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "NOT_FOUND");
    }
    let created = call(&state, "session.create", json!({})).await.unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    state
        .lock()
        .await
        .db
        .conn()
        .execute(
            "INSERT INTO turns(id,session_id,status,started_at) VALUES('running',?1,'running',1)",
            [id],
        )
        .unwrap();
    let error = call(
        &state,
        "session.configure",
        json!({
            "id": id, "mode": "agent", "observerMode": "guard"
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.data.unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );
    assert_eq!(
        sessions::session_summary(&state.lock().await.db, id)
            .unwrap()
            .unwrap()
            .observer_mode,
        sessions::ObserverMode::Off
    );
}

#[tokio::test]
async fn observer_rpc_settings_roundtrip_validate_and_reset_prompt() {
    let (dir, state) = fixture();
    let saved = json!({"maxContinuations":100,"continueOnTransientError":true,"prompt":"🧪".repeat(4000),"modelId":"guard-model"});
    let mut incoming = saved.clone();
    incoming["includeToolOutput"] = json!(true);
    incoming["recentToolCount"] = json!(8);
    call(&state, "settings.set", json!({"observerGuard": incoming}))
        .await
        .unwrap();
    for invalid in [
        json!(null),
        json!({"maxContinuations":0}),
        json!({"maxContinuations":101}),
        json!({"maxContinuations":1.5}),
        json!({"maxContinuations":"3"}),
        json!({"continueOnTransientError":null}),
        json!({"continueOnTransientError":"true"}),
        json!({"continueOnTransientError":1}),
        json!({"prompt":4}),
        json!({"prompt":"bad\0text"}),
        json!({"prompt":"🧪".repeat(4001)}),
    ] {
        let error = call(&state, "settings.set", json!({"observerGuard":invalid}))
            .await
            .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        call(&state, "settings.get", json!({})).await.unwrap()["observerGuard"],
        saved
    );
    call(
        &state,
        "settings.set",
        json!({"observerGuard":{"maxContinuations":1,"continueOnTransientError":false,"prompt":""}}),
    )
    .await
    .unwrap();
    assert_eq!(
        call(&state, "settings.get", json!({})).await.unwrap()["observerGuard"],
        json!({"maxContinuations":1,"continueOnTransientError":false})
    );
}
