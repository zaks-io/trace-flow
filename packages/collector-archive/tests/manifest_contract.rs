use std::collections::BTreeMap;

use collector_archive::{
    scan_claude_jsonl, ArchiveChain, ArchiveSource, ChunkByteRange, ManifestElement,
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
    assert_eq!(manifest.elements.len(), 2);
    assert!(matches!(
        manifest.elements[0],
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
