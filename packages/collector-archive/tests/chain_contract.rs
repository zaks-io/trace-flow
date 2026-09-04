use collector_archive::{
    scan_claude_jsonl, ArchiveChain, ArchiveObservation, ArchiveSource, ChainElement, Sha256Digest,
    GENESIS_CHAIN_HASH,
};
use proptest::prelude::*;

#[test]
fn genesis_is_fixed_and_hash_framing_is_length_prefixed() {
    assert_eq!(GENESIS_CHAIN_HASH, Sha256Digest::from_bytes([0; 32]));
    let one = collector_archive::hash_framed(b"domain", &[b"a", b"bc"]);
    let two = collector_archive::hash_framed(b"domain", &[b"ab", b"c"]);
    assert_ne!(one, two);
}

#[test]
fn canonical_chain_jsonl_round_trips_and_preserves_raw_payload() {
    let raw = b"{ \"uuid\": \"r1\", \"value\": 1 }\n";
    let scan = scan_claude_jsonl("session-1", raw, 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&scan).unwrap();
    let encoded = chain.to_jsonl().unwrap();
    assert!(String::from_utf8_lossy(&encoded).contains("archive_format_version"));
    if let ChainElement::Record(record) = &chain.elements[0] {
        assert_eq!(record.payload.as_bytes(), &raw[..raw.len() - 1]);
        assert_eq!(
            record.content_sha256,
            collector_archive::sha256(&raw[..raw.len() - 1])
        );
    } else {
        panic!("first chain element must be a record");
    }
    assert_eq!(
        chain.elements[0].chain_hash().to_string(),
        "sha256:58ea3a56e8343e00e6b8cd483008bc428f74868de1abdcbe7d40b1d81239f35e"
    );
    assert_eq!(
        chain.elements[1].chain_hash().to_string(),
        "sha256:863a3b3f3dbc6cf68f89b9e49290b2983848f5041d57664c8d8d5924d3a0d9ed"
    );
    let restored = ArchiveChain::from_jsonl(ArchiveSource::Claude, "session-1", &encoded).unwrap();
    assert_eq!(restored, chain);
    chain.verify().unwrap();
}

proptest! {
    #[test]
    fn arbitrary_payload_bytes_round_trip_without_reencoding(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
        let observation = ArchiveObservation::new(
            ArchiveSource::Claude,
            "session-1",
            "record-1",
            10,
            &bytes,
        ).unwrap();
        let expected_hash = collector_archive::sha256(&bytes);
        prop_assert_eq!(observation.payload_bytes().unwrap(), bytes);
        prop_assert_eq!(observation.content_sha256, expected_hash);
    }

    #[test]
    fn arbitrary_payload_mutations_fail_chain_verification(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
        let observation = ArchiveObservation::new(
            ArchiveSource::Claude,
            "session-1",
            "record-1",
            10,
            &bytes,
        ).unwrap();
        let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
        chain.commit_observation(&observation).unwrap();
        if let ChainElement::Record(record) = &mut chain.elements[0] {
            record.payload.push('x');
        }
        prop_assert!(chain.verify().is_err());
    }
}
