use collector_archive::{
    scan_claude_jsonl, scan_codex_jsonl, ArchiveChain, ArchiveError, ArchiveObservation,
    ArchiveSource, ChainElement, PayloadEncoding,
};
use collector_contracts::AgentSource;

const CLAUDE_FIXTURE: &[u8] = include_bytes!("fixtures/claude.jsonl");
const CODEX_FIXTURE: &[u8] = include_bytes!("fixtures/codex.jsonl");

#[test]
fn claude_fixture_round_trips_exact_source_record_bytes() {
    let scan = scan_claude_jsonl("claude-session-001", CLAUDE_FIXTURE, 10, None).unwrap();
    let original = CLAUDE_FIXTURE
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let round_tripped = scan
        .observations
        .iter()
        .map(|observation| observation.payload_bytes().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(round_tripped, original);
}

#[test]
fn codex_fixture_round_trips_exact_source_record_bytes() {
    let scan = scan_codex_jsonl("codex-session-001", CODEX_FIXTURE, 10, None).unwrap();
    let original = CODEX_FIXTURE
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let round_tripped = scan
        .observations
        .iter()
        .map(|observation| observation.payload_bytes().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(round_tripped, original);
}

#[test]
fn jsonl_record_payload_excludes_only_the_line_terminator() {
    let raw = b"{\"uuid\":\"r1\",\"value\":1}\r\n";
    let scan = scan_claude_jsonl("session-1", raw, 10, None).unwrap();
    assert_eq!(
        scan.observations[0].payload_bytes().unwrap(),
        &raw[..raw.len() - 2]
    );
    assert_eq!(scan.checkpoint.last_complete_byte_offset, raw.len() as u64);
}

#[test]
fn non_utf8_payload_uses_base64_without_changing_content_hash() {
    let observation = ArchiveObservation::new(
        ArchiveSource::Claude,
        "session-1",
        "record-1",
        10,
        &[0xff, 0x00, b'a'],
    )
    .unwrap();
    assert_eq!(observation.payload_encoding, PayloadEncoding::Base64);
    assert_eq!(observation.payload_bytes().unwrap(), [0xff, 0x00, b'a']);
    observation.validate().unwrap();
}

#[test]
fn source_identity_is_part_of_the_record_scope_even_for_equal_payloads() {
    let first =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"same")
            .unwrap();
    let second =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-2", 10, b"same")
            .unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    assert!(chain.commit_observation(&first).unwrap());
    assert!(chain.commit_observation(&second).unwrap());
    assert_eq!(chain.elements.len(), 2);
}

#[test]
fn same_identity_and_hash_deduplicates_but_changed_content_is_retained() {
    let original =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"one")
            .unwrap();
    let changed =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 11, b"two")
            .unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    assert!(chain.commit_observation(&original).unwrap());
    assert!(!chain.commit_observation(&original).unwrap());
    assert!(chain.commit_observation(&changed).unwrap());
    assert_eq!(chain.elements.len(), 2);
    chain.verify().unwrap();
}

#[test]
fn a_rejected_scan_does_not_partially_advance_the_chain() {
    let scan = scan_claude_jsonl(
        "session-1",
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n",
        10,
        None,
    )
    .unwrap();
    let mut rejected = scan.clone();
    rejected.observations[1].content_sha256 = collector_archive::sha256(b"wrong");
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    assert!(chain.commit_scan(&rejected).is_err());
    assert!(chain.elements.is_empty());
}

