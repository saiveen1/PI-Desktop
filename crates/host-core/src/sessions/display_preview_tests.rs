use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

fn tool_record(result: Value) -> MessageRecord {
    MessageRecord {
        id: "image-read".into(),
        role: "tool".into(),
        tool_name: Some("Read".into()),
        is_error: false,
        blocks: json!([{"type":"tool_call", "name":"Read", "callId":"read-1", "result":result}]),
        meta: None,
        created_at: "2026-11-12T00:00:00Z".into(),
    }
}

fn read_result(bytes: usize, path: Option<&str>) -> Value {
    let data = STANDARD.encode(vec![42; bytes]);
    let image = json!({"type":"image", "data":data, "mimeType":"image/png"});
    let mut result = json!({
        "content":[{"type":"text", "text":"image read"}, image],
        "details":{"images":[image], "imageInput":{"imageCount":1,"includedCount":1,"issues":[]}}
    });
    if let Some(path) = path {
        result["details"]["path"] = json!(path);
    }
    result
}

#[test]
fn bounded_image_preview_preserves_read_identity_without_clipping_binary() {
    for bytes in [31_929, 7_255, 37_395, 29_152] {
        let result = read_result(bytes, Some("screenshots/page.png"));
        let record = tool_record(result.clone());
        let display = record_to_ui_for_display(record.clone(), 65_536)
            .tool_result
            .unwrap();
        let image = &display["details"]["images"][0];
        assert_eq!(image["mimeType"], "image/png", "{bytes}-byte image");
        assert_eq!(image["path"], "screenshots/page.png");
        assert_eq!(
            image["data"], result["details"]["images"][0]["data"],
            "history must not reread a deleted or changed source file"
        );
        assert!(serde_json::to_string(&display).unwrap().len() < 66_000);
        assert_eq!(
            display["details"]["imageInput"],
            result["details"]["imageInput"]
        );
        assert_eq!(record_to_ui(record).tool_result.unwrap(), result);
    }
}

#[test]
fn bounded_image_preview_inline_is_atomic_and_display_omission_is_not_input_rejection() {
    let result = read_result(80_000, None);
    let display = record_to_ui_for_display(tool_record(result.clone()), 65_536)
        .tool_result
        .unwrap();
    let image = &display["details"]["images"][0];
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(image["displayImageOmitted"], true);
    assert!(image.get("data").is_none());
    assert_eq!(
        display["details"]["imageInput"],
        result["details"]["imageInput"]
    );
    assert!(serde_json::to_string(&display).unwrap().len() < 66_000);

    let small = read_result(31_929, None);
    let display = record_to_ui_for_display(tool_record(small.clone()), 65_536)
        .tool_result
        .unwrap();
    assert_eq!(
        display["details"]["images"][0]["data"],
        small["details"]["images"][0]["data"]
    );
    assert!(
        serde_json::to_string(&display).unwrap().len() < 66_000,
        "mirrors must share the bounded budget"
    );
}

#[test]
fn bounded_image_preview_keeps_mcp_generated_refs_and_invalid_input_diagnostics() {
    for raw in [
        json!({"kind":"generated-images", "images":[{"mimeType":"image/png", "path":"one.png"}, {"mimeType":"image/webp", "ref":"scratch/two.webp"}]}),
        json!({"details":{"blocks":[{"type":"image", "data":"YWJj", "mimeType":"image/png"}]}}),
        json!([{"type":"image", "data":"YWJj", "mimeType":"image/png"}]),
    ] {
        let display = record_to_ui_for_display(tool_record(raw.clone()), 65_536)
            .tool_result
            .unwrap();
        assert!(!serde_json::to_string(&display)
            .unwrap()
            .contains("_displayInlineImageIndex"));
        if raw.is_array() {
            assert_eq!(display, raw);
        } else if raw.get("kind").is_some() {
            assert_eq!(display["kind"], raw["kind"]);
            assert_eq!(display["images"][0]["path"], "one.png");
            assert_eq!(display["images"][1]["ref"], "scratch/two.webp");
        } else {
            assert_eq!(display, raw);
        }
    }
    for (mime, data) in [
        ("image/svg+xml", "YWJj"),
        ("image/png", "%%%"),
        ("image/png", ""),
        ("image/png", "a"),
    ] {
        let raw = json!({"images":[{"mimeType":mime,"data":data}]});
        let display = record_to_ui_for_display(tool_record(raw), 128)
            .tool_result
            .unwrap();
        assert_eq!(display["images"][0]["mimeType"], mime);
        assert_eq!(display["images"][0]["data"], "");
        assert!(display["images"][0].get("displayImageOmitted").is_none());
    }
    let raw = json!({"path":"safe.png", "images":[{"mimeType":"image/png", "ref":"https://example.invalid/a.png", "data":"YWJj"}]});
    let display = record_to_ui_for_display(tool_record(raw), 128)
        .tool_result
        .unwrap();
    assert!(display["images"][0].get("path").is_none());
    assert_eq!(display["images"][0]["data"], "YWJj");
}

