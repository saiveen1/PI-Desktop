use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

use crate::{db::Database, sessions::SessionSummary};

pub const NAMESPACE: &str = "sessionDelegation";
pub type ModelApprovals = BTreeMap<String, String>;

/// The durable extension is a legacy exact-model-key array until a session has
/// approval overrides. Approval-bearing records use this versioned object so
/// pre-existing arrays remain readable without a schema migration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DelegationConfig {
    pub model_keys: Option<Vec<String>>,
    pub model_approvals: Option<ModelApprovals>,
}

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
        validate_model_key(key, &mut seen)?;
        keys.push(key.to_owned());
    }
    Ok(Some(keys))
}

pub fn parse_approvals(value: &Value) -> Result<Option<ModelApprovals>> {
    if value.is_null() {
        return Ok(None);
    }
    let values = value
        .as_object()
        .ok_or_else(|| anyhow!("delegationModelApprovals must be an object or null"))?;
    if values.len() > 128 {
        return Err(anyhow!(
            "delegationModelApprovals may contain at most 128 models"
        ));
    }
    let mut seen = HashSet::new();
    let mut approvals = ModelApprovals::new();
    for (key, value) in values {
        validate_model_key(key, &mut seen)?;
        let approval = value
            .as_str()
            .ok_or_else(|| anyhow!("delegation model approval must be a string"))?;
        if !matches!(approval, "auto" | "ask") {
            return Err(anyhow!("delegation model approval must be auto or ask"));
        }
        approvals.insert(key.clone(), approval.to_owned());
    }
    Ok(Some(approvals))
}

pub fn validate_approvals(
    model_keys: Option<&[String]>,
    model_approvals: Option<&ModelApprovals>,
) -> Result<()> {
    let Some(model_approvals) = model_approvals else {
        return Ok(());
    };
    let model_keys = model_keys.ok_or_else(|| {
        anyhow!("delegationModelApprovals requires a custom delegationModelKeys pool")
    })?;
    let selected = model_keys
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    if model_approvals
        .keys()
        .any(|key| !selected.contains(key.as_str()))
    {
        return Err(anyhow!(
            "delegationModelApprovals may only name selected delegationModelKeys"
        ));
    }
    Ok(())
}

fn validate_model_key<'a>(key: &'a str, seen: &mut HashSet<&'a str>) -> Result<()> {
    let Some((provider, model)) = key.split_once('/') else {
        return Err(anyhow!("delegation model key must be providerId/modelId"));
    };
    if provider.is_empty()
        || provider.trim() != provider
        || model.trim() != model
        || provider.encode_utf16().count() > 128
        || model.is_empty()
        || model.encode_utf16().count() > 256
        || key.trim() != key
        || key.chars().any(char::is_control)
        || !seen.insert(key)
    {
        return Err(anyhow!("invalid or duplicate delegation model key"));
    }
    Ok(())
}

pub fn read(db: &Database, id: &str) -> Result<DelegationConfig> {
    let Some(value) = db.kv_get(NAMESPACE, id)? else {
        return Ok(DelegationConfig::default());
    };
    if value.is_array() || value.is_null() {
        return Ok(DelegationConfig {
            model_keys: parse(&value)?,
            model_approvals: None,
        });
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("invalid session delegation record"))?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(anyhow!("unsupported session delegation record version"));
    }
    let model_keys = parse(
        object
            .get("modelKeys")
            .ok_or_else(|| anyhow!("session delegation record requires modelKeys"))?,
    )?
    .ok_or_else(|| anyhow!("session delegation record requires a custom model pool"))?;
    let model_approvals = object
        .get("modelApprovals")
        .map(parse_approvals)
        .transpose()?
        .flatten();
    validate_approvals(Some(&model_keys), model_approvals.as_ref())?;
    Ok(DelegationConfig {
        model_keys: Some(model_keys),
        model_approvals,
    })
}

pub fn attach(db: &Database, summaries: &mut [SessionSummary]) -> Result<()> {
    for summary in summaries {
        let config = read(db, &summary.id)?;
        summary.delegation_model_keys = config.model_keys;
        summary.delegation_model_approvals = config.model_approvals;
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

pub fn write(db: &Database, id: &str, config: &DelegationConfig) -> Result<()> {
    match (&config.model_keys, &config.model_approvals) {
        (None, _) => db.kv_delete(NAMESPACE, id),
        (Some(model_keys), Some(model_approvals)) => db.kv_set(
            NAMESPACE,
            id,
            &json!({
                "version": 1,
                "modelKeys": model_keys,
                "modelApprovals": model_approvals,
            }),
        ),
        (Some(model_keys), None) => db.kv_set(NAMESPACE, id, &serde_json::to_value(model_keys)?),
    }
}