#[test]
fn scans_deduplicate_unchanged_rescans_and_extend_on_append() {
    let first_bytes = b"{\"uuid\":\"r1\",\"value\":1}\n";
    let first = scan_claude_jsonl("session-1", first_bytes, 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    let first_report = chain.commit_scan(&first).unwrap();
    assert_eq!(first_report.appended_records, 1);
    assert!(first_report.appended_checkpoint);

    let unchanged =
        scan_claude_jsonl("session-1", first_bytes, 11, chain.latest_checkpoint()).unwrap();
    let unchanged_report = chain.commit_scan(&unchanged).unwrap();
    assert_eq!(unchanged_report.appended_records, 0);
    assert!(!unchanged_report.appended_checkpoint);

    let partial = b"{\"uuid\":\"r1\",\"value\":1}\n{\"uuid\":\"partial";
    let partial_scan =
        scan_claude_jsonl("session-1", partial, 12, chain.latest_checkpoint()).unwrap();
    let partial_report = chain.commit_scan(&partial_scan).unwrap();
    assert_eq!(partial_report.appended_records, 0);
    assert!(!partial_report.appended_checkpoint);

    let appended_bytes = b"{\"uuid\":\"r1\",\"value\":1}\n{\"uuid\":\"r2\",\"value\":2}\n";
    let appended =
        scan_claude_jsonl("session-1", appended_bytes, 12, chain.latest_checkpoint()).unwrap();
    let appended_report = chain.commit_scan(&appended).unwrap();
    assert_eq!(appended_report.appended_records, 1);
    assert!(appended_report.appended_checkpoint);
    assert_eq!(chain.elements.len(), 4);
    chain.verify().unwrap();
}

#[test]
fn trailing_partial_is_excluded_then_becomes_a_record_when_completed() {
    let partial = b"{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"";
    let first = scan_claude_jsonl("session-1", partial, 10, None).unwrap();
    assert_eq!(first.observations.len(), 1);
    assert_eq!(first.checkpoint.last_complete_byte_offset, 14);

    let completed = b"{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n";
    let second = scan_claude_jsonl("session-1", completed, 11, Some(&first.checkpoint)).unwrap();
    assert_eq!(second.observations.len(), 2);
    assert_eq!(
        second.checkpoint.last_complete_byte_offset,
        completed.len() as u64
    );
}

#[test]
fn changed_or_shortened_historical_prefix_fails_loud() {
    let original = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None).unwrap();
    let changed = scan_claude_jsonl(
        "session-1",
        b"{\"uuid\":\"rX\"}\n{\"uuid\":\"r2\"}\n",
        11,
        Some(&original.checkpoint),
    );
    assert!(matches!(
        changed,
        Err(collector_archive::JsonlError::HistoricalPrefixChanged)
    ));

    let shortened = scan_claude_jsonl("session-1", b"{}", 11, Some(&original.checkpoint));
    assert!(matches!(
        shortened,
        Err(collector_archive::JsonlError::HistoricalPrefixShortened)
    ));
}

#[test]
fn malformed_complete_records_are_not_silently_skipped() {
    let result = scan_codex_jsonl("session-1", b"{\"a\":1}\nnot-json\n", 10, None);
    assert!(matches!(
        result,
        Err(collector_archive::JsonlError::Archive(
            ArchiveError::InvalidJsonlRecord { offset: 8 }
        ))
    ));
}

#[test]
fn cursor_is_rejected_as_an_unsupported_archive_source() {
    assert!(matches!(
        ArchiveSource::try_from(AgentSource::Cursor),
        Err(ArchiveError::UnsupportedSource("cursor"))
    ));
}

#[test]
fn unsupported_versions_and_private_paths_are_rejected() {
    let mut observation =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"x").unwrap();
    observation.archive_format_version = 99;
    assert!(matches!(
        observation.validate(),
        Err(ArchiveError::UnsupportedArchiveFormatVersion(99))
    ));
    assert!(matches!(
        ArchiveObservation::new(
            ArchiveSource::Claude,
            "/Users/isaac/session",
            "record-1",
            10,
            b"x"
        ),
        Err(ArchiveError::InvalidIdentifier {
            field: "source_session_id"
        })
    ));

    let scan = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&scan).unwrap();
    if let ChainElement::Checkpoint(checkpoint) = &mut chain.elements[1] {
        checkpoint.archive_format_version = 99;
    }
    assert!(matches!(
        chain.verify(),
        Err(collector_archive::ChainError::Archive(
            ArchiveError::UnsupportedArchiveFormatVersion(99)
        ))
    ));
}

#[test]
fn modifying_inserting_or_reordering_chain_elements_breaks_verification() {
    let first = ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"one")
        .unwrap();
    let second =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-2", 10, b"two")
            .unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_observation(&first).unwrap();
    chain.commit_observation(&second).unwrap();
    let clean = chain.clone();
    clean.verify().unwrap();

    let mut modified = chain.clone();
    if let ChainElement::Record(record) = &mut modified.elements[1] {
        record.payload = "changed".to_string();
    }
    assert!(modified.verify().is_err());

    let mut reordered = chain.clone();
    reordered.elements.swap(0, 1);
    assert!(reordered.verify().is_err());

    let mut inserted = chain.clone();
    inserted.elements.insert(1, chain.elements[0].clone());
    assert!(inserted.verify().is_err());
}
