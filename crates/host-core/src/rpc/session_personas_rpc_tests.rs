use super::*;
use crate::rpc::handle_request;
use rusqlite::params;
use tokio::sync::mpsc;

fn open(path: &std::path::Path) -> Arc<Mutex<AppState>> {
    let mut app = AppState::open(path).unwrap();
    app.handshook = true;
    Arc::new(Mutex::new(app))
}

async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    args: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _rx) = mpsc::unbounded_channel();
    handle_request(state.clone(), method, args, tx).await
}

fn persona(prompt: &str) -> Value {
    json!({"id":"Helper_1", "name":"Helper 🦊", "prompt":prompt})
}

async fn set_catalog(state: &Arc<Mutex<AppState>>, definitions: Value) {
    call(state, "settings.set", json!({"personas": definitions}))
        .await
        .unwrap();
}

async fn configure_persona(state: &Arc<Mutex<AppState>>, args: Value) -> Value {
    call(state, "session.configurePersona", args).await.unwrap()["session"].clone()
}

async fn reject(state: &Arc<Mutex<AppState>>, method: &str, args: Value, reason: &str) {
    let error = call(state, method, args).await.unwrap_err();
    assert_eq!(
        error.data.unwrap()["errorCode"],
        reason,
        "{}",
        error.message
    );
}

#[tokio::test]
async fn persona_catalog_invalid_input_preserves_saved_data_and_omission_is_a_merge() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let original = json!([persona("Keep me")]);
    assert!(call(&state, "settings.get", json!({}))
        .await
        .unwrap()
        .get("personas")
        .is_none());
    set_catalog(&state, original.clone()).await;
    call(&state, "settings.set", json!({"language":"en"}))
        .await
        .unwrap();
    for value in [
        json!(null),
        json!({}),
        json!([["p", "Name", "Prompt"]]),
        json!([{"id":"p","name":"Name"}]),
        json!([{"id":"p","name":"Name","prompt":"Example","extra":true}]),
        json!([persona("Same ID"), persona("Duplicate ID")]),
    ] {
        reject(
            &state,
            "settings.set",
            json!({"personas":value,"language":"zh-CN"}),
            "INVALID_PARAMS",
        )
        .await;
    }
    reject(&state, "settings.set", json!([]), "INVALID_PARAMS").await;
    let saved = call(&state, "settings.get", json!({})).await.unwrap();
    assert_eq!(saved["personas"], original);
    assert_eq!(saved["language"], "en");
    set_catalog(&state, json!([])).await;
    assert_eq!(
        call(&state, "settings.get", json!({})).await.unwrap()["personas"],
        json!([])
    );
}

