//! Merge regressions at the public session.configure boundary.
use super::{checks, error_code, Harness};
use serde_json::{json, Value};

async fn saved(h: &Harness) -> (String, Option<String>, i64, Option<Value>) {
    let st = h.state.lock().await;
    let (mode, hash, updated) = st
        .db
        .conn()
        .query_row(
            "SELECT mode,mode_snapshot_hash,updated_at FROM sessions WHERE id=?1",
            [&h.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    (
        mode,
        hash,
        updated,
        st.db.kv_get("sessionDelegation", &h.session_id).unwrap(),
    )
}

#[tokio::test]
async fn configure_snapshot_and_delegation_together_preserves_omitted_and_null_semantics() {
    let h = Harness::new("agent");
    let configured = h
        .call(
            "session.configure",
            json!({
                "id":h.session_id,"mode":"checks","modeSnapshot":checks(),"fastMode":true,
                "delegationModelKeys":["p/m"],"delegationModelApprovals":{"p/m":"ask"}
            }),
        )
        .await
        .unwrap();
    assert_eq!(configured["session"]["delegationModelKeys"], json!(["p/m"]));
    assert_eq!(
        configured["session"]["delegationModelApprovals"],
        json!({"p/m":"ask"})
    );
    assert_eq!(configured["session"]["fastMode"], true);
    let first = saved(&h).await;
    assert!(first.1.is_some());

    // Omission preserves policy, including approval overrides.
    h.configure("checks", Some(checks())).await.unwrap();
    assert_eq!(saved(&h).await.3, first.3);
    h.call(
        "session.configure",
        json!({
            "id":h.session_id,"mode":"checks","modeSnapshot":checks(),
            "delegationModelApprovals":null
        }),
    )
    .await
    .unwrap();
    assert_eq!(saved(&h).await.3, Some(json!(["p/m"])));

    // A delegation-only edit keeps ordering; a new snapshot with the same id does not.
    {
        let st = h.state.lock().await;
        st.db
            .conn()
            .execute(
                "UPDATE sessions SET updated_at=1 WHERE id=?1",
                [&h.session_id],
            )
            .unwrap();
    }
    h.call(
        "session.configure",
        json!({
            "id":h.session_id,"mode":"checks","modeSnapshot":checks(),
            "delegationModelApprovals":{"p/m":"auto"}
        }),
    )
    .await
    .unwrap();
    assert_eq!(saved(&h).await.2, 1);
    let mut next = checks();
    next["prompt"] = json!("A new immutable definition");
    h.call(
        "session.configure",
        json!({
            "id":h.session_id,"mode":"checks","modeSnapshot":next,
            "delegationModelKeys":null
        }),
    )
    .await
    .unwrap();
    let changed = saved(&h).await;
    assert_ne!(changed.1, first.1);
    assert!(changed.2 > 1);
    assert!(changed.3.is_none());

    // Legacy public configurators remain callable, and clear the snapshot.
    let st = h.state.lock().await;
    crate::sessions::configure_session_with_delegation(
        &st.db,
        &h.session_id,
        "agent",
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let hash: Option<String> = st
        .db
        .conn()
        .query_row(
            "SELECT mode_snapshot_hash FROM sessions WHERE id=?1",
            [&h.session_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(hash.is_none());
}

#[tokio::test]
async fn configure_policy_failure_rolls_back_mode_snapshot_and_settings() {
    let h = Harness::new("agent");
    let original = saved(&h).await;
    {
        let st = h.state.lock().await;
        st.db.conn().execute_batch(
            "CREATE TRIGGER reject_delegation_insert BEFORE INSERT ON kv
             WHEN NEW.ns='sessionDelegation' BEGIN SELECT RAISE(ABORT,'policy write blocked'); END;"
        ).unwrap();
    }
    let failed = h
        .call(
            "session.configure",
            json!({
                "id":h.session_id,"mode":"checks","modeSnapshot":checks(),
                "permissionMode":"auto","fastMode":true,
                "delegationModelKeys":["p/m"],"delegationModelApprovals":{"p/m":"ask"}
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&failed), "INTERNAL");
    assert_eq!(saved(&h).await, original);
    {
        let st = h.state.lock().await;
        let settings: (String, bool) = st
            .db
            .conn()
            .query_row(
                "SELECT permission_mode,fast_mode FROM sessions WHERE id=?1",
                [&h.session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(settings, ("inherit".into(), false));
        st.db
            .conn()
            .execute_batch("DROP TRIGGER reject_delegation_insert;")
            .unwrap();
    }
    // Invalid approvals also cannot partially switch modes.
    let invalid = h
        .call(
            "session.configure",
            json!({
                "id":h.session_id,"mode":"checks","modeSnapshot":checks(),
                "delegationModelKeys":["p/m"],"delegationModelApprovals":{"p/other":"ask"}
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&invalid), "INVALID_PARAMS");
    assert_eq!(saved(&h).await, original);
    h.call(
        "session.configure",
        json!({
            "id":h.session_id,"mode":"checks","modeSnapshot":checks(),
            "delegationModelKeys":["p/m"],"delegationModelApprovals":{"p/m":"ask"}
        }),
    )
    .await
    .unwrap();
    assert!(saved(&h).await.1.is_some());
}
