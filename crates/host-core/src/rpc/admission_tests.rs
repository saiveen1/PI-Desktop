use super::*;
use std::collections::HashMap;

fn request(id: &str, method: &str, params: Value) -> JsonRpcRequest {
    serde_json::from_value(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
        .unwrap()
}

async fn message(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
    let raw = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn dispatcher_can_deny_and_abort_when_all_ordinary_slots_wait_for_approval() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let session = sessions::create_session(
        &st.db,
        Some("admission".into()),
        Some("agent".into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &st.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(st));
    let slots = RequestSlots::new();
    let mut tasks = tokio::task::JoinSet::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut approvals = Vec::new();
    for index in 0..MAX_IN_FLIGHT_RPC {
        let id = format!("write-{index}");
        dispatch_request(
            &slots,
            &mut tasks,
            state.clone(),
            tx.clone(),
            request(
                &id,
                "tools.execute",
                json!({
                    "sessionId":session.id, "toolCallId":id, "toolName":"Write", "mode":"agent",
                    "args":{"path":dir.path().join(format!("refused-{index}.txt")), "content":"never"}
                }),
            ),
        );
        let notification = message(&mut rx).await;
        assert_eq!(notification["method"], "permissions.request");
        approvals.push(notification["params"]["requestId"].clone());
    }
    assert_eq!(slots.ordinary.available_permits(), 0);
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("overflow", "app.health", json!({})),
    );
    let rejected = message(&mut rx).await;
    assert_eq!(rejected["error"]["data"]["errorCode"], "HOST_OVERLOADED");
    assert_eq!(rejected["error"]["data"]["reason"], "rpc_capacity");

    // Validation must still run inside the reserved lane.
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("invalid", "permissions.resolve", json!({})),
    );
    assert_eq!(
        message(&mut rx).await["error"]["data"]["errorCode"],
        "INVALID_PARAMS"
    );
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request(
            "deny",
            "permissions.resolve",
            json!({
                "requestId":approvals[0], "decision":"deny"
            }),
        ),
    );
    let mut replies = HashMap::new();
    for _ in 0..2 {
        let reply = message(&mut rx).await;
        replies.insert(reply["id"].as_str().unwrap().to_string(), reply);
    }
    assert_eq!(replies["deny"]["result"]["ok"], true);
    assert_eq!(replies["write-0"]["result"]["errorCode"], "TOOL_DENIED");

    for index in 1..MAX_IN_FLIGHT_RPC {
        let id = format!("abort-{index}");
        dispatch_request(
            &slots,
            &mut tasks,
            state.clone(),
            tx.clone(),
            request(
                &id,
                "tools.abort",
                json!({
                    "sessionId":session.id, "toolCallId":format!("write-{index}"), "toolName":"Write"
                }),
            ),
        );
        for _ in 0..2 {
            let reply = message(&mut rx).await;
            if reply["id"] == id {
                assert_eq!(reply["result"]["aborted"], true);
            } else {
                assert_eq!(reply["result"]["errorCode"], "TOOL_ABORTED");
            }
        }
    }
    while let Some(done) = tasks.join_next().await {
        done.unwrap();
    }
    assert_eq!(slots.ordinary.available_permits(), MAX_IN_FLIGHT_RPC);
    assert_eq!(slots.control.available_permits(), MAX_IN_FLIGHT_CONTROL_RPC);
    assert!(state
        .lock()
        .await
        .permissions
        .pending_requests(None)
        .is_empty());
    for index in 0..MAX_IN_FLIGHT_RPC {
        assert!(!dir.path().join(format!("refused-{index}.txt")).exists());
    }
}