#[tokio::test]
async fn persona_snapshot_survives_reselect_toggle_fork_reopen_and_catalog_removal() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let original = persona("  Original prompt\n");
    set_catalog(&state, json!([original])).await;
    let created = call(&state,"session.create",json!({"title":"Persona lifecycle", "providerId":"provider", "modelId":"model", "mode":"plan", "thinkingLevel":"high", "personaId":"Helper_1"})).await.unwrap();
    let created = &created["session"];
    let id = created["id"].as_str().unwrap();
    let snapshot = &created["persona"];
    assert_eq!(snapshot["version"], 1);
    assert_eq!(snapshot["definition"], original);
    assert_eq!(snapshot["inheritToSubagents"], false);
    let changed = persona("Updated template");
    set_catalog(&state, json!([changed])).await;
    let enabled = configure_persona(&state, json!({"id":id,"inheritToSubagents":true})).await;
    let mut expected = snapshot.clone();
    expected["inheritToSubagents"] = true.into();
    assert_eq!(enabled["persona"], expected);
    for field in [
        "mode",
        "permissionMode",
        "modelId",
        "providerId",
        "thinkingLevel",
        "updatedAt",
    ] {
        assert_eq!(enabled[field], created[field], "{field}");
    }
    let fork = call(&state, "session.fork", json!({"sessionId":id}))
        .await
        .unwrap();
    let fork_id = fork["session"]["id"].as_str().unwrap();
    assert_eq!(fork["session"]["persona"], expected);
    let updated = configure_persona(&state, json!({"id":id,"personaId":"Helper_1"})).await;
    assert_eq!(updated["persona"]["definition"], changed);
    assert!(updated["persona"]["inheritToSubagents"].as_bool().unwrap());
    assert_ne!(updated["persona"]["revision"], expected["revision"]);
    set_catalog(&state, json!([])).await;
    reject(
        &state,
        "session.configurePersona",
        json!({"id":id,"personaId":"Helper_1"}),
        "INVALID_PARAMS",
    )
    .await;
    drop(state);
    let state = open(dir.path());
    let sessions = call(&state, "session.list", json!({})).await.unwrap();
    for (session_id, persona) in [(id, &updated["persona"]), (fork_id, &expected)] {
        let summary = sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|summary| summary["id"] == session_id)
            .unwrap();
        assert_eq!(&summary["persona"], persona);
        let detail = call(&state, "session.get", json!({"id":session_id}))
            .await
            .unwrap();
        assert_eq!(&detail["session"]["persona"], persona);
    }
    let disabled =
        configure_persona(&state, json!({"id":fork_id,"inheritToSubagents":false})).await;
    expected["inheritToSubagents"] = false.into();
    assert_eq!(disabled["persona"], expected);
    let cleared = configure_persona(&state, json!({"id":id,"personaId":null})).await;
    assert!(cleared.get("persona").is_none());
    reject(
        &state,
        "session.configurePersona",
        json!({"id":id,"inheritToSubagents":true}),
        "INVALID_PARAMS",
    )
    .await;
    let st = state.lock().await;
    let search = crate::session_search::search(&st.db, "Persona lifecycle", 0, 10).unwrap();
    assert_eq!(search.hits.len(), 2);
    assert!(search
        .hits
        .iter()
        .find(|hit| hit.session.id == fork_id)
        .unwrap()
        .session
        .persona
        .is_some());
    assert!(session_trash::trash(&st.db, fork_id).unwrap());
    let trashed = session_trash::list(&st.db).unwrap();
    assert_eq!(
        serde_json::to_value(&trashed[0]).unwrap()["persona"],
        expected
    );
    assert!(session_trash::purge(&st.db, fork_id).unwrap());
    assert!(session_personas::read(&st.db, fork_id).unwrap().is_none());
}

#[tokio::test]
async fn persona_creation_rolls_back_and_unowned_or_invalid_payloads_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    set_catalog(&state, json!([persona("Example")])).await;
    for args in [
        json!({"personaId":"missing"}),
        json!({"personaId":false}),
        json!({"personaId":"Helper_1","inheritToSubagents":null}),
        json!({"personaId":null,"inheritToSubagents":true}),
        json!({"inheritToSubagents":true}),
    ] {
        reject(&state, "session.create", args, "INVALID_PARAMS").await;
    }
    reject(
        &state,
        "session.create",
        json!({"personaId":"Helper_1","projectPath":"remote-project:bad"}),
        "PERMISSION_DENIED",
    )
    .await;
    let execute = |st: &AppState, sql: &str| {
        st.db.conn().execute_batch(sql).unwrap();
    };
    execute(&*state.lock().await,"CREATE TRIGGER reject_persona BEFORE INSERT ON session_personas BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    let project = dir.path().to_string_lossy();
    assert!(call(
        &state,
        "session.create",
        json!({"personaId":"Helper_1", "projectPath":project})
    )
    .await
    .is_err());
    {
        let st = state.lock().await;
        assert!(sessions::list_sessions(&st.db).unwrap().is_empty());
        assert!(st.db.list_projects().unwrap().is_empty());
        execute(&st, "DROP TRIGGER reject_persona;");
    }
    let created = call(&state, "session.create", json!({})).await.unwrap();
    assert!(created["session"].get("persona").is_none());
    let opted_in = call(
        &state,
        "session.create",
        json!({"personaId":"Helper_1","inheritToSubagents":true}),
    )
    .await
    .unwrap();
    assert_eq!(opted_in["session"]["persona"]["inheritToSubagents"], true);
    let id = created["session"]["id"].as_str().unwrap();
    for args in [
        json!({"id":id}),
        json!({"id":format!(" {id}"),"personaId":null}),
        json!({"id":id,"inheritToSubagents":1}),
        json!({"id":id,"personaId":null,"mode":"goal"}),
    ] {
        reject(&state, "session.configurePersona", args, "INVALID_PARAMS").await;
    }
    for foreign_id in ["remote:peer:session", "native-pi:session"] {
        reject(
            &state,
            "session.configurePersona",
            json!({"id":foreign_id,"personaId":"Helper_1"}),
            "PERMISSION_DENIED",
        )
        .await;
    }
    {
        let st = state.lock().await;
        st.db
            .conn()
            .execute("UPDATE sessions SET source='native' WHERE id=?1", [id])
            .unwrap();
    }
    reject(
        &state,
        "session.configurePersona",
        json!({"id":id,"personaId":"Helper_1"}),
        "PERMISSION_DENIED",
    )
    .await;
    let st = state.lock().await;
    assert!(session_personas::read(&st.db, id).unwrap().is_none());
}

