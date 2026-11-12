//! Bounded, read-only transcript projections. Binary image values are atomic:
//! metadata is budgeted first, then complete inline payloads may use the remainder.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const DISPLAY_TRUNCATION_MARKER: &str =
    "\n\n[truncated for display; the full content remains in the transcript]";
const INLINE_INDEX: &str = "_displayInlineImageIndex";
const PRIORITY: &[&str] = &[
    "details",
    "imageInput",
    "kind",
    "type",
    "mimeType",
    "path",
    "ref",
    INLINE_INDEX,
    "displayImageOmitted",
    "images",
    "blocks",
    "content",
];

pub(super) fn truncate_display_text(text: String, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text, false);
    }
    let marker_len = DISPLAY_TRUNCATION_MARKER.chars().count();
    if limit <= marker_len {
        return (
            DISPLAY_TRUNCATION_MARKER.chars().take(limit).collect(),
            true,
        );
    }
    let head = limit - marker_len;
    (
        format!(
            "{}{}",
            text.chars().take(head).collect::<String>(),
            DISPLAY_TRUNCATION_MARKER
        ),
        true,
    )
}

fn ordered(mut object: Map<String, Value>) -> Vec<(String, Value)> {
    let mut entries = Vec::with_capacity(object.len().min(256));
    for key in PRIORITY {
        if let Some(value) = object.remove(*key) {
            entries.push(((*key).into(), value));
        }
    }
    entries.extend(
        object
            .into_iter()
            .take(256usize.saturating_sub(entries.len())),
    );
    entries
}

fn walk(value: Value, budget: &mut usize, image_safe: bool) -> Value {
    if *budget == 0 {
        return Value::String("[truncated for display]".into());
    }
    match value {
        Value::String(text) => {
            let (clipped, _) = truncate_display_text(text, *budget);
            *budget = budget.saturating_sub(clipped.chars().count());
            Value::String(clipped)
        }
        Value::Array(items) => {
            let mut output = Vec::with_capacity(items.len().min(32));
            for item in items {
                if *budget == 0 || output.len() >= 256 {
                    output.push(Value::String("[truncated for display]".into()));
                    break;
                }
                output.push(walk(item, budget, image_safe));
            }
            Value::Array(output)
        }
        Value::Object(object) => {
            let mut output = Map::new();
            let count = object.len();
            let entries = if image_safe {
                ordered(object)
            } else {
                object.into_iter().collect()
            };
            for (key, item) in entries {
                if *budget == 0 || output.len() >= 256 {
                    output.insert("_truncated".into(), Value::Bool(true));
                    break;
                }
                // A clipped identity is not a different valid file or MIME type.
                if image_safe && matches!(key.as_str(), "mimeType" | "path" | "ref") {
                    if let Some(text) = item.as_str() {
                        let size = text.chars().count();
                        if size > *budget {
                            output.insert("_truncated".into(), Value::Bool(true));
                            continue;
                        }
                        *budget -= size;
                        output.insert(key, item);
                        continue;
                    }
                }
                output.insert(key, walk(item, budget, image_safe));
            }
            if count > 256 {
                output.insert("_truncated".into(), Value::Bool(true));
            }
            Value::Object(output)
        }
        other => other,
    }
}

pub(super) fn preview_value(value: Value, limit: usize) -> Value {
    walk(value, &mut limit.max(1), false)
}

fn raster_mime(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|mime| {
        matches!(
            mime.to_ascii_lowercase().as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
    })
}

fn local_ref(value: Option<&Value>) -> Option<&str> {
    let path = value?.as_str()?.trim();
    if path.is_empty()
        || path.contains("[truncated for display")
        || path.chars().any(char::is_control)
    {
        return None;
    }
    if let Some(colon) = path.find(':') {
        let drive = colon == 1
            && path.as_bytes()[0].is_ascii_alphabetic()
            && matches!(path.as_bytes().get(2), Some(b'/') | Some(b'\\'));
        if !drive {
            return None;
        }
    }
    Some(path)
}

