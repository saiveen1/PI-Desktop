use super::notification_settings::tests::{invalid_preferences, preferences};
use super::*;

#[tokio::test]
async fn notification_settings_roundtrip_and_missing_patch_preserves_saved_values() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    handle_request(
        state.clone(),
        "settings.set",
        json!({"theme": "dark", "unrelated": {"keep": true}}),
        tx.clone(),
    )
    .await
    .unwrap();
    let legacy = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert!(legacy.get("notifications").is_none());
    handle_request(
        state.clone(),
        "settings.set",
        json!({"notifications": preferences()}),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({"theme": "light"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let saved = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(saved["notifications"], preferences());
    assert_eq!(saved["theme"], "light");
    assert_eq!(saved["unrelated"], json!({"keep": true}));
    drop(state);
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let reopened = handle_request(state, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(
        reopened, saved,
        "preferences survive reopening an existing profile"
    );
}

#[tokio::test]
async fn notification_settings_invalid_write_never_replaces_valid_settings() {
    let directory = tempfile::tempdir().unwrap();
    let mut app = AppState::open(directory.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    let tx = mpsc::unbounded_channel().0;
    handle_request(
        state.clone(),
        "settings.set",
        json!({"notifications": preferences(), "theme": "dark"}),
        tx.clone(),
    )
    .await
    .unwrap();
    let saved = state.lock().await.db.get_setting("app").unwrap().unwrap();
    for preferences in invalid_preferences() {
        let error = handle_request(
            state.clone(),
            "settings.set",
            json!({"notifications": preferences, "theme": "light"}),
            tx.clone(),
        )
        .await
        .expect_err("invalid preferences must fail before writing");
        assert_eq!(error.code, 1002);
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        assert_eq!(
            state.lock().await.db.get_setting("app").unwrap().unwrap(),
            saved
        );
    }
}
