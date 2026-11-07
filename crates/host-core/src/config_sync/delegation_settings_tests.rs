use super::*;

#[test]
fn unknown_upstream_recovery_sync_roundtrips_and_rejects_invalid_imports() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let (header, key) = create_vault("fixture-password", "fixture-vault")?;
    let mut config = config_from_input(
        None,
        &json!({"endpoint": "https://s3.example.test", "region": "us-east-1",
            "bucket": "fixture-bucket", "accessKeyId": "fixture-access", "deviceLabel": "Test"}),
        header,
    )?;
    let bundle = PendingBundle {
        manifest: empty_manifest(),
        local_before: None,
        resources: BTreeMap::new(),
        approvals: Vec::new(),
        conflicts: Vec::new(),
        journal_state: "staged".into(),
        remote_revision_id: "fixture-revision".into(),
    };
    let application = |payload| PortableEntity {
        domain: domains::DOMAIN_APPLICATION.into(),
        entity_id: "application".into(),
        label: "Application preferences".into(),
        deleted: false,
        requires_approval: false,
        secret_bearing: false,
        mapping_required: false,
        digest: "fixture-digest".into(),
        payload,
        resource_ids: Vec::new(),
    };
    let mut categories = CategorySelection::all_selected();
    for domain in domains::ALL_DOMAINS {
        categories
            .0
            .insert(domain.into(), domain == domains::DOMAIN_APPLICATION);
    }
    for limit in 0..=3 {
        state.db.set_setting(
            "app",
            &json!({"theme": "dark", "infiniteProviderRetry": true,
                "unknownUpstreamRetryLimit": limit, "notifications": {"version": 1, "enabled": false}}),
        )?;
        let snapshot = domains::capture(
            &mut state,
            &key,
            &categories,
            false,
            &BTreeMap::new(),
            &domains::ProjectIdentityOverrides::default(),
        )?;
        let captured = snapshot
            .manifest
            .entities
            .iter()
            .find(|entity| entity.domain == domains::DOMAIN_APPLICATION)
            .unwrap();
        assert_eq!(captured.payload["unknownUpstreamRetryLimit"], limit);
        assert!(captured.payload.get("notifications").is_none());
        state.db.set_setting("app", &json!({"theme": "light"}))?;
        apply_entity(&mut state, &mut config, &bundle, captured)?;
        let restored = state.db.get_setting("app")?.unwrap();
        assert_eq!(restored["unknownUpstreamRetryLimit"], limit);
        assert_eq!(restored["infiniteProviderRetry"], true);
    }
    let before = state.db.get_setting("app")?.unwrap();
    for invalid in [
        json!(null),
        json!(-1),
        json!(4),
        json!(1.5),
        json!("2"),
        json!(true),
        json!({}),
    ] {
        let error = apply_entity(
            &mut state,
            &mut config,
            &bundle,
            &application(json!({"theme": "light", "unknownUpstreamRetryLimit": invalid})),
        )
        .unwrap_err();
        assert!(error.to_string().contains("CONFIG_SYNC_INVALID"));
        assert_eq!(state.db.get_setting("app")?.unwrap(), before);
    }
    apply_entity(
        &mut state,
        &mut config,
        &bundle,
        &application(json!({"theme": "light"})),
    )?;
    assert!(state
        .db
        .get_setting("app")?
        .unwrap()
        .get("unknownUpstreamRetryLimit")
        .is_none());
    Ok(())
}