#[test]
fn bounded_image_preview_keeps_multiple_identities_and_never_clips_refs() {
    let raw = json!({"images":[
        {"mimeType":"image/png", "data":STANDARD.encode(vec![42; 20_000])},
        {"mimeType":"image/webp", "data":STANDARD.encode(vec![43; 80_000])}
    ]});
    let display = record_to_ui_for_display(tool_record(raw.clone()), 65_536)
        .tool_result
        .unwrap();
    assert_eq!(display["images"][0]["data"], raw["images"][0]["data"]);
    assert_eq!(display["images"][1]["mimeType"], "image/webp");
    assert_eq!(display["images"][1]["displayImageOmitted"], true);
    for limit in [1, 4, 12, 32, 128, 512, 65_536] {
        let path = "a".repeat(1024);
        let raw = json!({"images":[{"mimeType":"image/png", "path":path}]});
        let display = record_to_ui_for_display(tool_record(raw), limit)
            .tool_result
            .unwrap();
        if let Some(projected) = display["images"][0].get("path") {
            assert_eq!(projected, &path);
        }
        assert!(!serde_json::to_string(&display)
            .unwrap()
            .contains("_displayInlineImageIndex"));
    }
    let raw = json!({"images":vec![json!({"mimeType":"image/png", "path":"a.png"}); 300]});
    let display = record_to_ui_for_display(tool_record(raw), 65_536)
        .tool_result
        .unwrap();
    assert_eq!(display["images"].as_array().unwrap().len(), 257);
}

#[test]
fn bounded_image_preview_session_restore_and_uncapped_history_remain_lossless() {
    let scratch = std::env::var_os("PI_SCRATCH_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = tempfile::tempdir_in(scratch).unwrap();
    let db_path = dir.path().join("test.sqlite");
    let db = Database::open(&db_path).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let result = read_result(80_000, Some("screenshots/page.png"));
    append_message(
        &db,
        &session.id,
        &record_to_ui(tool_record(result.clone())),
        None,
    )
    .unwrap();
    let page = get_session_with_options(
        &db,
        &session.id,
        SessionReadOptions {
            message_around: None,
            message_before: None,
            message_limit: Some(1),
            content_limit: Some(65_536),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        page.messages[0].tool_result.as_ref().unwrap()["details"]["images"][0]["path"],
        "screenshots/page.png"
    );
    assert_eq!(
        get_session(&db, &session.id).unwrap().unwrap().messages[0]
            .tool_result
            .as_ref()
            .unwrap(),
        &result
    );
    drop(db);
    let reopened = Database::open(&db_path).unwrap();
    assert_eq!(
        get_session(&reopened, &session.id)
            .unwrap()
            .unwrap()
            .messages[0]
            .tool_result
            .as_ref()
            .unwrap(),
        &result
    );
}

#[test]
fn bounded_image_preview_nested_untrusted_fields_do_not_bypass_the_budget() {
    let raw = json!({"images":[{"type":"image", "mimeType":"image/png",
        "data":{"nested":vec![0; 100_000]}, "extra":vec![0; 100_000]}]});
    let display = record_to_ui_for_display(tool_record(raw), 512)
        .tool_result
        .unwrap();
    assert!(serde_json::to_string(&display).unwrap().len() < 1024);
    assert!(display["images"][0]["data"].is_null());
    assert!(display["images"][0].get("extra").is_none());
}
