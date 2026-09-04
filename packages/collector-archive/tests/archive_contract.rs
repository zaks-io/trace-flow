use collector_archive::{
    scan_claude_jsonl, scan_claude_jsonl_part, scan_codex_jsonl, sha256, ArchiveChain,
    ArchiveError, ArchiveObservation, ArchiveSource, ChainElement, PayloadEncoding,
};
use collector_contracts::AgentSource;

const CLAUDE_FIXTURE: &[u8] = include_bytes!("fixtures/claude.jsonl");
const CODEX_FIXTURE: &[u8] = include_bytes!("fixtures/codex.jsonl");
const CLAUDE_PARENT_FIXTURE: &[u8] = include_bytes!("fixtures/claude-parent.jsonl");
const CLAUDE_SUBAGENT_FIXTURE: &[u8] = include_bytes!("fixtures/claude-subagent.jsonl");

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
fn exact_byte_fixtures_use_lf_record_delimiters() {
    for fixture in [
        CLAUDE_FIXTURE,
        CODEX_FIXTURE,
        CLAUDE_PARENT_FIXTURE,
        CLAUDE_SUBAGENT_FIXTURE,
    ] {
        assert!(!fixture
            .split(|byte| *byte == b'\n')
            .any(|line| line.ends_with(b"\r")));
    }
}

