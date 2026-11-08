use super::{rpc_err, JsonRpcError};
use crate::{delegation_approval_history as approvals, delegation_history, state::AppState};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    let invalid = |e: String| rpc_err(1003, e, "INVALID_ARGUMENT");
    if matches!(
        method,
        "delegation.approvalHistory.list" | "delegation.approvalHistory.clear"
    ) && !(params.is_null() || params.as_object().is_some_and(|o| o.is_empty()))
    {
        return Err(invalid("No arguments accepted".into()));
    }
    let result = match method {
        "delegation.history.list" => {
            let query = serde_json::from_value::<delegation_history::Query>(if params.is_null() {
                Value::Object(serde_json::Map::new())
            } else {
                params
            })
            .map_err(|e| invalid(e.to_string()))?;
            delegation_history::check(&query).map_err(|e| invalid(e.to_string()))?;
            delegation_history::list(&st.db, query)
        }
        "delegation.approvalHistory.list" => approvals::list(&st.db),
        "delegation.approvalHistory.record" => approvals::record(&st.db, &params),
        "delegation.approvalHistory.markRead" => approvals::mark_read(&st.db, &params),
        "delegation.approvalHistory.clear" => approvals::clear(&st.db),
        _ => {
            return Err(rpc_err(
                -32601,
                "Unknown delegation method",
                "METHOD_NOT_FOUND",
            ))
        }
    };
    result.map_err(|e| {
        tracing::warn!(method,error=%e,"delegation history operation failed");
        rpc_err(
            1003,
            "Delegation history operation failed",
            "DELEGATION_HISTORY_FAILED",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path()).unwrap();
        (dir, Arc::new(Mutex::new(state)))
    }

    #[tokio::test]
    async fn rejects_unknown_methods_unknown_query_fields_and_arguments_where_none_are_allowed() {
        let (_dir, state) = state();
        let unknown = handle(state.clone(), "delegation.other", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(unknown.data.unwrap()["errorCode"], "METHOD_NOT_FOUND");
        for params in [
            json!({"status":"approved"}),
            json!({"limit":500}),
            json!({"authorize":true}),
        ] {
            let error = handle(state.clone(), "delegation.history.list", params)
                .await
                .unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_ARGUMENT");
        }
        assert!(handle(
            state.clone(),
            "delegation.approvalHistory.clear",
            json!({"all":true})
        )
        .await
        .is_err());
        assert_eq!(
            handle(
                state.clone(),
                "delegation.approvalHistory.list",
                Value::Null
            )
            .await
            .unwrap(),
            json!({"entries":[]})
        );
        assert_eq!(
            handle(state.clone(), "delegation.history.list", Value::Null)
                .await
                .unwrap(),
            json!({"entries":[],"nextOffset":null})
        );
    }
}
