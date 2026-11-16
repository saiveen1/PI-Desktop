//! Terminal telemetry stays safe, exactly-once, and outside lifecycle locks.

use super::*;
use serde_json::json;
use tokio::sync::mpsc;

async fn install_recorder(
    state: &Arc<Mutex<crate::state::AppState>>,
) -> (
    Arc<BackgroundTaskSettledCallback>,
    mpsc::UnboundedReceiver<BackgroundTaskSettled>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let weak_state = Arc::downgrade(state);
    let callback: Arc<BackgroundTaskSettledCallback> = Arc::new(move |summary| {
        let state = weak_state.upgrade().unwrap();
        let st = state.try_lock().expect("settlement must not hold AppState");
        let task = &st.background_tasks.tasks[&summary.task_id];
        let shared = task
            .shared
            .try_lock()
            .expect("settlement must release the task lock before notifying");
        assert_ne!(shared.state, BackgroundTaskState::Running);
        assert_eq!(summary.state, shared.state);
        assert_eq!(summary.exit_code, shared.exit_code);
        assert_eq!(summary.truncated, shared.truncated);
        assert!(task.settled.borrow().is_some());
        assert_eq!(summary.duration_ms, task.elapsed_ms());
        tx.send(summary).unwrap();
    });
    state
        .lock()
        .await
        .background_tasks
        .set_on_settled(Arc::downgrade(&callback));
    (callback, rx)
}

async fn next_event(
    events: &mut mpsc::UnboundedReceiver<BackgroundTaskSettled>,
) -> BackgroundTaskSettled {
    tokio::time::timeout(Duration::from_secs(10), events.recv())
        .await
        .expect("the supervisor must settle")
        .expect("the observer must remain alive")
}

fn assert_safe_payload(summary: &BackgroundTaskSettled) {
    assert_eq!(
        serde_json::to_value(summary).unwrap(),
        json!({
            "taskId": summary.task_id,
            "sessionId": summary.session_id,
            "commandShellId": summary.command_shell_id,
            "state": summary.state,
            "exitCode": summary.exit_code,
            "durationMs": summary.duration_ms,
            "truncated": summary.truncated,
        }),
        "terminal telemetry must contain only the seven safe fields"
    );
}