#[test]
fn jsonl_record_payload_excludes_only_the_line_terminator() {
    let raw = b"{\"uuid\":\"r1\",\"value\":1}\r\n";
    let scan = scan_claude_jsonl("session-1", raw, 10, None).unwrap();
    assert_eq!(
        scan.observations[0].payload_bytes().unwrap(),
        &raw[..raw.len() - 1]
    );
    assert_eq!(
        scan.observations[0].content_sha256,
        sha256(&raw[..raw.len() - 1])
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
fn payload_encoding_must_be_canonical_for_exact_bytes() {
    let observation =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"utf8")
            .unwrap();
    let mut wire = serde_json::to_value(&observation).unwrap();
    wire["payload_encoding"] = serde_json::json!("base64");
    wire["payload"] = serde_json::json!("dXRmOA==");
    let error = serde_json::from_value::<ArchiveObservation>(wire).unwrap_err();
    assert!(error.to_string().contains("canonical"));
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
fn claude_identity_namespaces_keep_stable_and_positional_records_distinct() {
    let scan = scan_claude_jsonl(
        "session-1",
        b"{\"content\":\"fallback\"}\n{\"uuid\":\"line\"}\n",
        10,
        None,
    )
    .unwrap();
    assert_ne!(
        scan.observations[0].source_record_identity,
        scan.observations[1].source_record_identity
    );
    assert!(scan.observations[0]
        .source_record_identity
        .ends_with(":claude:index:0"));
    assert!(scan.observations[1]
        .source_record_identity
        .ends_with(":claude:id:line:0"));
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
fn second_collector_can_dedupe_an_unchanged_scan_without_prefix_proof() {
    let bytes = b"{\"uuid\":\"r1\",\"value\":1}\n";
    let first = scan_claude_jsonl("session-1", bytes, 10, None).unwrap();
    let second = scan_claude_jsonl("session-1", bytes, 11, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&first).unwrap();

    let report = chain.commit_scan(&second).unwrap();
    assert_eq!(report.appended_records, 0);
    assert!(!report.appended_checkpoint);
    assert_eq!(chain.elements.len(), 2);

    let appended = b"{\"uuid\":\"r1\",\"value\":1}\n{\"uuid\":\"r2\"}\n";
    let second_append =
        scan_claude_jsonl("session-1", appended, 12, Some(&second.checkpoint)).unwrap();
    let second_append_report = chain.commit_scan(&second_append).unwrap();
    assert_eq!(second_append_report.appended_records, 1);
    assert!(second_append_report.appended_checkpoint);

    let stale_winner =
        scan_claude_jsonl("session-1", appended, 13, Some(&first.checkpoint)).unwrap();
    let stale_winner_report = chain.commit_scan(&stale_winner).unwrap();
    assert_eq!(stale_winner_report.appended_records, 0);
    assert!(!stale_winner_report.appended_checkpoint);

    let unproved_append = scan_claude_jsonl("session-1", b"{\"uuid\":\"r3\"}\n", 14, None).unwrap();
    assert!(matches!(
        chain.commit_scan(&unproved_append),
        Err(collector_archive::ChainError::MissingHistoricalPrefixProof)
    ));
}

#[test]
fn claude_parent_and_subagent_parts_have_independent_checkpoints_and_appends() {
    let parent = scan_claude_jsonl("session-1", CLAUDE_PARENT_FIXTURE, 10, None).unwrap();
    let subagent =
        scan_claude_jsonl_part("session-1", "agent-001", CLAUDE_SUBAGENT_FIXTURE, 10, None)
            .unwrap();
    assert_ne!(
        parent.checkpoint.source_transcript_part_id(),
        subagent.checkpoint.source_transcript_part_id()
    );
    assert_ne!(
        parent.observations[0].source_record_identity,
        subagent.observations[0].source_record_identity
    );
    assert!(!subagent.observations[0]
        .source_transcript_part_id()
        .contains("agent-001"));

    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&parent).unwrap();
    chain.commit_scan(&subagent).unwrap();

    let mut parent_bytes = CLAUDE_PARENT_FIXTURE.to_vec();
    parent_bytes.extend_from_slice(br#"{"content":"parent append"}"#);
    parent_bytes.push(b'\n');
    let parent_append = scan_claude_jsonl(
        "session-1",
        &parent_bytes,
        11,
        chain.latest_checkpoint_for_part(parent.checkpoint.source_transcript_part_id()),
    )
    .unwrap();
    let parent_report = chain.commit_scan(&parent_append).unwrap();
    assert_eq!(parent_report.appended_records, 1);
    assert!(parent_report.appended_checkpoint);

    let mut subagent_bytes = CLAUDE_SUBAGENT_FIXTURE.to_vec();
    subagent_bytes.extend_from_slice(br#"{"content":"subagent append"}"#);
    subagent_bytes.push(b'\n');
    let subagent_append = scan_claude_jsonl_part(
        "session-1",
        "agent-001",
        &subagent_bytes,
        11,
        chain.latest_checkpoint_for_part(subagent.checkpoint.source_transcript_part_id()),
    )
    .unwrap();
    let subagent_report = chain.commit_scan(&subagent_append).unwrap();
    assert_eq!(subagent_report.appended_records, 1);
    assert!(subagent_report.appended_checkpoint);
    chain.verify().unwrap();
}

#[test]
fn transcript_part_digest_must_use_lowercase_hex() {
    let scan = scan_claude_jsonl_part("session-1", "agent-001", CLAUDE_SUBAGENT_FIXTURE, 10, None)
        .unwrap();
    let mut wire = serde_json::to_value(&scan.checkpoint).unwrap();
    wire["source_transcript_part_id"] =
        serde_json::json!(format!("claude:part:sha256:{}", "A".repeat(64)));
    assert!(serde_json::from_value::<collector_archive::CompletedScanCheckpoint>(wire).is_err());
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
    let observation =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"x").unwrap();
    for field in ["archive_format_version", "chain_hash_version"] {
        let mut observation_wire = serde_json::to_value(&observation).unwrap();
        observation_wire[field] = serde_json::json!(99);
        let error = serde_json::from_value::<ArchiveObservation>(observation_wire).unwrap_err();
        assert!(error.to_string().contains("version 99"));
    }

    let checkpoint = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None)
        .unwrap()
        .checkpoint;
    for field in ["archive_format_version", "chain_hash_version"] {
        let mut checkpoint_wire = serde_json::to_value(&checkpoint).unwrap();
        checkpoint_wire[field] = serde_json::json!(99);
        let error =
            serde_json::from_value::<collector_archive::CompletedScanCheckpoint>(checkpoint_wire)
                .unwrap_err();
        assert!(error.to_string().contains("version 99"));
    }

    assert!(matches!(
        ArchiveObservation::new(
            ArchiveSource::Claude,
            "/Users/example/session",
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
    for field in ["archive_format_version", "chain_hash_version"] {
        let mut checkpoint_wire = serde_json::to_value(&chain.elements[1]).unwrap();
        checkpoint_wire[field] = serde_json::json!(99);
        let error = ArchiveChain::from_jsonl(
            ArchiveSource::Claude,
            "session-1",
            &serde_json::to_vec(&checkpoint_wire).unwrap(),
        )
        .unwrap_err();
        match error {
            collector_archive::ChainError::Archive(ArchiveError::Serialization(error)) => {
                assert!(error.to_string().contains("version 99"));
            }
            other => panic!("unexpected chain parse error: {other:?}"),
        }
    }
}

#[test]
fn modifying_inserting_or_reordering_chain_elements_breaks_verification() {
    let first = ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"one")
        .unwrap();
    let second =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-2", 10, b"two")
            .unwrap();
    let third =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-3", 10, b"three")
            .unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_observation(&first).unwrap();
    chain.commit_observation(&second).unwrap();
    chain.commit_observation(&third).unwrap();
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

    let committed_head = chain.chain_head();
    let committed_count = chain.elements.len();
    // A suffix deletion leaves a self-consistent prefix. Detection requires the
    // externally committed head or element count.
    let mut suffix_removed = chain.clone();
    suffix_removed.elements.pop();
    suffix_removed.verify().unwrap();
    assert_ne!(suffix_removed.chain_head(), committed_head);
    assert_ne!(suffix_removed.elements.len(), committed_count);

    // A middle deletion breaks the next element's previous-chain link.
    let mut middle_removed = chain.clone();
    middle_removed.elements.remove(1);
    assert!(middle_removed.verify().is_err());
}
