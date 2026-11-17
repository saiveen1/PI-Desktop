//! Explicit, read-only configuration export. Never opens AppState or copies a profile.

use anyhow::{bail, Result};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write, path::Path};

pub fn run_cli() -> Result<bool> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|arg| arg != "--backup-config") {
        return Ok(false);
    }
    if args.len() != 3 {
        bail!("usage: pi-desktop-host-core --backup-config <data-directory> <output.json>");
    }
    export(Path::new(&args[1]), Path::new(&args[2]))?;
    Ok(true)
}

fn json_rows(db: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn export(data_dir: &Path, output: &Path) -> Result<()> {
    let db =
        Connection::open_with_flags(data_dir.join("pi.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let application: Option<String> = db
        .query_row(
            "SELECT value_json FROM kv WHERE ns='app' AND key='app'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let mut application: Value = application
        .map(|raw| serde_json::from_str(&raw))
        .transpose()?
        .unwrap_or(json!({}));
    let Some(fields) = application.as_object_mut() else {
        bail!("application configuration must be an object");
    };
    fields.retain(|key, _| {
        crate::config_sync::domains::PORTABLE_APPLICATION_FIELDS.contains(&key.as_str())
    });
    let providers = json_rows(
        &db,
        "SELECT json_object(
        'id',id,'name',name,'vendorKey',vendor_key,'type',type,'protocol',protocol,
        'apiStyle',api_style,'authKind',auth_kind,'baseUrl',base_url,'enabled',enabled,
        'defaultModelId',default_model_id,'config',json(config_json))
        FROM providers WHERE owner_plugin_id IS NULL ORDER BY id",
    )?;
    let models = json_rows(
        &db,
        "SELECT json_object(
        'providerId',provider_id,'modelId',model_id,'displayName',display_name,
        'source',source,'capabilities',json(capabilities_json),'contextWindow',context_window,
        'maxOutputTokens',max_output_tokens,'deprecated',deprecated)
        FROM models WHERE provider_id IN (SELECT id FROM providers WHERE owner_plugin_id IS NULL)
        ORDER BY provider_id,model_id",
    )?;
    let bytes = serde_json::to_vec_pretty(&json!({
        "format": "pi-desktop-local-config", "version": 1,
        "application": application, "providers": providers, "models": models
    }))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_only_configuration_without_copying_sessions_or_mutating_source() -> Result<()> {
        let root = tempfile::tempdir()?;
        let db = Connection::open(root.path().join("pi.sqlite"))?;
        db.execute_batch("CREATE TABLE kv(ns TEXT,key TEXT,value_json TEXT);
            CREATE TABLE providers(id TEXT,name TEXT,vendor_key TEXT,type TEXT,protocol TEXT,
                api_style TEXT,auth_kind TEXT,base_url TEXT,enabled INTEGER,default_model_id TEXT,
                config_json TEXT,owner_plugin_id TEXT,secret_ref TEXT);
            CREATE TABLE models(provider_id TEXT,model_id TEXT,display_name TEXT,source TEXT,
                capabilities_json TEXT,context_window INTEGER,max_output_tokens INTEGER,deprecated INTEGER);
            INSERT INTO kv VALUES('app','app','{\"theme\":\"dark\",\"lastSessionId\":\"PRIVATE_CHAT\"}');
            INSERT INTO kv VALUES('sessions','history','\"PRIVATE_CHAT\"');
            INSERT INTO providers VALUES('p','Provider','custom','openai_compatible','openai_compatible',
                NULL,'api_key_and_base_url','https://example.invalid',1,'m','{}',NULL,'SECRET_REF');
            INSERT INTO models VALUES('p','m','Model','user','[]',8192,1024,0);")?;
        drop(db);
        std::fs::create_dir(root.path().join("sessions"))?;
        std::fs::write(root.path().join("sessions/private.jsonl"), "PRIVATE_CHAT")?;
        let before = std::fs::read(root.path().join("pi.sqlite"))?;
        let output = root.path().join("config.json");
        export(root.path(), &output)?;
        let text = std::fs::read_to_string(&output)?;
        let value: Value = serde_json::from_str(&text)?;
        assert_eq!(value["application"], json!({"theme":"dark"}));
        assert_eq!(value["providers"][0]["id"], "p");
        assert_eq!(value["models"][0]["modelId"], "m");
        assert!(!text.contains("PRIVATE_CHAT") && !text.contains("SECRET_REF"));
        assert_eq!(std::fs::read(root.path().join("pi.sqlite"))?, before);
        assert!(export(root.path(), &output).is_err());
        assert_eq!(std::fs::read_to_string(&output)?, text);
        Ok(())
    }

    #[test]
    fn refuses_missing_or_invalid_databases_without_creating_output() -> Result<()> {
        let root = tempfile::tempdir()?;
        let output = root.path().join("config.json");
        assert!(export(root.path(), &output).is_err());
        assert!(!root.path().join("pi.sqlite").exists() && !output.exists());
        std::fs::write(root.path().join("pi.sqlite"), b"not a database")?;
        assert!(export(root.path(), &output).is_err());
        assert!(!output.exists());
        Ok(())
    }
}
