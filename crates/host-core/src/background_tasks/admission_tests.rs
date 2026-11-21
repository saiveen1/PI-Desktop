use super::*;
use std::future::{pending, Future};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

type SpawnResult = Result<tools::SpawnedToolRunner, (String, String)>;

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

// No executable or shell lookup: only the injected spawn boundary can launch.
fn config() -> tools::ToolRunnerStartConfig {
    tools::ToolRunnerStartConfig {
        program: "must-not-launch".into(),
        args: Vec::new(),
        workspace: ".".into(),
        scratch_dir: None,
        env_path: None,
        extra_env: Vec::new(),
    }
}

async fn blocked_spawn(
    state: &Mutex<crate::state::AppState>,
    session: &str,
) -> Result<String, (String, String)> {
    spawn_background_task_with(state, session, "marker", "test", config(), None, |_| {
        pending::<SpawnResult>()
    })
    .await
}

async fn assert_refused_without_launch(
    state: &Mutex<crate::state::AppState>,
    session: &str,
    reason: &str,
) {
    let error = spawn_background_task_with(
        state,
        session,
        "marker",
        "test",
        config(),
        None,
        |_| -> std::future::Ready<SpawnResult> {
            panic!("refused admission reached executable spawn boundary");
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, "TOOL_FAILED");
    assert!(error.1.contains(reason), "{error:?}");
}

#[tokio::test]
async fn missing_and_deleted_sessions_never_dispatch_executable_config() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    assert_refused_without_launch(&state, "missing", "no longer exists").await;
    let session = {
        let st = state.lock().await;
        let session = super::tests::new_session(&st);
        crate::sessions::delete_session(&st.db, &session).unwrap();
        session
    };
    assert_refused_without_launch(&state, &session, "no longer exists").await;
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}

#[tokio::test]
async fn per_session_reservations_refuse_before_spawn_and_cancel_releases_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let (a, b) = {
        let st = state.lock().await;
        (
            super::tests::new_session(&st),
            super::tests::new_session(&st),
        )
    };
    let mut pending = Vec::new();
    for _ in 0..MAX_RUNNING_TASKS_PER_SESSION {
        let mut spawn = Box::pin(blocked_spawn(&state, &a));
        assert!(poll_once(spawn.as_mut()).is_pending());
        pending.push(spawn);
    }
    // Every spawn is pending, yet AppState remains available and slots reserved.
    assert_eq!(
        state
            .try_lock()
            .unwrap()
            .background_tasks
            .running_count_for(&a),
        MAX_RUNNING_TASKS_PER_SESSION
    );
    assert_refused_without_launch(&state, &a, "this session already runs").await;
    let mut other = Box::pin(blocked_spawn(&state, &b));
    assert!(poll_once(other.as_mut()).is_pending());
    drop(pending.pop());
    let mut replacement = Box::pin(blocked_spawn(&state, &a));
    assert!(poll_once(replacement.as_mut()).is_pending());
    drop((replacement, pending, other));
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}

#[tokio::test]
async fn global_reservations_refuse_before_spawn_and_release_on_drop() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let sessions = {
        let st = state.lock().await;
        (0..8)
            .map(|_| super::tests::new_session(&st))
            .collect::<Vec<_>>()
    };
    let mut starts = Vec::new();
    for index in 0..MAX_RUNNING_TASKS_TOTAL {
        let mut spawn = Box::pin(blocked_spawn(
            &state,
            &sessions[index / MAX_RUNNING_TASKS_PER_SESSION],
        ));
        assert!(poll_once(spawn.as_mut()).is_pending());
        starts.push(spawn);
    }
    assert_refused_without_launch(&state, &sessions[7], "across all sessions").await;
    drop(starts.pop());
    let mut replacement = Box::pin(blocked_spawn(&state, &sessions[7]));
    assert!(poll_once(replacement.as_mut()).is_pending());
    drop((replacement, starts));
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}

#[tokio::test]
async fn spawn_failure_releases_reservation_without_holding_app_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let session = super::tests::new_session(&*state.lock().await);
    let error =
        spawn_background_task_with(&state, &session, "marker", "test", config(), None, |_| {
            let st = state.try_lock().expect("spawn must not hold AppState");
            assert_eq!(st.background_tasks.running_count_for(&session), 1);
            std::future::ready(Err(("SPAWN_FAILED".into(), "injected".into())))
        })
        .await
        .unwrap_err();
    assert_eq!(error.0, "SPAWN_FAILED");
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
    let mut retry = Box::pin(blocked_spawn(&state, &session));
    assert!(poll_once(retry.as_mut()).is_pending());
}

#[tokio::test]
async fn session_stop_and_shutdown_cancel_in_progress_spawns_without_cross_session_signals() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let (a, b) = {
        let st = state.lock().await;
        (
            super::tests::new_session(&st),
            super::tests::new_session(&st),
        )
    };
    let mut first = Box::pin(blocked_spawn(&state, &a));
    let mut other = Box::pin(blocked_spawn(&state, &b));
    assert!(poll_once(first.as_mut()).is_pending());
    assert!(poll_once(other.as_mut()).is_pending());
    {
        let st = state.lock().await;
        crate::sessions::delete_session(&st.db, &a).unwrap();
        assert_eq!(st.background_tasks.stop_session_running(&a), 1);
        assert_eq!(st.background_tasks.stop_session_running(&a), 0);
    }
    assert_eq!(first.await.unwrap_err().0, "TOOL_ABORTED");
    assert!(poll_once(other.as_mut()).is_pending());
    {
        let st = state.lock().await;
        assert_eq!(st.background_tasks.running_count(), 1);
        stop_all_running_sync(&st.background_tasks);
    }
    assert_eq!(other.await.unwrap_err().0, "TOOL_ABORTED");
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}

#[tokio::test]
async fn shutdown_refuses_new_spawn_before_executable_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let session = {
        let mut st = state.lock().await;
        let session = super::tests::new_session(&st);
        st.shutdown();
        session
    };
    let error = spawn_background_task_with(
        &state,
        &session,
        "marker",
        "test",
        config(),
        None,
        |_| -> std::future::Ready<SpawnResult> {
            panic!("shutdown must not dispatch executable config");
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, "TOOL_ABORTED");
    assert_eq!(state.lock().await.background_tasks.running_count(), 0);
}

#[tokio::test]
async fn disabled_and_stale_continuations_do_not_dispatch_executable_config() {
    let dir = tempfile::tempdir().unwrap();
    let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let (session, turn) = {
        let st = state.lock().await;
        let session = super::tests::new_session(&st);
        let turn = crate::sessions::begin_turn(&st.db, &session, None, None).unwrap();
        (session, turn)
    };
    for (enabled, expected) in [(false, "PERMISSION_DENIED"), (true, "TOOL_ABORTED")] {
        {
            let st = state.lock().await;
            st.db
                .set_setting(
                    "app",
                    &serde_json::json!({"backgroundJobContinuationEnabled": enabled}),
                )
                .unwrap();
            if enabled {
                crate::sessions::end_turn(&st.db, &turn, "aborted", None, None, false).unwrap();
            }
        }
        let error = spawn_background_task_with(
            &state,
            &session,
            "marker",
            "test",
            config(),
            Some(&turn),
            |_| -> std::future::Ready<SpawnResult> {
                panic!("refused continuation reached executable spawn boundary");
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, expected);
        let st = state.lock().await;
        assert_eq!(st.background_tasks.running_count(), 0);
        assert!(st.background_tasks.continuations.is_empty());
    }
}
