use base64::Engine;
use collector_archive::{scan_source_bytes, ArchiveChain, ArchiveSource};

#[test]
fn raw_byte_contract_matches_typescript_golden() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/archive-byte-session.json")).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(fixture["source_base64"].as_str().unwrap())
        .unwrap();
    let scan = scan_source_bytes(
        ArchiveSource::Codex,
        "bytes-fixture",
        "codex:part:primary",
        &bytes,
        10,
        None,
    )
    .unwrap();
    let request = scan.clone().into_upload_request(&bytes).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), fixture["upload"]);
    let mut chain = ArchiveChain::new(ArchiveSource::Codex, "bytes-fixture").unwrap();
    chain.commit_scan(&scan).unwrap();
    chain.verify().unwrap();
    let elements: Vec<serde_json::Value> = chain
        .to_jsonl()
        .unwrap()
        .split(|b| *b == b'\n')
        .filter(|b| !b.is_empty())
        .map(|b| serde_json::from_slice(b).unwrap())
        .collect();
    assert_eq!(elements[0]["chain_hash"], fixture["record_chain_hash"]);
    assert_eq!(elements[1]["chain_hash"], fixture["checkpoint_chain_hash"]);
}

#[test]
fn streaming_capture_preserves_all_bytes_with_bounded_segments() {
    use collector_archive::{SourceByteReader, MAX_BYTE_SEGMENT_BYTES};
    use std::io::Cursor;
    let bytes: Vec<u8> = (0..MAX_BYTE_SEGMENT_BYTES * 5 + 17)
        .map(|i| (i % 256) as u8)
        .collect();
    let mut reader = SourceByteReader::new(
        Cursor::new(&bytes),
        ArchiveSource::Codex,
        "stream",
        "codex:part:primary",
        10,
        None,
    )
    .unwrap();
    let mut restored = Vec::new();
    let mut chain = ArchiveChain::new(ArchiveSource::Codex, "stream").unwrap();
    while let Some(scan) = reader.next_segment().unwrap() {
        let payload = scan.observations[0].payload_bytes().unwrap();
        assert!(payload.len() <= MAX_BYTE_SEGMENT_BYTES);
        restored.extend(payload);
        chain.commit_scan(&scan).unwrap();
    }
    assert_eq!(restored, bytes);
    chain.verify().unwrap();
    assert_eq!(
        chain.latest_checkpoint().unwrap().complete_prefix_sha256,
        collector_archive::sha256(&bytes)
    );
    let checkpoint = chain.latest_checkpoint().unwrap();
    let mut shortened = bytes.clone();
    shortened.pop();
    assert!(matches!(
        SourceByteReader::new(
            Cursor::new(&shortened),
            ArchiveSource::Codex,
            "stream",
            "codex:part:primary",
            11,
            Some(checkpoint)
        ),
        Err(collector_archive::JsonlError::HistoricalPrefixShortened)
    ));
    let mut changed = bytes;
    changed[0] ^= 1;
    assert!(matches!(
        SourceByteReader::new(
            Cursor::new(&changed),
            ArchiveSource::Codex,
            "stream",
            "codex:part:primary",
            11,
            Some(checkpoint)
        ),
        Err(collector_archive::JsonlError::HistoricalPrefixChanged)
    ));
}

#[test]
fn shrinkage_beyond_captured_offset_still_starts_a_new_generation() {
    let bytes = vec![b'x'; collector_archive::MAX_BYTE_SEGMENT_BYTES + 100];
    let first = collector_archive::scan_source_bytes(
        collector_archive::ArchiveSource::Codex,
        "shrink",
        "codex:part:primary",
        &bytes,
        1,
        None,
    )
    .unwrap();
    assert_eq!(first.checkpoint.observed_file_size, bytes.len() as u64);
    assert!(matches!(
        collector_archive::scan_source_bytes(
            collector_archive::ArchiveSource::Codex,
            "shrink",
            "codex:part:primary",
            &bytes[..bytes.len() - 1],
            2,
            Some(&first.checkpoint),
        ),
        Err(collector_archive::JsonlError::HistoricalPrefixShortened)
    ));
}
