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
async fn observer_rpc_busy_revocation_requires_exact_request_and_current_consent() {
    for observer_mode in ["endless", "guard"] {
        assert_busy_revocation_requires_exact_request(observer_mode).await;
    }
}

async fn assert_busy_revocation_requires_exact_request(observer_mode: &str) {
    let (_dir, state) = fixture();
    let created = call(
        &state,
        "session.create",
        json!({"observerMode":observer_mode}),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    state
        .lock()
        .await
        .db
        .conn()
        .execute(
            "INSERT INTO turns(id,session_id,status,started_at) VALUES ('live',?1,'running',0)",
            [id],
        )
        .unwrap();
    let revoke = json!({"id":id,"mode":"agent","observerMode":"off"});
    for (key, value) in [
        ("mode", json!("plan")),
        ("mode", json!("chat")),
        ("observerMode", json!("guard")),
        ("observerMode", json!("endless")),
        ("permissionMode", json!("auto")),
        ("providerId", Value::Null),
        ("modelId", json!("other")),
        ("thinkingLevel", json!("high")),
        ("fastMode", json!(false)),
        ("delegationModelKeys", Value::Null),
        ("delegationModelApprovals", Value::Null),
        ("modeSnapshot", Value::Null),
        ("futureSetting", json!(true)),
    ] {
        let mut patch = revoke.clone();
        patch[key] = value;
        let err = call(&state, "session.configure", patch).await.unwrap_err();
        assert_eq!(
            err.data.unwrap()["errorCode"],
            "PLAN_CONFIGURATION_BLOCKED",
            "{key}"
        );
    }
    let current = call(&state, "session.get", json!({"id":id})).await.unwrap();
    assert_eq!(current["session"]["observerMode"], observer_mode);
    // Non-observer patches keep their existing gates (fast mode may change while busy).
    call(
        &state,
        "session.configure",
        json!({"id":id,"mode":"agent","fastMode":true}),
    )
    .await
    .unwrap();
    let saved = call(&state, "session.configure", revoke.clone())
        .await
        .unwrap();
    assert_eq!(saved["session"]["observerMode"], "off");
    assert_eq!(saved["session"]["fastMode"], true);
    assert_eq!(
        call(&state, "session.configure", revoke)
            .await
            .unwrap_err()
            .data
            .unwrap()["errorCode"],
        "PLAN_CONFIGURATION_BLOCKED"
    );
    let current = call(&state, "session.get", json!({"id":id})).await.unwrap();
    assert_eq!(current["session"]["observerMode"], "off");
}

#[tokio::test]
async fn observer_rpc_busy_revocation_preserves_custom_snapshot_and_pending_plan() {
    let (dir, state) = fixture();
    let snapshot = json!({"version":1,"id":"review","permission":"contract",
        "stages":[{"id":"review","permission":"contract","exit":[{"kind":"ask"}]}]});
    let created = call(
        &state,
        "session.create",
        json!({"mode":"review","modeSnapshot":snapshot,"observerMode":"guard","projectPath":dir.path()}),
    )
    .await
    .unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    let started = call(
        &state,
        "modes.start",
        json!({"sessionId":id,"turnId":"turn","input":"review"}),
    )
    .await
    .unwrap();
    assert!(started["run"]["id"].is_string());
    state.lock().await.db.conn().execute("INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,plan_json,status,created_at,updated_at) VALUES ('pending',?1,'turn','call','{}','pending',1,1)", [id]).unwrap();
    let mut mixed = snapshot;
    mixed["permission"] = json!("agent");
    assert!(call(
        &state,
        "session.configure",
        json!({"id":id,"mode":"review","observerMode":"off","modeSnapshot":mixed})
    )
    .await
    .is_err());
    let saved = call(
        &state,
        "session.configure",
        json!({"id":id,"mode":"review","observerMode":"off"}),
    )
    .await
    .unwrap();
    assert_eq!(saved["session"]["observerMode"], "off");
    assert_eq!(saved["session"]["mode"], "review");
    let open = call(&state, "modes.get", json!({"sessionId":id}))
        .await
        .unwrap();
    for key in ["id", "revision", "state", "stageId"] {
        assert_eq!(open["run"][key], started["run"][key], "{key}");
    }
    let st = state.lock().await;
    assert_eq!(
        crate::mode_runs::tool_policy(&st.db, id).unwrap(),
        Some(crate::mode_runs::ToolPolicy::Contract)
    );
    assert_eq!(
        st.db
            .conn()
            .query_row("SELECT COUNT(*) FROM mode_snapshots", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        st.db
            .conn()
            .query_row(
                "SELECT status FROM plan_approvals WHERE session_id=?1",
                [id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "pending"
    );
}

#[tokio::test]
async fn observer_rpc_busy_revocation_is_limited_to_local_desktop_sessions() {
    let (_dir, state) = fixture();
    let created = call(&state, "session.create", json!({"observerMode":"guard"}))
        .await
        .unwrap();
    let id = created["session"]["id"].as_str().unwrap();
    {
        let st = state.lock().await;
        st.db
            .conn()
            .execute(
                "INSERT INTO turns(id,session_id,status,started_at) VALUES ('live',?1,'running',0)",
                [id],
            )
            .unwrap();
        st.db.conn().execute_batch("INSERT INTO projects(id,path,name,created_at,last_opened_at) VALUES(42,'remote-project:group','Remote',1,1);
            INSERT INTO scheduled_tasks(id,title,prompt,created_at,updated_at) VALUES ('task','Task','Prompt',1,1);").unwrap();
    }
    for (set, clear) in [
        ("UPDATE sessions SET source='native' WHERE id=?1", "UPDATE sessions SET source=NULL WHERE id=?1"),
        ("UPDATE sessions SET project_id=42 WHERE id=?1", "UPDATE sessions SET project_id=NULL WHERE id=?1"),
        ("INSERT INTO session_import_origins(plugin_id,source_id,external_id,session_id,created_at) VALUES('p','desktop','ext',?1,0)", "DELETE FROM session_import_origins WHERE session_id=?1"),
        ("INSERT INTO task_runs(id,task_id,session_id,started_at) VALUES('run','task',?1,1)", "DELETE FROM task_runs WHERE session_id=?1"),
        ("UPDATE sessions SET deleted_at=1 WHERE id=?1", "UPDATE sessions SET deleted_at=NULL WHERE id=?1"),
    ] {
        state.lock().await.db.conn().execute(set, [id]).unwrap();
        let err = call(&state,"session.configure",json!({"id":id,"mode":"agent","observerMode":"off"})).await.unwrap_err();
        assert_eq!(err.data.unwrap()["errorCode"], "PLAN_CONFIGURATION_BLOCKED");
        let st = state.lock().await;
        assert_eq!(st.db.conn().query_row("SELECT observer_mode FROM sessions WHERE id=?1",[id],|row|row.get::<_,String>(0)).unwrap(),"guard");
        st.db.conn().execute(clear, [id]).unwrap();
    }
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