#[tokio::test]
async fn persona_configuration_fails_closed_on_each_host_work_gate_without_mutating() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    set_catalog(&state, json!([persona("Example")])).await;
    let created = call(&state, "session.create", json!({"personaId":"Helper_1"}))
        .await
        .unwrap();
    let summary = &created["session"];
    let id = summary["id"].as_str().unwrap();
    for (insert, clear) in [
        ("INSERT INTO turns(id,session_id,status,started_at) VALUES ('live',?1,'running',1)","DELETE FROM turns WHERE session_id=?1"),
        ("INSERT INTO turn_queue(id,session_id,principal,input_hash,content,permission_mode,position,created_at) VALUES ('q',?1,'user','hash','queued','ask',0,0)","DELETE FROM turn_queue WHERE session_id=?1"),
        ("INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,plan_json,status,created_at,updated_at,expires_at) VALUES ('approval',?1,'turn','call','{}','pending',1,1,2)","DELETE FROM plan_approvals WHERE session_id=?1 AND status='pending' AND version=1"),
        ("INSERT INTO mode_runs(id,session_id,mode_id,snapshot_hash,input,stage_id,state,artifact_paths,created_at,updated_at) VALUES ('run',?1,'goal','snapshot','goal','work','paused','{}',1,1)","DELETE FROM mode_runs WHERE session_id=?1 AND state='paused' AND revision=1"),
        ("INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at) VALUES ('child',?1,'fixture',1)","DELETE FROM session_collaboration_links WHERE created_by_session_id=?1"),
    ] {
        {
            let st = state.lock().await;
            st.db.conn().execute_batch("INSERT OR IGNORE INTO mode_snapshots VALUES ('snapshot','{}','fixture'); INSERT OR IGNORE INTO sessions(id,created_at,updated_at) VALUES ('child',1,1); INSERT OR IGNORE INTO turns(id,session_id,status,started_at) VALUES ('child-turn','child','running',1);").unwrap();
            st.db.conn().execute(insert, params![id]).unwrap();
        }
        reject(&state,"session.configurePersona",json!({"id":id,"personaId":null}),"AGENT_BUSY").await;
        let st = state.lock().await;
        assert_eq!(serde_json::to_value(sessions::session_summary(&st.db,id).unwrap().unwrap()).unwrap(), *summary);
        assert_eq!(st.db.conn().execute(clear,params![id]).unwrap(), 1);
    }
    state
        .lock()
        .await
        .register_pending_permission("request", id, "call");
    reject(
        &state,
        "session.configurePersona",
        json!({"id":id,"inheritToSubagents":true}),
        "AGENT_BUSY",
    )
    .await;
    assert!(state.lock().await.has_pending_permission(id));
    state.lock().await.clear_pending_permission("request");
    assert_eq!(
        configure_persona(&state, json!({"id":id,"inheritToSubagents":true})).await["persona"]
            ["inheritToSubagents"],
        true
    );
}

