use super::*;
use serde_json::json;

#[test]
fn persona_catalog_enforces_unicode_and_size_boundaries() {
    let id = format!("A{}", "-_0".repeat(21));
    let max = json!({"id":id, "name":"🦊".repeat(128), "prompt":"🦊".repeat(8192)});
    assert!(validate_catalog(&json!([max])).is_ok());
    assert!(
        validate_catalog(&json!([{"id":"p","name":"\u{0085}name","prompt":" Example "}])).is_ok()
    );
    let definitions = (0..32)
        .map(|i| json!({"id":format!("p{i}"),"name":"Persona","prompt":"Example"}))
        .collect::<Vec<_>>();
    assert!(validate_catalog(&json!(definitions)).is_ok());
    let mut too_many = definitions;
    too_many.push(json!({"id":"p32","name":"Persona","prompt":"Example"}));
    assert!(validate_catalog(&json!(too_many)).is_err());
    for (key, invalid) in [
        ("id", json!("a".repeat(65))),
        ("id", json!("-abc")),
        ("id", json!("é")),
        ("name", json!("🦊".repeat(129))),
        ("name", json!(" leading")),
        ("name", json!("\u{feff}invisible prefix")),
        ("name", json!("")),
        ("prompt", json!("🦊".repeat(8193))),
        ("prompt", json!(" \n")),
        ("prompt", json!("\u{feff}")),
    ] {
        let mut definition = json!({"id":"p","name":"Persona","prompt":"Example"});
        definition[key] = invalid;
        assert!(validate_catalog(&json!([definition])).is_err(), "{key}");
    }
}

#[test]
fn persona_revision_hashes_canonical_definition_bytes() {
    let definition = json!({"prompt":"  One\n\"two\" 🦊\n", "name":"Unicode", "id":"p"});
    let parsed = catalog(&json!([definition])).unwrap();
    let canonical = "{\"id\":\"p\",\"name\":\"Unicode\",\"prompt\":\"  One\\n\\\"two\\\" 🦊\\n\"}";
    assert_eq!(serde_json::to_string(&parsed[0]).unwrap(), canonical);
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    db.set_setting("app", &json!({"personas":[definition]}))
        .unwrap();
    let selection = json!({"personaId":"p"});
    let snapshot = Selection::parse(&selection)
        .unwrap()
        .resolve(&db, None)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.revision, hex::encode(Sha256::digest(canonical)));
    assert_eq!(
        serde_json::to_value(snapshot.definition).unwrap(),
        definition
    );
}
