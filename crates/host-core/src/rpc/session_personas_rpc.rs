use super::{remote_tools, rpc_err, sessions, AppState, JsonRpcError};
use crate::{db::REMOTE_PROJECT_PREFIX, mode_runs, session_personas, session_trash};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{fmt::Display, sync::Arc};
use tokio::sync::Mutex;

fn invalid(error: impl Display) -> JsonRpcError {
    rpc_err(1002, error.to_string(), "INVALID_PARAMS")
}

fn internal(error: impl Display) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn unsupported() -> JsonRpcError {
    rpc_err(
        1003,
        "personas require a local Desktop conversation",
        "PERMISSION_DENIED",
    )
}

fn remote_project(path: &str) -> bool {
    path.trim().starts_with(REMOTE_PROJECT_PREFIX)
}

fn ensure_supported_provider(st: &AppState, explicit: Option<&str>) -> Result<(), JsonRpcError> {
    let defaults = if explicit.is_none() {
        st.db.get_setting("app").map_err(internal)?
    } else {
        None
    };
    let provider_id = explicit.or_else(|| defaults.as_ref()?.get("defaultProviderId")?.as_str());
    if provider_id.is_some_and(|id| id.starts_with("extension-agent:")) {
        return Err(rpc_err(
            1002,
            "session personas are unavailable for this agent backend",
            "INVALID_ARGUMENT",
        ));
    }
    Ok(())
}

pub(super) fn validate_settings(
    settings: &serde_json::Map<String, Value>,
) -> Result<(), JsonRpcError> {
    if let Some(value) = settings.get("personas") {
        session_personas::validate_catalog(value).map_err(invalid)?;
    }
    Ok(())
}

pub(super) fn prepare_create(
    st: &AppState,
    params: &Value,
) -> Result<Option<session_personas::SessionPersona>, JsonRpcError> {
    let selection = session_personas::Selection::parse(params).map_err(invalid)?;
    if !selection.is_empty()
        && params
            .get("projectPath")
            .and_then(Value::as_str)
            .is_some_and(remote_project)
    {
        return Err(unsupported());
    }
    let persona = selection.resolve(&st.db, None).map_err(invalid)?;
    if persona.is_some() {
        ensure_supported_provider(st, params.get("providerId").and_then(Value::as_str))?;
    }
    Ok(persona)
}

fn session_busy(st: &AppState, id: &str) -> anyhow::Result<bool> {
    // Do not use the mode/configuration gate that expires approvals on read.
    Ok(st.has_pending_permission(id)
        || st
            .active_bash_cancellations
            .keys()
            .any(|(owner, _)| owner == id)
        || st
            .active_tool_cancellations
            .keys()
            .any(|(owner, _, _)| owner == id)
        || session_trash::has_pending_work(&st.db, id)?
        || mode_runs::open_run(&st.db, id)?.is_some())
}

fn ensure_idle(st: &AppState, id: &str) -> Result<(), JsonRpcError> {
    let busy = || {
        rpc_err(
            1008,
            "settle running or queued work and approvals before changing persona",
            "AGENT_BUSY",
        )
    };
    if session_busy(st, id).map_err(internal)? {
        return Err(busy());
    }
    let mut statement = st
        .db
        .conn()
        .prepare_cached(
            "SELECT session_id FROM session_collaboration_links WHERE created_by_session_id = ?1",
        )
        .map_err(internal)?;
    let workers = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(internal)?;
    for worker in workers {
        if session_busy(st, &worker.map_err(internal)?).map_err(internal)? {
            return Err(busy());
        }
    }
    // Inline delegates and delegation approvals not represented as Host work
    // are gated by the Desktop orchestrator before invoking this RPC.
    Ok(())
}

pub(super) async fn configure(
    state: &Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid("persona configuration must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "personaId" | "inheritToSubagents"))
    {
        return Err(invalid("unsupported persona configuration field"));
    }
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && session_personas::trim(id) == *id)
        .ok_or_else(|| invalid("id required"))?;
    if id.starts_with("remote:") || id.starts_with("native-pi:") {
        return Err(unsupported());
    }
    let selection = session_personas::Selection::parse(&params).map_err(invalid)?;
    if selection.is_empty() {
        return Err(invalid("personaId or inheritToSubagents required"));
    }

    let st = state.lock().await;
    let tx = st.db.conn().unchecked_transaction().map_err(internal)?;
    let local: Option<bool> = tx
        .query_row(
            "SELECT COALESCE(NULLIF(s.source, ''), 'desktop') = 'desktop'
            AND NOT EXISTS(SELECT 1 FROM session_import_origins WHERE session_id = s.id)
            AND NOT EXISTS(SELECT 1 FROM task_runs WHERE session_id = s.id)
         FROM sessions s WHERE s.id = ?1 AND s.deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(internal)?;
    let not_found = || rpc_err(1007, "session not found", "NOT_FOUND");
    if !local.ok_or_else(not_found)? {
        return Err(unsupported());
    }
    let mut summary = sessions::session_summary(&st.db, id)
        .map_err(internal)?
        .ok_or_else(not_found)?;
    if summary.project_path.as_deref().is_some_and(remote_project) {
        return Err(unsupported());
    }
    ensure_idle(&st, id)?;
    let persona = selection
        .resolve(&st.db, summary.persona.clone())
        .map_err(invalid)?;
    if persona.is_some() {
        ensure_supported_provider(&st, summary.provider_id.as_deref())?;
    }
    if persona != summary.persona {
        session_personas::write(&tx, id, persona.as_ref()).map_err(internal)?;
    }
    summary.persona = persona;
    let value = remote_tools::session_value(&st.db, summary)?;
    tx.commit().map_err(internal)?;
    Ok(json!({ "session": value }))
}

#[cfg(test)]
#[path = "session_personas_rpc_tests.rs"]
mod tests;
