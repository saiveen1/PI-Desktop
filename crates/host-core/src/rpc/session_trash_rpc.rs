//! Recycle-bin RPCs keep restoration serialized with asynchronous worktree removal.
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{drop_session_side_data, rpc_err, worktree_rpc, JsonRpcError};
use crate::{session_trash, state::AppState};

fn map_error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let (code, name) = if message.starts_with("AGENT_BUSY") {
        (1009, "AGENT_BUSY")
    } else if message.starts_with("INVALID_ARGUMENT") {
        (1002, "INVALID_ARGUMENT")
    } else {
        (1000, "INTERNAL")
    };
    rpc_err(code, message, name)
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if method == "session.listTrashed" {
        let st = state.lock().await;
        return Ok(json!({ "sessions": session_trash::list(&st.db).map_err(map_error)? }));
    }
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.trim().is_empty()
                && id.len() <= 256
                && !id.starts_with("native-pi:")
                && !id.starts_with("remote:")
        })
        .ok_or_else(|| {
            rpc_err(
                1002,
                "a local Desktop session id is required",
                "INVALID_ARGUMENT",
            )
        })?;
    let gate = state.lock().await.session_trash_lock.clone();
    let _operation = gate.lock().await;
    match method {
        "session.trash" => {
            let mut st = state.lock().await;
            let ok = session_trash::trash(&st.db, id).map_err(map_error)?;
            if ok {
                st.background_tasks.stop_session_running(id);
                st.background_tasks
                    .cancel_continuations(Some(id), None, None);
                st.hashline.drop_session(id);
            }
            Ok(json!({ "ok": ok }))
        }
        "session.restoreTrashed" => {
            let st = state.lock().await;
            Ok(json!({ "ok": session_trash::restore(&st.db, id).map_err(map_error)? }))
        }
        "session.deleteTrashed" => {
            {
                let st = state.lock().await;
                session_trash::ensure_idle(&st.db, id).map_err(map_error)?;
                if !session_trash::is_trashed(&st.db, id).map_err(map_error)? {
                    return Err(rpc_err(
                        1002,
                        "session must be in the recycle bin",
                        "INVALID_ARGUMENT",
                    ));
                }
            }
            // Keep the recycle-bin gate, not AppState, across filesystem/Git I/O.
            worktree_rpc::remove_before_delete(state, id).await?;
            let st = state.lock().await;
            let ok = session_trash::purge(&st.db, id).map_err(map_error)?;
            if ok {
                drop_session_side_data(&st, id);
            }
            drop(st);
            worktree_rpc::spawn_orphan_cleanup(state);
            Ok(json!({ "ok": ok }))
        }
        _ => Err(rpc_err(-32601, "unknown recycle-bin method", "NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests;
