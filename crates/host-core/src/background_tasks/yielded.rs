//! Publish and observe foreground Bash commands that outlive their initial wait.

use std::sync::Weak;
use std::time::Instant;
use tokio::sync::{watch, Mutex};

use super::{
    bump_change_counter, jobs, register_task, BackgroundTask, BackgroundTaskSettled,
    BackgroundTaskSettledCallback, BackgroundTaskState, MAX_RUNNING_TASKS_PER_SESSION,
    MAX_RUNNING_TASKS_TOTAL, RING_MAX_BYTES,
};

/// Publish an already-executing command only while its session still owns it.
pub(crate) async fn register_yielded_task(
    state: &Mutex<crate::state::AppState>,
    session_id: &str,
    command: &str,
    shell_id: &str,
    started_at: Instant,
    cancellation: Option<&watch::Receiver<bool>>,
    initial_output: [(String, bool); 2],
) -> Result<
    Option<(
        BackgroundTask,
        watch::Receiver<bool>,
        serde_json::Value,
        Option<Weak<BackgroundTaskSettledCallback>>,
    )>,
    String,
> {
    // Never wait on AppState while the command's timeout and cancellation are paused.
    let Ok(mut st) = state.try_lock() else {
        return Ok(None);
    };
    if st.shutting_down
        || cancellation.is_some_and(|receiver| *receiver.borrow())
        || crate::sessions::tool_policy(&st.db, session_id).map_err(|err| err.to_string())?
            != Some(crate::sessions::ToolPolicy::Agent)
        || st.background_tasks.running_count_for(session_id) >= MAX_RUNNING_TASKS_PER_SESSION
        || st.background_tasks.running_count() >= MAX_RUNNING_TASKS_TOTAL
    {
        return Ok(None);
    }
    let (task, stop_rx) = register_task(
        &mut st.background_tasks,
        session_id,
        command,
        shell_id,
        started_at,
    );
    let [(stdout, out_truncated), (stderr, err_truncated)] = initial_output;
    let snapshot = {
        let mut shared = task.shared.try_lock().expect("new task is private");
        append_output(&mut shared, true, &stdout, out_truncated);
        append_output(&mut shared, false, &stderr, err_truncated);
        jobs::snapshot_locked(&task, &shared, true)
    };
    let on_settled = st.background_tasks.on_settled.clone();
    bump_change_counter();
    Ok(Some((task, stop_rx, snapshot, on_settled)))
}
fn append_output(shared: &mut super::TaskShared, is_stdout: bool, text: &str, truncated: bool) {
    if text.is_empty() && !truncated {
        return;
    }
    let mut offset = text.len().saturating_sub(RING_MAX_BYTES);
    while !text.is_char_boundary(offset) {
        offset += 1;
    }
    let dropped = if is_stdout {
        shared.push_stdout(&text[offset..])
    } else {
        shared.push_stderr(&text[offset..])
    };
    shared.truncated |= truncated || dropped || offset > 0;
}

impl BackgroundTask {
    pub(crate) async fn append_yielded_output(&self, is_stdout: bool, text: &str, truncated: bool) {
        append_output(&mut *self.shared.lock().await, is_stdout, text, truncated);
    }

    pub(crate) async fn finish_yielded(
        &self,
        state: BackgroundTaskState,
        exit_code: Option<i32>,
        error: Option<&str>,
        on_settled: Option<Weak<BackgroundTaskSettledCallback>>,
    ) {
        if let Some(error) = error {
            self.append_yielded_output(false, &format!("\n{error}\n"), false)
                .await;
        }
        let mut shared = self.shared.lock().await;
        shared.state = state;
        shared.exit_code = exit_code;
        let duration = self.started_at.elapsed();
        self.settled.send_replace(Some(duration));
        let summary = BackgroundTaskSettled {
            task_id: self.id.clone(),
            session_id: self.session_id.clone(),
            command_shell_id: self.command_shell_id.clone(),
            state,
            exit_code,
            duration_ms: duration.as_millis() as u64,
            truncated: shared.truncated,
        };
        drop(shared);
        bump_change_counter();
        if let Some(callback) = on_settled.and_then(|callback| callback.upgrade()) {
            callback(summary);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn contended_state_skips_handoff_without_registering() {
        let dir = tempfile::tempdir().unwrap();
        let state = Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
        let st = state.lock().await;
        let session = super::super::tests::new_session(&st);
        let result = register_yielded_task(
            &state,
            &session,
            "command",
            "shell",
            Instant::now(),
            None,
            [(String::new(), false), (String::new(), false)],
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert_eq!(st.background_tasks.running_count(), 0);
    }

    #[tokio::test]
    async fn yielded_job_publishes_safe_settlement_after_output_and_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(Mutex::new(
            crate::state::AppState::open(dir.path()).unwrap(),
        ));
        let session = super::super::tests::new_session(&*state.lock().await);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let weak_state = Arc::downgrade(&state);
        let callback: Arc<BackgroundTaskSettledCallback> = Arc::new(move |summary| {
            let state = weak_state.upgrade().unwrap();
            let st = state.try_lock().expect("callback must not hold AppState");
            let task = &st.background_tasks.tasks[&summary.task_id];
            let shared = task
                .shared
                .try_lock()
                .expect("callback must not hold task lock");
            assert_eq!(shared.state, summary.state);
            assert_eq!(shared.exit_code, summary.exit_code);
            assert_eq!(shared.truncated, summary.truncated);
            assert!(task.settled.borrow().is_some());
            tx.send(summary).unwrap();
        });
        state
            .lock()
            .await
            .background_tasks
            .set_on_settled(Arc::downgrade(&callback));
        let (task, _stop, snapshot, on_settled) = register_yielded_task(
            &state,
            &session,
            "private command",
            "shell",
            Instant::now(),
            None,
            [("initial".into(), true), ("".into(), false)],
        )
        .await
        .unwrap()
        .expect("agent session can publish");
        assert_eq!(snapshot["state"], "running");
        task.append_yielded_output(false, "final stderr", false)
            .await;
        task.finish_yielded(BackgroundTaskState::Failed, Some(7), None, on_settled)
            .await;
        let event = rx.try_recv().unwrap();
        assert_eq!(event.task_id, task.id);
        assert_eq!(event.exit_code, Some(7));
        assert!(event.truncated);
        let payload = serde_json::to_value(event).unwrap();
        assert!(payload.get("command").is_none());
        assert!(payload.get("stderr").is_none());
        assert!(rx.try_recv().is_err());
        assert_eq!(jobs::snapshot(&task, true).await["stderr"], "final stderr");
    }
}
