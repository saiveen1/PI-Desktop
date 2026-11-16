//! A foreground workspace change must not erase background sessions' read evidence.
use super::*;

async fn tool(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    session: &str,
    name: &str,
    args: Value,
) -> Value {
    tokio::time::timeout(
        Duration::from_secs(5),
        handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId":session, "toolCallId":uuid::Uuid::new_v4().to_string(),
                "toolName":name, "args":args, "mode":"agent"
            }),
            tx.clone(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn workspace_navigation_preserves_session_edit_provenance() {
    for transition in ["same", "other", "clear", "invalid_remote"] {
        for following_tool in ["Read", "Grep"] {
            let data = tempfile::tempdir().unwrap();
            let project = tempfile::tempdir().unwrap();
            let foreground = tempfile::tempdir().unwrap();
            let original = "first\nsecond\nthird\n";
            std::fs::write(project.path().join("fixture.txt"), original).unwrap();
            std::fs::write(foreground.path().join("fixture.txt"), "foreground\n").unwrap();
            let mut app = AppState::open(data.path()).unwrap();
            app.handshook = true;
            let mut sessions = Vec::new();
            for title in ["background", "other-reader"] {
                let session = sessions::create_session(
                    &app.db,
                    Some(title.into()),
                    Some("agent".into()),
                    None,
                    None,
                    Some(project.path().to_string_lossy().into_owned()),
                )
                .unwrap();
                sessions::configure_session_with_thinking(
                    &app.db,
                    &session.id,
                    "agent",
                    None,
                    None,
                    None,
                    Some("auto"),
                )
                .unwrap();
                sessions.push(session.id);
            }
            let state = Arc::new(Mutex::new(app));
            let (tx, _rx) = mpsc::unbounded_channel();
            handle_request(
                state.clone(),
                "workspace.set",
                json!({"path":project.path()}),
                tx.clone(),
            )
            .await
            .unwrap();
            let read = tool(
                &state,
                &tx,
                &sessions[0],
                "Read",
                json!({"path":"fixture.txt"}),
            )
            .await;
            assert_eq!(read["ok"], true, "{read}");
            let tag = read["content"]["tag"].clone();
            let partial = tool(
                &state,
                &tx,
                &sessions[1],
                "Read",
                json!({"path":"fixture.txt", "limit":1}),
            )
            .await;
            assert_eq!(partial["ok"], true);
            match transition {
                "clear" => {
                    handle_request(state.clone(), "workspace.clear", json!({}), tx.clone())
                        .await
                        .unwrap();
                }
                "invalid_remote" => {
                    let path = format!("{}missing", crate::db::REMOTE_PROJECT_PREFIX);
                    assert!(handle_request(
                        state.clone(),
                        "workspace.set",
                        json!({"path":path}),
                        tx.clone()
                    )
                    .await
                    .is_err());
                }
                _ => {
                    let path = if transition == "same" {
                        project.path()
                    } else {
                        foreground.path()
                    };
                    handle_request(
                        state.clone(),
                        "workspace.set",
                        json!({"path":path}),
                        tx.clone(),
                    )
                    .await
                    .unwrap();
                }
            }
            // A later partial producer must add evidence, not replace the earlier full Read.
            let args = if following_tool == "Read" {
                json!({"path":"fixture.txt", "offset":0, "limit":1})
            } else {
                json!({"path":"fixture.txt", "pattern":"^first$"})
            };
            for session in &sessions {
                let result = tool(&state, &tx, session, following_tool, args.clone()).await;
                assert_eq!(result["ok"], true, "{result}");
            }
            let edit = json!({"path":"fixture.txt", "tag":tag, "ops":"PUT 3.=3:\n+THIRD"});
            let denied = tool(&state, &tx, &sessions[1], "Edit", edit.clone()).await;
            assert_eq!(denied["errorCode"], "EDIT_LINES_UNSEEN", "{denied}");
            assert_eq!(
                std::fs::read_to_string(project.path().join("fixture.txt")).unwrap(),
                original
            );
            let edited = tool(&state, &tx, &sessions[0], "Edit", edit).await;
            assert_eq!(
                edited["ok"], true,
                "{transition}/{following_tool}: {edited}"
            );
            assert_eq!(
                std::fs::read_to_string(project.path().join("fixture.txt")).unwrap(),
                "first\nsecond\nTHIRD\n"
            );
            assert_eq!(
                std::fs::read_to_string(foreground.path().join("fixture.txt")).unwrap(),
                "foreground\n"
            );
            state.lock().await.shutdown();
        }
    }
}
