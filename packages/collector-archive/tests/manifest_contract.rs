use std::collections::BTreeMap;

use collector_archive::{
    scan_claude_jsonl, sha256, ArchiveChain, ArchiveSource, ChunkByteRange, ManifestElement,
    MAX_CHUNK_BYTES,
};

#[test]
fn manifest_is_deterministic_and_preserves_checkpoint_ranges() {
    let scan = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&scan).unwrap();
    let ranges = BTreeMap::from([
        (
            0,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 0,
                end: 20,
            },
        ),
        (
            1,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 20,
                end: 40,
            },
        ),
    ]);
    let manifest =
        collector_archive::ArchiveSessionManifest::from_chain(3, &chain, &ranges).unwrap();
    assert_eq!(manifest.elements().len(), 2);
    assert!(matches!(
        manifest.elements()[0],
        ManifestElement::Record { .. }
    ));
    assert_eq!(manifest.checkpoints().count(), 1);
    assert_eq!(manifest.to_bytes().unwrap(), manifest.to_bytes().unwrap());
    manifest.verify_against_chain(&chain).unwrap();

    let mut truncated = chain.clone();
    truncated.elements.pop();
    assert!(manifest.verify_against_chain(&truncated).is_err());
}

#[test]
fn manifest_rejects_ranges_outside_or_overlapping_a_chunk() {
    let scan = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&scan).unwrap();
    let out_of_bounds = BTreeMap::from([
        (
            0,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 0,
                end: MAX_CHUNK_BYTES + 1,
            },
        ),
        (
            1,
            ChunkByteRange {
                chunk_id: "chunk-001".to_string(),
                start: 0,
                end: 20,
            },
        ),
    ]);
    assert!(
        collector_archive::ArchiveSessionManifest::from_chain(1, &chain, &out_of_bounds).is_err()
    );

    let overlapping = BTreeMap::from([
        (
            0,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 0,
                end: 20,
            },
        ),
        (
            1,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 10,
                end: 30,
            },
        ),
    ]);
    assert!(
        collector_archive::ArchiveSessionManifest::from_chain(1, &chain, &overlapping).is_err()
    );
}

#[test]
fn manifest_wire_rejects_unsupported_versions_during_deserialization() {
    let scan = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&scan).unwrap();
    let ranges = BTreeMap::from([
        (
            0,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 0,
                end: 20,
            },
        ),
        (
            1,
            ChunkByteRange {
                chunk_id: "chunk-000".to_string(),
                start: 20,
                end: 40,
            },
        ),
    ]);
    let manifest =
        collector_archive::ArchiveSessionManifest::from_chain(1, &chain, &ranges).unwrap();
    for field in ["archive_format_version", "chain_hash_version"] {
        let mut wire = serde_json::to_value(&manifest).unwrap();
        wire[field] = serde_json::json!(99);
        let result = serde_json::from_value::<collector_archive::ArchiveSessionManifest>(wire);
        assert!(matches!(
            result,
            Err(error) if error.to_string().contains("version 99")
        ));
    }

    let mut wrong_count = serde_json::to_value(&manifest).unwrap();
    wrong_count["element_count"] = serde_json::json!(1);
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(wrong_count).is_err()
    );

    let mut wrong_sequence = serde_json::to_value(&manifest).unwrap();
    wrong_sequence["elements"][0]["chain_sequence"] = serde_json::json!(1);
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(wrong_sequence)
            .is_err()
    );

    let mut non_contiguous_sequence = serde_json::to_value(&manifest).unwrap();
    non_contiguous_sequence["elements"][1]["chain_sequence"] = serde_json::json!(3);
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(
            non_contiguous_sequence
        )
        .is_err()
    );

    let mut top_level_session = serde_json::to_value(&manifest).unwrap();
    top_level_session["source_session_id"] = serde_json::json!("other-session");
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(top_level_session)
            .is_err()
    );

    let mut nested_session = serde_json::to_value(&manifest).unwrap();
    nested_session["elements"][1]["checkpoint"]["source_session_id"] =
        serde_json::json!("other-session");
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(nested_session)
            .is_err()
    );

    let mut coordinated_session = serde_json::to_value(&manifest).unwrap();
    coordinated_session["source_session_id"] = serde_json::json!("other-session");
    coordinated_session["elements"][1]["checkpoint"]["source_session_id"] =
        serde_json::json!("other-session");
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(coordinated_session)
            .is_err()
    );

    let mut nested_source = serde_json::to_value(&manifest).unwrap();
    nested_source["elements"][1]["checkpoint"]["source"] = serde_json::json!("codex");
    nested_source["elements"][1]["checkpoint"]["source_transcript_part_id"] =
        serde_json::json!("codex:part:primary");
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(nested_source).is_err()
    );

    let mut non_empty_chain_head = serde_json::to_value(&manifest).unwrap();
    non_empty_chain_head["chain_head"] = serde_json::to_value(sha256(b"wrong")).unwrap();
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(non_empty_chain_head)
            .is_err()
    );

    let empty_chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    let empty_manifest =
        collector_archive::ArchiveSessionManifest::from_chain(1, &empty_chain, &BTreeMap::new())
            .unwrap();
    let mut empty_chain_head = serde_json::to_value(&empty_manifest).unwrap();
    empty_chain_head["chain_head"] = serde_json::to_value(sha256(b"wrong")).unwrap();
    assert!(
        serde_json::from_value::<collector_archive::ArchiveSessionManifest>(empty_chain_head)
            .is_err()
    );
}