#[tokio::test]
async fn persona_creation_rejects_explicit_and_default_extension_agent_without_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let provider = "extension-agent:fixture%2Fagent";
    set_catalog(&state, json!([persona("Example")])).await;
    let project = dir.path().to_string_lossy();
    reject(
        &state,
        "session.create",
        json!({"personaId":"Helper_1","providerId":provider,"projectPath":project}),
        "INVALID_ARGUMENT",
    )
    .await;
    call(
        &state,
        "settings.set",
        json!({"defaultProviderId":provider}),
    )
    .await
    .unwrap();
    reject(
        &state,
        "session.create",
        json!({"personaId":"Helper_1","projectPath":project}),
        "INVALID_ARGUMENT",
    )
    .await;
    {
        let st = state.lock().await;
        assert!(sessions::list_sessions(&st.db).unwrap().is_empty());
        assert!(st.db.list_projects().unwrap().is_empty());
    }
    for args in [json!({"providerId":provider}), json!({"personaId":null})] {
        let created = call(&state, "session.create", args).await.unwrap();
        assert!(created["session"].get("persona").is_none());
    }
    let created = call(
        &state,
        "session.create",
        json!({"providerId":"normal-provider","personaId":"Helper_1"}),
    )
    .await
    .unwrap();
    assert_eq!(
        created["session"]["persona"]["definition"]["id"],
        "Helper_1"
    );
}

#[tokio::test]
async fn persona_configuration_rejects_extension_agent_but_allows_clearing_retained_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let state = open(dir.path());
    let provider = "extension-agent:fixture%2Fagent";
    set_catalog(&state, json!([persona("Example")])).await;
    let mut retained = Vec::new();
    for _ in 0..2 {
        let created = call(&state, "session.create", json!({"personaId":"Helper_1"}))
            .await
            .unwrap();
        retained.push(created["session"].clone());
    }
    let explicit = retained[0]["id"].as_str().unwrap();
    call(
        &state,
        "session.configure",
        json!({"id":explicit,"mode":"agent","providerId":provider}),
    )
    .await
    .unwrap();
    for (index, old) in retained.into_iter().enumerate() {
        if index == 1 {
            call(
                &state,
                "settings.set",
                json!({"defaultProviderId":provider}),
            )
            .await
            .unwrap();
        }
        let id = old["id"].as_str().unwrap();
        for args in [
            json!({"id":id,"personaId":"Helper_1"}),
            json!({"id":id,"inheritToSubagents":true}),
        ] {
            reject(&state, "session.configurePersona", args, "INVALID_ARGUMENT").await;
        }
        let current = call(&state, "session.get", json!({"id":id})).await.unwrap();
        assert_eq!(current["session"]["persona"], old["persona"]);
        let cleared = configure_persona(&state, json!({"id":id,"personaId":null})).await;
        assert!(cleared.get("persona").is_none());
        assert_eq!(cleared["providerId"], current["session"]["providerId"]);
        reject(
            &state,
            "session.configurePersona",
            json!({"id":id,"personaId":"Helper_1"}),
            "INVALID_ARGUMENT",
        )
        .await;
        let st = state.lock().await;
        assert!(session_personas::read(&st.db, id).unwrap().is_none());
    }
    let ordinary = call(
        &state,
        "session.create",
        json!({"providerId":"normal-provider"}),
    )
    .await
    .unwrap();
    let updated = configure_persona(
        &state,
        json!({"id":ordinary["session"]["id"],"personaId":"Helper_1"}),
    )
    .await;
    assert_eq!(updated["persona"]["definition"]["id"], "Helper_1");
}