#[tokio::test]
async fn dispatcher_control_reserve_is_bounded_and_cancellation_returns_both_lanes() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let state = Arc::new(Mutex::new(st));
    let held_state = state.lock().await;
    let slots = RequestSlots::new();
    let mut tasks = tokio::task::JoinSet::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    for index in 0..MAX_IN_FLIGHT_RPC {
        dispatch_request(
            &slots,
            &mut tasks,
            state.clone(),
            tx.clone(),
            request(&format!("query-{index}"), "app.health", json!({})),
        );
    }
    for index in 0..MAX_IN_FLIGHT_CONTROL_RPC {
        dispatch_request(
            &slots,
            &mut tasks,
            state.clone(),
            tx.clone(),
            request(
                &format!("control-{index}"),
                "permissions.resolve",
                json!({"requestId":"missing"}),
            ),
        );
    }
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("control-overflow", "tools.abort", json!({})),
    );
    assert_eq!(
        message(&mut rx).await["error"]["data"]["reason"],
        "rpc_control_capacity"
    );
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("unknown", "permissions.resolveAnything", json!({})),
    );
    assert_eq!(
        message(&mut rx).await["error"]["data"]["reason"],
        "rpc_capacity"
    );
    assert_eq!(tasks.len(), MAX_IN_FLIGHT_RPC + MAX_IN_FLIGHT_CONTROL_RPC);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    assert_eq!(slots.ordinary.available_permits(), MAX_IN_FLIGHT_RPC);
    assert_eq!(slots.control.available_permits(), MAX_IN_FLIGHT_CONTROL_RPC);
    drop(held_state);
}

#[test]
fn only_existing_work_completions_and_cancellations_get_the_control_reserve() {
    let slots = RequestSlots::new();
    let ordinary: Vec<_> = (0..MAX_IN_FLIGHT_RPC)
        .map(|_| slots.acquire("tools.execute").unwrap())
        .collect();
    for method in [
        "permissions.resolve",
        "tools.abort",
        "tools.workspaceAbort",
        "tools.remoteComplete",
        "plugins.resolveExecution",
        "tools.fileBatchSeal",
        "tools.fileBatchClose",
        "tools.fileBatchAbandon",
        "backgroundTasks.stop",
        "backgroundJobs.stop",
        "plans.abort",
        "plans.finishExecution",
        "market.cancelInstall",
    ] {
        drop(slots.acquire(method).unwrap());
    }
    for method in [
        "tools.workspaceExecute",
        "permissions.pending",
        "backgroundJobs.wait",
        "tools.fileBatchRegister",
        "plugins.execute",
        "plans.resolve",
    ] {
        assert!(
            slots.acquire(method).is_err(),
            "{method} must not use the reserve"
        );
    }
    drop(ordinary);
}

#[tokio::test]
async fn approval_is_indefinite_but_accepted_bash_still_gets_its_full_execution_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let shell = command_shell_catalog(&st)
        .unwrap()
        .effective
        .expect("test shell available");
    let command = if shell.dialect.as_str() == "powershell" {
        "[System.Threading.ManualResetEvent]::new($false).WaitOne() | Out-Null"
    } else {
        "exec tail -f /dev/null"
    };
    let session = sessions::create_session(
        &st.db,
        Some("approval timeout".into()),
        Some("agent".into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &st.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("ask"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(st));
    let slots = RequestSlots::new();
    let mut tasks = tokio::task::JoinSet::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = json!({
        "sessionId":session.id, "toolCallId":"budget-bash", "toolName":"Bash", "mode":"agent",
        "timeoutMs":1000, "args":{"command":command},
        "expectedCommandShellId":shell.id, "expectedCommandShellDialect":shell.dialect.as_str()
    });
    // None is the no-timer contract: no finite approval duration is substituted
    // here. Synchronize on permission and response messages, never a test sleep.
    assert_eq!(request_budget_ms("tools.execute", &params), None);
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("bash", "tools.execute", params),
    );
    let approval = message(&mut rx).await;
    assert_eq!(approval["method"], "permissions.request");
    assert_eq!(state.lock().await.tool_budget.snapshot().shell, 0);
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request("health", "app.health", json!({})),
    );
    assert_eq!(message(&mut rx).await["id"], "health");
    dispatch_request(
        &slots,
        &mut tasks,
        state.clone(),
        tx.clone(),
        request(
            "allow",
            "permissions.resolve",
            json!({
                "requestId":approval["params"]["requestId"], "decision":"allow-once"
            }),
        ),
    );
    let result = loop {
        let reply = message(&mut rx).await;
        if reply["id"] == "bash" {
            break reply["result"].clone();
        }
    };
    assert_eq!(result["errorCode"], "TOOL_TIMEOUT", "{result}");
    assert!(
        result["durationMs"].as_u64().unwrap() >= 1000,
        "approval must not shorten execution: {result}"
    );
    assert!(result["content"].to_string().contains("1000ms"));
    while let Some(done) = tasks.join_next().await {
        done.unwrap();
    }
    assert_eq!(state.lock().await.tool_budget.snapshot().shell, 0);
}

