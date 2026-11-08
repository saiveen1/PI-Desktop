use super::*;
fn entry(revision: u64) -> Value {
    let model = json!({"providerId":"p","modelId":"m","providerName":"Provider","priority":1,"approval":"ask","apiKey":"must-not-persist"});
    json!({"request":{"sessionId":"s","requestId":"r","revision":revision,"status":"approved",
        "createdAt":"2026-11-05T12:00:00.000Z","expiresAt":"2026-11-05T12:01:00.000Z","task":"Review",
        "candidate":model,"candidates":[model],"headers":{"Authorization":"secret"}},"settledAt":"2026-11-05T12:00:01.000Z"})
}
#[test]
fn durable_receipts_revision_read_clear_and_compatibility() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(list(&db).unwrap(), json!({"entries":[]}));
    record(&db, &entry(4)).unwrap();
    mark_read(&db, &json!({"sessionId":"s","requestId":"r"})).unwrap();
    let first = list(&db).unwrap();
    assert!(first["entries"][0]["readAt"].is_string());
    assert!(!first.to_string().contains("secret"));
    assert!(!first.to_string().contains("apiKey"));
    record(&db, &entry(3)).unwrap();
    record(&db, &entry(4)).unwrap();
    assert_eq!(list(&db).unwrap(), first);
    record(&db, &entry(5)).unwrap();
    assert_eq!(
        list(&db).unwrap()["entries"][0]["readAt"],
        first["entries"][0]["readAt"]
    );
    assert!(mark_read(&db, &json!({"sessionId":"s"})).is_err());
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(list(&db).unwrap()["entries"][0]["request"]["revision"], 5);
    db.kv_set("settings", "consent", &json!({"approval":"ask"}))
        .unwrap();
    clear(&db).unwrap();
    assert_eq!(
        db.kv_get("settings", "consent").unwrap(),
        Some(json!({"approval":"ask"}))
    );
    assert_eq!(list(&db).unwrap()["entries"], json!([]));
    let mut pending = entry(6);
    pending["request"]["status"] = json!("pending");
    assert!(record(&db, &pending).is_err());
}
#[test]
fn receipts_are_bounded_and_identity_is_session_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    for i in 0..205 {
        let mut row = entry(1);
        row["request"]["sessionId"] = json!(format!("s{i}"));
        record(&db, &row).unwrap();
    }
    assert_eq!(list(&db).unwrap()["entries"].as_array().unwrap().len(), 200);
}