#[tokio::test]
async fn exit_events_are_once_safe_and_match_final_drained_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(
        crate::state::AppState::open(dir.path()).unwrap(),
    ));
    let session_id = tests::new_session(&*state.lock().await);
    let shell = tools::shell::default_shell_id();
    let (callback, mut events) = install_recorder(&state).await;

    for (exit_code, expected_state) in [
        (0, BackgroundTaskState::Exited),
        (7, BackgroundTaskState::Failed),
    ] {
        let command = if cfg!(windows) {
            format!(
                "[Console]::Out.Write(('x' * 300000) + 'private-stdout'); \
                 [Console]::Error.Write('private-stderr'); exit {exit_code}"
            )
        } else {
            format!(
                "printf '%0300000d' 0; printf private-stdout; \
                 printf private-stderr >&2; exit {exit_code}"
            )
        };
        let id =
            spawn_background_task_detached(&state, &session_id, &command, shell, dir.path(), None)
                .await
                .unwrap();
        let summary = next_event(&mut events).await;
        assert_eq!(summary.task_id, id);
        assert_eq!(summary.session_id, session_id);
        assert_eq!(summary.command_shell_id, shell);
        assert_eq!(summary.state, expected_state);
        assert_eq!(summary.exit_code, Some(exit_code));
        assert!(summary.truncated);
        assert_safe_payload(&summary);

        let st = state.lock().await;
        let output = task_output(&st.background_tasks, &id)
            .await
            .unwrap()
            .unwrap();
        assert!(output["stdout"]
            .as_str()
            .unwrap()
            .ends_with("private-stdout"));
        assert_eq!(output["stderr"], "private-stderr");
        assert_eq!(output["truncated"], true);
        assert_eq!(output["state"], json!(expected_state));
        assert_eq!(st.background_tasks.running_count(), 0);
        assert_eq!(
            st.background_tasks.summaries().len(),
            if exit_code == 0 { 1 } else { 2 }
        );
        assert!(!stop_task(&st.background_tasks, &id).await.unwrap());
        let task = &st.background_tasks.tasks[&id];
        jobs::wait(task, 1000).await;
        assert_eq!(
            jobs::snapshot(task, false).await["elapsedMs"],
            summary.duration_ms
        );
        assert_eq!(
            task_output(&st.background_tasks, &id)
                .await
                .unwrap()
                .unwrap(),
            output
        );
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    state.lock().await.shutdown();
    assert!(matches!(
        events.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    assert_eq!(Arc::strong_count(&callback), 1);
}

#[tokio::test]
async fn requested_stop_and_shutdown_emit_once_without_stopping_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(
        crate::state::AppState::open(dir.path()).unwrap(),
    ));
    let (session_a, session_b) = {
        let st = state.lock().await;
        (tests::new_session(&st), tests::new_session(&st))
    };
    let (callback, mut events) = install_recorder(&state).await;
    let shell = tools::shell::default_shell_id();
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    };
    let mut ids = Vec::new();
    for session in [&session_a, &session_b] {
        ids.push(
            spawn_background_task_detached(&state, session, command, shell, dir.path(), None)
                .await
                .unwrap(),
        );
    }
    {
        let st = state.lock().await;
        assert_eq!(st.background_tasks.running_count(), 2);
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert!(stop_task(&st.background_tasks, &ids[0]).await.unwrap());
        assert!(!stop_task(&st.background_tasks, &ids[0]).await.unwrap());
        // Signalling stop is not settlement and must not publish an event.
        assert_eq!(
            st.background_tasks.summaries()[0].state,
            BackgroundTaskState::Running
        );
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    let stopped = next_event(&mut events).await;
    assert_eq!(stopped.task_id, ids[0]);
    assert_eq!(stopped.session_id, session_a);
    assert_eq!(stopped.command_shell_id, shell);
    assert_eq!(stopped.state, BackgroundTaskState::Stopped);
    assert!(!stopped.truncated);
    assert_safe_payload(&stopped);
    {
        let mut st = state.lock().await;
        assert_eq!(st.background_tasks.running_count_for(&session_a), 0);
        assert_eq!(st.background_tasks.running_count_for(&session_b), 1);
        assert!(!stop_task(&st.background_tasks, &ids[0]).await.unwrap());
        st.shutdown();
    }
    let shutdown = next_event(&mut events).await;
    assert_eq!(shutdown.task_id, ids[1]);
    assert_eq!(shutdown.session_id, session_b);
    assert_eq!(shutdown.state, BackgroundTaskState::Stopped);
    assert_safe_payload(&shutdown);
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
    assert!(matches!(
        events.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    assert_eq!(Arc::strong_count(&callback), 1);
}

#[tokio::test]
async fn dropping_the_callback_owner_does_not_change_stop_or_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(
        crate::state::AppState::open(dir.path()).unwrap(),
    ));
    let session_id = tests::new_session(&*state.lock().await);
    let (callback, mut events) = install_recorder(&state).await;
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    };
    let id = spawn_background_task_detached(
        &state,
        &session_id,
        command,
        tools::shell::default_shell_id(),
        dir.path(),
        None,
    )
    .await
    .unwrap();
    let observer = Arc::downgrade(&callback);
    drop(callback);
    assert!(
        observer.upgrade().is_none(),
        "the supervisor must not retain the observer"
    );
    let task = {
        let st = state.lock().await;
        assert!(stop_task(&st.background_tasks, &id).await.unwrap());
        st.background_tasks.tasks[&id].clone()
    };
    jobs::wait(&task, 5000).await;
    assert_eq!(jobs::snapshot(&task, false).await["state"], "stopped");
    assert!(task.settled.borrow().is_some());
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
    assert!(matches!(
        events.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected)
    ));
}

#[test]
fn missing_exit_code_is_explicit_null_and_terminal_states_use_the_existing_wire_names() {
    for (state, wire) in [
        (BackgroundTaskState::Exited, "exited"),
        (BackgroundTaskState::Failed, "failed"),
        (BackgroundTaskState::Stopped, "stopped"),
    ] {
        let summary = BackgroundTaskSettled {
            task_id: "task".into(),
            session_id: "session".into(),
            command_shell_id: "shell".into(),
            state,
            exit_code: None,
            duration_ms: 42,
            truncated: false,
        };
        let payload = serde_json::to_value(&summary).unwrap();
        assert_eq!(payload["state"], wire);
        assert!(payload.as_object().unwrap().contains_key("exitCode"));
        assert_eq!(payload["exitCode"], serde_json::Value::Null);
        assert_safe_payload(&summary);
    }
}
