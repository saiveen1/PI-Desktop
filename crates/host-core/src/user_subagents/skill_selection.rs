use anyhow::{bail, Result};
use serde::{Deserialize, Deserializer};

const MAX_SKILLS: usize = 256;
const MAX_ID_LENGTH: usize = 256;

/// Missing preserves an existing selection; JSON null restores inherit-all.
pub(super) fn deserialize_update<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<Vec<String>>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<Vec<String>>::deserialize(deserializer).map(Some)
}

pub(super) fn normalize(values: &[String]) -> Result<Vec<String>> {
    if values.len() > MAX_SKILLS {
        bail!("SUBAGENT_INVALID: skills must contain at most {MAX_SKILLS} IDs");
    }
    let mut ids = Vec::new();
    for value in values {
        let id = value.trim();
        if id.is_empty()
            || id.len() > MAX_ID_LENGTH
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
        {
            bail!("SUBAGENT_INVALID: invalid skill ID (use 1-256 letters, digits, dots, underscores, colons, slashes or dashes)");
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

/// Same flat inline/comma/block list conventions as the shared definition parser.
pub(super) fn parse(raw: &str) -> Result<Option<Vec<String>>> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(None);
    }
    let mut values: Option<Vec<String>> = None;
    let mut collecting = false;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting {
            if let Some(value) = line.strip_prefix("- ") {
                let value = unquote(value);
                if !value.is_empty() {
                    if let Some(values) = &mut values {
                        values.push(value.to_string());
                    }
                }
                continue;
            }
        }
        collecting = false;
        if let Some((key, value)) = line.split_once(':') {
            if key.to_lowercase().replace(['-', '_', ' '], "") == "skills" {
                let value = unquote(value.trim());
                collecting = value.is_empty();
                let inner = value.strip_prefix('[').unwrap_or(value);
                let inner = inner.strip_suffix(']').unwrap_or(inner);
                values = Some(
                    inner
                        .split(',')
                        .map(unquote)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                        .collect(),
                );
            }
        }
    }
    values.map(|values| normalize(&values)).transpose()
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_empty_and_deduplicated_lists_stay_distinct() {
        assert_eq!(parse("---\nname: reader\n---\nBody").unwrap(), None);
        for field in ["skills: []", "skills:"] {
            assert_eq!(
                parse(&format!("---\n{field}\n---\nBody")).unwrap(),
                Some(vec![])
            );
        }
        for field in [
            "skills: [user:review, plugin/review, user:review]",
            "skills:\n  - user:review\n  - 'plugin/review'\n  - user:review",
        ] {
            assert_eq!(
                parse(&format!("---\n{field}\n---\nBody")).unwrap(),
                Some(vec!["user:review".into(), "plugin/review".into()])
            );
        }
    }

    #[test]
    fn rejects_invalid_or_unbounded_ids() {
        for id in [
            "".to_string(),
            "bad id".into(),
            "x\npermission: auto".into(),
            "x,y".into(),
            "a".repeat(257),
        ] {
            assert!(normalize(&[id]).is_err());
        }
        assert!(normalize(&vec!["a".into(); 257]).is_err());
        assert!(normalize(&["a".repeat(256)]).is_ok());
    }
}