fn valid_base64(data: &str) -> bool {
    let body = data.trim_end_matches('=');
    !body.is_empty()
        && data.len() % 4 != 1
        && data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn prepare(
    value: Value,
    pending: &mut Vec<Option<String>>,
    image_entry: bool,
    inherited: Option<&str>,
    depth: usize,
    nodes: &mut usize,
    limit: usize,
) -> Value {
    if depth >= 64 || *nodes == 0 {
        return Value::String("[truncated for display]".into());
    }
    *nodes -= 1;
    match value {
        Value::Array(items) => {
            let truncated = items.len() > 256;
            let mut output = Vec::with_capacity(items.len().min(32));
            for item in items.into_iter().take(256) {
                if *nodes == 0 {
                    output.push(Value::String("[truncated for display]".into()));
                    break;
                }
                output.push(prepare(
                    item,
                    pending,
                    image_entry,
                    inherited,
                    depth + 1,
                    nodes,
                    limit,
                ));
            }
            if truncated {
                output.push(Value::String("[truncated for display]".into()));
            }
            Value::Array(output)
        }
        Value::Object(mut object) => {
            object.remove(INLINE_INDEX);
            if image_entry || object.get("type").and_then(Value::as_str) == Some("image") {
                // A display descriptor carries only scalar image fields. Do not
                // let untrusted nested metadata bypass preparation's node/depth cap.
                object.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "type"
                            | "mimeType"
                            | "path"
                            | "ref"
                            | "data"
                            | "displayImageOmitted"
                            | "_truncated"
                    )
                });
                for value in object.values_mut() {
                    if !value.is_string() && !value.is_boolean() {
                        *value = Value::Null;
                    }
                }
                object
                    .entry("type")
                    .or_insert_with(|| Value::String("image".into()));
                if !object.contains_key("path") && !object.contains_key("ref") {
                    if let Some(path) = inherited {
                        object.insert("path".into(), Value::String(path.into()));
                    }
                }
                if let Some(data_value) = object.remove("data") {
                    let Value::String(data) = data_value else {
                        object.insert("data".into(), data_value);
                        return Value::Object(object);
                    };
                    if !raster_mime(object.get("mimeType")) || !valid_base64(&data) {
                        // Preserve rejection, not a clipped prefix that looks like bytes.
                        object.insert("data".into(), Value::String(String::new()));
                    } else {
                        let index = pending.len();
                        pending.push(Some(data));
                        object.insert(INLINE_INDEX.into(), Value::from(index));
                    }
                }
                return Value::Object(object);
            }
            let path = local_ref(object.get("path"))
                .or_else(|| local_ref(object.get("details").and_then(|value| value.get("path"))))
                .filter(|path| path.chars().count() <= limit)
                .map(str::to_owned);
            let truncated = object.len() > 256;
            let mut output = Map::new();
            for (key, item) in ordered(object) {
                if *nodes == 0 {
                    output.insert("_truncated".into(), Value::Bool(true));
                    break;
                }
                let images = key == "images";
                let single = item.as_array().is_some_and(|items| {
                    items.len() <= 256
                        && items
                            .iter()
                            .filter(|value| {
                                images && value.is_object()
                                    || value.get("type").and_then(Value::as_str) == Some("image")
                            })
                            .count()
                            == 1
                });
                let inherited = if single && matches!(key.as_str(), "images" | "blocks" | "content")
                {
                    path.as_deref()
                } else {
                    None
                };
                output.insert(
                    key,
                    prepare(item, pending, images, inherited, depth + 1, nodes, limit),
                );
            }
            if truncated {
                output.insert("_truncated".into(), Value::Bool(true));
            }
            Value::Object(output)
        }
        other => other,
    }
}

fn fill(
    value: Value,
    pending: &mut [Option<String>],
    budget: &mut usize,
    seen: &mut HashSet<[u8; 32]>,
) -> Option<Value> {
    match value {
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .filter_map(|item| fill(item, pending, budget, seen))
                .collect(),
        )),
        Value::Object(mut object) => {
            if let Some(index) = object.remove(INLINE_INDEX).and_then(|value| value.as_u64()) {
                if let Some(data) = pending.get_mut(index as usize).and_then(Option::take) {
                    let mut hash = Sha256::new();
                    hash.update(
                        object
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .as_bytes(),
                    );
                    hash.update(data.as_bytes());
                    let identity: [u8; 32] = hash.finalize().into();
                    if seen.contains(&identity) {
                        return None;
                    }
                    if object.get("mimeType").is_some() && data.len() <= *budget {
                        *budget -= data.len();
                        object.insert("data".into(), Value::String(data));
                        seen.insert(identity);
                    } else {
                        object.insert("displayImageOmitted".into(), Value::Bool(true));
                    }
                }
            }
            let mut output = Map::new();
            for (key, item) in ordered(object) {
                if let Some(item) = fill(item, pending, budget, seen) {
                    output.insert(key, item);
                }
            }
            Some(Value::Object(output))
        }
        other => Some(other),
    }
}

pub(super) fn preview_tool_result(value: Value, limit: usize) -> Value {
    let mut pending = Vec::new();
    let metadata = prepare(value, &mut pending, false, None, 0, &mut 4096, limit);
    let mut budget = limit.max(1);
    let metadata = walk(metadata, &mut budget, true);
    fill(metadata, &mut pending, &mut budget, &mut HashSet::new()).unwrap_or(Value::Null)
}
