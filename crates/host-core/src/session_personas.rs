use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use crate::{db::Database, sessions::SessionSummary};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonaDefinition {
    // Field order defines the canonical bytes of the revision hash.
    id: String,
    name: String,
    prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPersona {
    version: u8,
    definition: PersonaDefinition,
    revision: String,
    inherit_to_subagents: bool,
}

fn is_valid_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    id.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

// Match the renderer's String.trim() so Host-accepted snapshots stay usable.
pub(crate) fn trim(value: &str) -> &str {
    value.trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{0085}') || ch == '\u{feff}')
}

fn catalog(value: &Value) -> Result<Vec<PersonaDefinition>> {
    let entries = value
        .as_array()
        .filter(|entries| entries.len() <= 32)
        .ok_or_else(|| anyhow!("personas must be an array of at most 32 definitions"))?;
    let mut definitions = Vec::with_capacity(entries.len());
    let mut ids = HashSet::new();
    for entry in entries {
        if !entry.is_object() {
            return Err(anyhow!("each persona must be an object"));
        }
        let definition = PersonaDefinition::deserialize(entry).map_err(|_| {
            anyhow!("each persona must contain only string id, name, and prompt fields")
        })?;
        if !is_valid_id(&definition.id) || !ids.insert(definition.id.clone()) {
            return Err(anyhow!(
                "persona ids must be unique and match [A-Za-z0-9][A-Za-z0-9_-]{{0,63}}"
            ));
        }
        if definition.name.is_empty()
            || trim(&definition.name) != definition.name
            || definition.name.chars().count() > 128
        {
            return Err(anyhow!(
                "persona names must be nonempty, trimmed, and at most 128 Unicode scalars"
            ));
        }
        if trim(&definition.prompt).is_empty() || definition.prompt.len() > 32768 {
            return Err(anyhow!(
                "persona prompts must be nonblank and at most 32768 UTF-8 bytes"
            ));
        }
        definitions.push(definition);
    }
    Ok(definitions)
}

pub fn validate_catalog(value: &Value) -> Result<()> {
    catalog(value).map(|_| ())
}

pub struct Selection<'a> {
    persona_id: Option<Option<&'a str>>,
    inherit_to_subagents: Option<bool>,
}

impl Selection<'_> {
    pub fn parse(params: &Value) -> Result<Selection<'_>> {
        let persona_id = match params.get("personaId") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(id)) if is_valid_id(id) => Some(Some(id.as_str())),
            _ => return Err(anyhow!("personaId must be a valid persona id or null")),
        };
        let inherit_to_subagents = params
            .get("inheritToSubagents")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| anyhow!("inheritToSubagents must be a boolean"))
            })
            .transpose()?;
        if inherit_to_subagents == Some(true) && persona_id == Some(None) {
            return Err(anyhow!("cannot enable inheritance without a persona"));
        }
        Ok(Selection {
            persona_id,
            inherit_to_subagents,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.persona_id.is_none() && self.inherit_to_subagents.is_none()
    }

    pub fn resolve(
        &self,
        db: &Database,
        previous: Option<SessionPersona>,
    ) -> Result<Option<SessionPersona>> {
        let inherit_to_subagents = self.inherit_to_subagents.unwrap_or_else(|| {
            previous
                .as_ref()
                .is_some_and(|persona| persona.inherit_to_subagents)
        });
        match self.persona_id {
            Some(None) => Ok(None),
            Some(Some(id)) => {
                let settings = db.get_setting("app")?;
                let definitions = settings
                    .as_ref()
                    .and_then(|settings| settings.get("personas"))
                    .map(catalog)
                    .transpose()?
                    .unwrap_or_default();
                let definition = definitions
                    .into_iter()
                    .find(|definition| definition.id == id)
                    .ok_or_else(|| anyhow!("personaId does not match a saved persona"))?;
                let revision = hex::encode(Sha256::digest(serde_json::to_vec(&definition)?));
                Ok(Some(SessionPersona {
                    version: 1,
                    definition,
                    revision,
                    inherit_to_subagents,
                }))
            }
            None => match previous {
                Some(mut persona) => {
                    persona.inherit_to_subagents = inherit_to_subagents;
                    Ok(Some(persona))
                }
                None if inherit_to_subagents => {
                    Err(anyhow!("cannot enable inheritance without a persona"))
                }
                None => Ok(None),
            },
        }
    }
}

pub fn read(db: &Database, id: &str) -> Result<Option<SessionPersona>> {
    let encoded: Option<String> = db
        .conn()
        .prepare_cached("SELECT snapshot_json FROM session_personas WHERE session_id = ?1")?
        .query_row([id], |row| row.get(0))
        .optional()?;
    encoded
        .map(|encoded| {
            let persona: SessionPersona = serde_json::from_str(&encoded)?;
            if persona.version != 1 {
                return Err(anyhow!("unsupported session persona snapshot version"));
            }
            Ok(persona)
        })
        .transpose()
}

pub fn attach(db: &Database, summary: &mut SessionSummary) -> Result<()> {
    summary.persona = read(db, &summary.id)?;
    Ok(())
}

pub fn write(conn: &Connection, id: &str, persona: Option<&SessionPersona>) -> Result<()> {
    match persona {
        Some(persona) => conn.execute(
            "INSERT INTO session_personas (session_id, snapshot_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET snapshot_json = excluded.snapshot_json",
            params![id, serde_json::to_string(persona)?],
        )?,
        None => conn.execute("DELETE FROM session_personas WHERE session_id = ?1", [id])?,
    };
    Ok(())
}

#[cfg(test)]
mod tests;
