use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::Value;
use std::collections::HashSet;

use crate::{db::Database, sessions::SessionSummary};

pub const NAMESPACE: &str = "sessionDelegation";

pub fn parse(value: &Value) -> Result<Option<Vec<String>>> {
    if value.is_null() {
        return Ok(None);
    }
    let values = value
        .as_array()
        .ok_or_else(|| anyhow!("delegationModelKeys must be an array or null"))?;
    if values.len() > 128 {
        return Err(anyhow!(
            "delegationModelKeys may contain at most 128 models"
        ));
    }
    let mut seen = HashSet::new();
    let mut keys = Vec::new();
    for value in values {
        let key = value
            .as_str()
            .ok_or_else(|| anyhow!("delegation model key must be a string"))?;
        let Some((provider, model)) = key.split_once('/') else {
            return Err(anyhow!("delegation model key must be providerId/modelId"));
        };
        if provider.is_empty()
            || provider.trim() != provider
            || model.trim() != model
            || provider.len() > 128
            || model.is_empty()
            || model.len() > 256
            || key.trim() != key
            || key.chars().any(char::is_control)
            || !seen.insert(key)
        {
            return Err(anyhow!("invalid or duplicate delegation model key"));
        }
        keys.push(key.to_owned());
    }
    Ok(Some(keys))
}

pub fn read(db: &Database, id: &str) -> Result<Option<Vec<String>>> {
    db.kv_get(NAMESPACE, id)?
        .map(|value| parse(&value))
        .transpose()
        .map(Option::flatten)
}

pub fn attach(db: &Database, summaries: &mut [SessionSummary]) -> Result<()> {
    for summary in summaries {
        summary.delegation_model_keys = read(db, &summary.id)?;
    }
    Ok(())
}

pub fn ensure_idle(db: &Database, id: &str) -> Result<()> {
    let blocked: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id = ?1 AND status = 'running')
         OR EXISTS(SELECT 1 FROM plan_approvals WHERE session_id = ?1
             AND (status = 'pending' OR execution_state IN ('queued', 'running')))",
        params![id],
        |row| row.get(0),
    )?;
    if blocked {
        return Err(anyhow!(
            "PLAN_CONFIGURATION_BLOCKED delegation models can only change while idle"
        ));
    }
    Ok(())
}

pub fn write(db: &Database, id: &str, keys: Option<&[String]>) -> Result<()> {
    match keys {
        Some(keys) => db.kv_set(NAMESPACE, id, &serde_json::to_value(keys)?),
        None => db.kv_delete(NAMESPACE, id),
    }
}