#[test]
fn delegation_settings_sync_keeps_local_cost_and_notification_settings_separate() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let (header, key) = create_vault("fixture-password", "fixture-vault")?;
    let mut config = config_from_input(
        None,
        &json!({"endpoint": "https://s3.example.test", "region": "us-east-1",
            "bucket": "fixture-bucket", "accessKeyId": "fixture-access", "deviceLabel": "Test"}),
        header,
    )?;
    let bundle = PendingBundle {
        manifest: empty_manifest(),
        local_before: None,
        resources: BTreeMap::new(),
        approvals: Vec::new(),
        conflicts: Vec::new(),
        journal_state: "staged".into(),
        remote_revision_id: "fixture-revision".into(),
    };
    let entity = |domain: &str, entity_id: &str, payload: Value| PortableEntity {
        domain: domain.into(),
        entity_id: entity_id.into(),
        label: "Fixture".into(),
        deleted: false,
        requires_approval: false,
        secret_bearing: false,
        mapping_required: false,
        digest: "fixture-digest".into(),
        payload,
        resource_ids: Vec::new(),
    };
    let mut categories = CategorySelection::all_selected();
    for domain in domains::ALL_DOMAINS {
        categories.0.insert(
            domain.into(),
            matches!(
                domain,
                domains::DOMAIN_APPLICATION | domains::DOMAIN_PROVIDERS
            ),
        );
    }
    for models in [
        json!([{"providerId": "provider-a", "modelId": "expensive", "enabled": true,
            "priority": 100, "approval": "ask", "description": "Keep explicit cost approval"}]),
        json!([]),
    ] {
        let notifications = json!({"version": 1, "enabled": false, "channel": "in-app",
            "sound": false, "delegation": {"repeatIntervalSeconds": 30}});
        let policy = json!({"version": 1, "approvalTimeoutSeconds": 0, "models": models});
        state.db.set_setting(
            "app",
            &json!({"delegation": policy, "notifications": notifications, "theme": "dark", "unrelated": "keep"}),
        )?;
        // Application imports must neither remove an omitted local policy nor
        // accept an unsynchronized permissive/null replacement from a peer.
        for remote in [
            json!({"theme": "light"}),
            json!({"theme": "light", "delegation": null, "notifications": null}),
            json!({"theme": "light", "notifications": {"version": 1, "enabled": true, "channel": "system"}, "delegation": {"version": 1,
                "approvalTimeoutSeconds": 300, "models": [{"providerId": "provider-a",
                    "modelId": "expensive", "enabled": true, "priority": 1,
                    "approval": "auto", "description": "Remote automatic permission"}]}}),
        ] {
            apply_entity(
                &mut state,
                &mut config,
                &bundle,
                &entity(domains::DOMAIN_APPLICATION, "application", remote),
            )?;
            let saved = state.db.get_setting("app")?.unwrap();
            assert_eq!(saved["delegation"], policy);
            assert_eq!(saved["notifications"], notifications);
            assert_eq!(saved["theme"], "light");
            assert_eq!(saved["unrelated"], "keep");
        }
        // Existing provider flags remain portable for older installations, but
        // repeated provider imports cannot recreate, append, or downgrade policy.
        for available in [true, false, true] {
            let provider = entity(
                domains::DOMAIN_PROVIDERS,
                "provider:provider-a",
                json!({
                    "id": "provider-a", "name": "Fixture provider", "authKind": "none",
                    "baseUrl": "https://provider.example.test/v1", "defaultModelId": "expensive",
                    "models": [{"id": "expensive", "availableForSubagents": available}]
                }),
            );
            apply_entity(&mut state, &mut config, &bundle, &provider)?;
            assert_eq!(state.db.get_setting("app")?.unwrap()["delegation"], policy);
            let snapshot = domains::capture(
                &mut state,
                &key,
                &categories,
                false,
                &BTreeMap::new(),
                &domains::ProjectIdentityOverrides::default(),
            )?;
            let application = snapshot
                .manifest
                .entities
                .iter()
                .find(|entity| entity.domain == domains::DOMAIN_APPLICATION)
                .unwrap();
            assert_eq!(application.payload, json!({"theme": "light"}));
            let provider = snapshot
                .manifest
                .entities
                .iter()
                .find(|entity| entity.entity_id == "provider:provider-a")
                .unwrap();
            assert_eq!(provider.payload["models"].as_array().unwrap().len(), 1);
            assert_eq!(
                provider.payload["models"][0]["availableForSubagents"],
                available
            );
            assert!(provider.payload.get("delegation").is_none());
        }
        let mut deletion = entity(domains::DOMAIN_APPLICATION, "application", json!({}));
        deletion.deleted = true;
        apply_entity(&mut state, &mut config, &bundle, &deletion)?;
        let saved = state.db.get_setting("app")?.unwrap();
        assert_eq!(saved["notifications"], notifications);
        assert_eq!(saved["delegation"], policy);
        assert!(saved.get("theme").is_none());
    }
    Ok(())
}