#[tokio::test]
async fn bash_yield_requires_opt_in_without_an_explicit_timeout_and_does_not_replay() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let shell = command_shell_catalog(&st).unwrap().effective.unwrap();
    let session = sessions::create_session(
        &st.db,
        None,
        Some("agent".into()),
        None,
        None,
        Some(dir.path().to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &st.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(st));
    let params = |id: &str| {
        let command = if shell.dialect.as_str() == "powershell" {
            format!("[IO.File]::AppendAllText((Join-Path (Get-Location) '{id}.txt'), 'x'); [Console]::WriteLine('started'); [System.Threading.ManualResetEvent]::new($false).WaitOne() | Out-Null")
        } else {
            format!("printf x >> {id}.txt; printf 'started\\n'; exec tail -f /dev/null")
        };
        json!({
            "sessionId":session.id, "turnId":"turn", "toolCallId":id, "toolName":"Bash",
            "mode":"agent", "args":{"command":command}, "expectedCommandShellId":shell.id,
            "expectedCommandShellDialect":shell.dialect.as_str(), "yieldAfterInitialWait":true
        })
    };
    let mut explicit_params = params("explicit");
    explicit_params["timeoutMs"] = json!(60_000);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut explicit = tokio::spawn(handle_request(
        state.clone(),
        "tools.execute",
        explicit_params,
        tx,
    ));
    // Start the explicit case first so its handoff deadline, if enabled, would
    // pass before the implicit case hands off. No timing-only grace interval.
    loop {
        let event = tokio::select! {
            result = &mut explicit => panic!("explicit Bash settled before start: {result:?}"),
            event = message(&mut rx) => event,
        };
        if event["method"] == "tools.output"
            && event["params"]["chunk"]
                .as_str()
                .is_some_and(|chunk| chunk.contains("started"))
        {
            break;
        }
    }
    let yielded = tokio::time::timeout(
        Duration::from_secs(20),
        handle_request(
            state.clone(),
            "tools.execute",
            params("yield"),
            mpsc::unbounded_channel().0,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(yielded["content"]["state"], "running", "{yielded}");
    assert!(yielded["content"].get("exitCode").is_none());
    assert_eq!(state.lock().await.background_tasks.running_count(), 1);
    let aborted = handle_request(
        state.clone(),
        "tools.abort",
        json!({"sessionId":session.id, "toolCallId":"explicit", "toolName":"Bash"}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(
        aborted["found"], true,
        "explicit Bash should still be foreground"
    );
    let explicit = tokio::time::timeout(Duration::from_secs(5), explicit)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(explicit["errorCode"], "TOOL_ABORTED", "{explicit}");
    let stopped = handle_request(
        state.clone(),
        "backgroundJobs.stop",
        json!({"sessionId":session.id, "id":yielded["content"]["job"]["id"], "timeoutMs":1000}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(stopped["state"], "stopped", "{stopped}");
    for id in ["explicit", "yield"] {
        assert_eq!(
            std::fs::read(dir.path().join(format!("{id}.txt"))).unwrap(),
            b"x"
        );
    }
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}
