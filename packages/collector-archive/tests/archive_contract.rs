use base64::Engine;
use collector_archive::{
    scan_claude_jsonl, scan_claude_jsonl_part, scan_codex_jsonl, sha256, ArchiveChain,
    ArchiveError, ArchiveObservation, ArchiveSource, ChainElement, CompletedScanCheckpoint,
    JsonlError, JsonlScan, PayloadEncoding,
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
fn sha256_digest_wire_requires_lowercase_hex() {
    let observation =
        ArchiveObservation::new(ArchiveSource::Claude, "session-1", "record-1", 10, b"x").unwrap();
    let mut observation_wire = serde_json::to_value(&observation).unwrap();
    let observation_digest = observation.content_sha256.to_string();
    observation_wire["content_sha256"] = serde_json::json!(format!(
        "sha256:{}",
        observation_digest["sha256:".len()..].to_ascii_uppercase()
    ));
    assert!(serde_json::from_value::<ArchiveObservation>(observation_wire).is_err());

    let checkpoint = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 10, None)
        .unwrap()
        .checkpoint;
    let mut checkpoint_wire = serde_json::to_value(&checkpoint).unwrap();
    let checkpoint_digest = checkpoint.complete_prefix_sha256.to_string();
    checkpoint_wire["complete_prefix_sha256"] = serde_json::json!(format!(
        "sha256:{}",
        checkpoint_digest["sha256:".len()..].to_ascii_uppercase()
    ));
    assert!(
        serde_json::from_value::<collector_archive::CompletedScanCheckpoint>(checkpoint_wire)
            .is_err()
    );
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
    assert_eq!(appended.observations.len(), 1);
    assert_eq!(appended.checkpoint.record_count, 2);
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
        Err(collector_archive::ChainError::CheckpointRegressed)
    ));
}

#[test]
fn a_shortened_source_observation_cannot_dedupe_an_existing_checkpoint() {
    let first = scan_claude_jsonl(
        "session-1",
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"partial",
        10,
        None,
    )
    .unwrap();
    let shortened = scan_claude_jsonl("session-1", b"{\"uuid\":\"r1\"}\n", 11, None).unwrap();
    let mut chain = ArchiveChain::new(ArchiveSource::Claude, "session-1").unwrap();
    chain.commit_scan(&first).unwrap();

    assert!(matches!(
        chain.commit_scan(&shortened),
        Err(collector_archive::ChainError::CheckpointRegressed)
    ));
    assert_eq!(chain.elements.len(), 2);
}

fn scan_source(
    source: ArchiveSource,
    bytes: &[u8],
    prior_checkpoint: Option<&CompletedScanCheckpoint>,
) -> Result<JsonlScan, JsonlError> {
    match source {
        ArchiveSource::Claude => scan_claude_jsonl("session-1", bytes, 10, prior_checkpoint),
        ArchiveSource::Codex => scan_codex_jsonl("session-1", bytes, 10, prior_checkpoint),
    }
}

fn assert_advancing_delta_rejects_source_shrink(
    source: ArchiveSource,
    first_bytes: &[u8],
    next_bytes: &[u8],
) {
    let first = scan_source(source, first_bytes, None).unwrap();
    assert!(first.checkpoint.observed_file_size > next_bytes.len() as u64);
    let mut chain = ArchiveChain::new(source, "session-1").unwrap();
    chain.commit_scan(&first).unwrap();
    let before = chain.clone();

    let unchanged_prefix = scan_source(source, next_bytes, Some(&first.checkpoint));
    assert!(matches!(
        unchanged_prefix,
        Err(JsonlError::HistoricalPrefixShortened)
    ));

    let mut advancing = scan_source(source, next_bytes, None).unwrap();
    assert!(
        advancing.checkpoint.last_complete_byte_offset > first.checkpoint.last_complete_byte_offset
    );
    advancing.observations = advancing.observations.into_iter().skip(1).collect();
    advancing.prior_checkpoint = Some(first.checkpoint.clone());
    assert!(matches!(
        chain.commit_scan(&advancing),
        Err(collector_archive::ChainError::CheckpointRegressed)
    ));
    assert_eq!(chain, before);
    assert_eq!(chain.latest_checkpoint(), before.latest_checkpoint());
}

fn assert_advancing_full_scan_rejects_source_shrink(
    source: ArchiveSource,
    first_bytes: &[u8],
    next_bytes: &[u8],
) {
    let first = scan_source(source, first_bytes, None).unwrap();
    assert!(first.checkpoint.observed_file_size > next_bytes.len() as u64);
    let mut chain = ArchiveChain::new(source, "session-1").unwrap();
    chain.commit_scan(&first).unwrap();
    let before = chain.clone();

    let mut advancing = scan_source(source, next_bytes, None).unwrap();
    assert_eq!(advancing.checkpoint.record_count, 2);
    assert!(
        advancing.checkpoint.last_complete_byte_offset > first.checkpoint.last_complete_byte_offset
    );
    assert!(advancing.checkpoint.observed_file_size < first.checkpoint.observed_file_size);
    advancing.prior_checkpoint = Some(first.checkpoint.clone());

    assert!(matches!(
        chain.commit_scan(&advancing),
        Err(collector_archive::ChainError::CheckpointRegressed)
    ));
    assert_eq!(chain, before);
    assert_eq!(chain.elements, before.elements);
    assert_eq!(chain.latest_checkpoint(), before.latest_checkpoint());
}

#[test]
fn claude_advancing_delta_rejects_source_shrink_without_mutating_chain() {
    assert_advancing_delta_rejects_source_shrink(
        ArchiveSource::Claude,
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"a deliberately long partial tail that is later removed",
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n",
    );
}

#[test]
fn codex_advancing_delta_rejects_source_shrink_without_mutating_chain() {
    assert_advancing_delta_rejects_source_shrink(
        ArchiveSource::Codex,
        b"{\"a\":1}\n{\"partial\":\"a deliberately long partial tail that is later removed",
        b"{\"a\":1}\n{\"b\":2}\n",
    );
}

#[test]
fn claude_advancing_full_scan_rejects_source_shrink_without_mutating_chain() {
    assert_advancing_full_scan_rejects_source_shrink(
        ArchiveSource::Claude,
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"a deliberately long partial tail that is later removed",
        b"{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n",
    );
}

#[test]
fn codex_advancing_full_scan_rejects_source_shrink_without_mutating_chain() {
    assert_advancing_full_scan_rejects_source_shrink(
        ArchiveSource::Codex,
        b"{\"a\":1}\n{\"partial\":\"a deliberately long partial tail that is later removed",
        b"{\"a\":1}\n{\"b\":2}\n",
    );
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
    assert_eq!(second.observations.len(), 1);
    assert_eq!(
        second.checkpoint.last_complete_byte_offset,
        completed.len() as u64
    );
}

type ScanFunction =
    fn(String, &[u8], i64, Option<&CompletedScanCheckpoint>) -> Result<JsonlScan, JsonlError>;

fn assert_blank_tail_cursor_continuation(scan: ScanFunction, initial: &[u8], completed: &[u8]) {
    let first = scan("session-1".to_string(), initial, 10, None).unwrap();
    let complete_offset = initial.iter().rposition(|byte| *byte == b'\n').unwrap() + 1;
    assert_eq!(
        first.checkpoint.last_complete_byte_offset,
        complete_offset as u64
    );
    assert_eq!(first.observations.len(), 1);

    let mut partial = initial.to_vec();
    partial.extend_from_slice(b"   {\"uuid\":\"r2\"");
    let mut misaligned_prior = first.checkpoint.clone();
    misaligned_prior.last_complete_byte_offset = (complete_offset + 1) as u64;
    misaligned_prior.observed_file_size = partial.len() as u64;
    misaligned_prior.complete_prefix_sha256 = sha256(&partial[..complete_offset + 1]);
    assert!(matches!(
        scan(
            "session-1".to_string(),
            &partial,
            11,
            Some(&misaligned_prior),
        ),
        Err(JsonlError::HistoricalPrefixShortened)
    ));
    let partial_scan = scan(
        "session-1".to_string(),
        &partial,
        11,
        Some(&first.checkpoint),
    )
    .unwrap();
    assert_eq!(partial_scan.observations.len(), 0);
    assert_eq!(
        partial_scan.checkpoint.last_complete_byte_offset,
        first.checkpoint.last_complete_byte_offset
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(partial_scan.append_proof.unwrap().appended_prefix_base64,)
            .unwrap(),
        Vec::<u8>::new(),
    );

    let completed_scan = scan(
        "session-1".to_string(),
        completed,
        12,
        Some(&first.checkpoint),
    )
    .unwrap();
    assert_eq!(completed_scan.observations.len(), 1);
    assert_eq!(
        completed_scan.checkpoint.observed_file_size,
        completed.len() as u64
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(completed_scan.append_proof.unwrap().appended_prefix_base64,)
            .unwrap(),
        &completed[complete_offset..],
    );
}

#[test]
fn blank_unterminated_tails_keep_claude_and_codex_cursors_newline_aligned() {
    assert_blank_tail_cursor_continuation(
        scan_claude_jsonl,
        b"{\"uuid\":\"r1\"}\n   ",
        b"{\"uuid\":\"r1\"}\n   {\"uuid\":\"r2\"}\n",
    );
    assert_blank_tail_cursor_continuation(
        scan_codex_jsonl,
        b"{\"event\":\"r1\"}\n   ",
        b"{\"event\":\"r1\"}\n   {\"event\":\"r2\"}\n",
    );
}

#[test]
fn append_scan_exposes_only_the_bounded_suffix_proof() {
    let first = scan_codex_jsonl("session-1", b"{\"a\":1}\n", 10, None).unwrap();
    let suffix = b"{\"b\":2}\n";
    let mut current = b"{\"a\":1}\n".to_vec();
    current.extend_from_slice(suffix);
    let second = scan_codex_jsonl("session-1", &current, 11, Some(&first.checkpoint)).unwrap();
    let proof = second.append_proof.unwrap();
    assert_eq!(
        proof.prior_prefix_chain_sha256,
        first.checkpoint.prefix_chain_sha256
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(proof.appended_prefix_base64)
            .unwrap(),
        suffix,
    );
}

#[test]
fn wire_request_builder_preserves_initial_bytes_and_sends_bounded_later_suffixes() {
    let partial = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"";
    let first_scan = scan_claude_jsonl("session-1", partial, 10, None).unwrap();
    let first_request = first_scan.clone().into_upload_request(partial).unwrap();
    let first_wire = serde_json::to_value(&first_request).unwrap();
    assert_eq!(first_request.observations.len(), 1);
    assert!(first_request.prior_checkpoint.is_none());
    assert!(first_request.append_proof.is_none());
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(first_wire["complete_prefix_base64"].as_str().unwrap())
            .unwrap(),
        b"\n \n{\"uuid\":\"r1\"}\n"
    );

    let completed = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n";
    let eof_scan =
        scan_claude_jsonl("session-1", completed, 11, Some(&first_scan.checkpoint)).unwrap();
    let eof_request = eof_scan.clone().into_upload_request(completed).unwrap();
    let eof_wire = serde_json::to_value(&eof_request).unwrap();
    assert_eq!(eof_request.observations.len(), 1);
    assert!(eof_wire.get("complete_prefix_base64").is_none());
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(
                eof_wire["append_proof"]["appended_prefix_base64"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        b"{\"uuid\":\"r2\"}\n"
    );

    let appended = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n{\"uuid\":\"r3\"}\n";
    let append_scan =
        scan_claude_jsonl("session-1", appended, 12, Some(&eof_scan.checkpoint)).unwrap();
    let append_request = append_scan.into_upload_request(appended).unwrap();
    assert_eq!(append_request.observations.len(), 1);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(append_request.append_proof.unwrap().appended_prefix_base64,)
            .unwrap(),
        b"{\"uuid\":\"r3\"}\n"
    );
}

#[test]
fn rust_wire_builder_matches_the_worker_fixture_for_every_scan_phase() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/archive-wire-session.json")).unwrap();
    let initial_bytes = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"";
    let initial_scan = scan_claude_jsonl("session-1", initial_bytes, 10, None).unwrap();
    let initial_request = initial_scan
        .clone()
        .into_upload_request(initial_bytes)
        .unwrap();
    assert_eq!(
        serde_json::to_value(initial_request).unwrap(),
        fixture["initial"]
    );

    let eof_bytes = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n";
    let eof_scan =
        scan_claude_jsonl("session-1", eof_bytes, 11, Some(&initial_scan.checkpoint)).unwrap();
    let eof_request = eof_scan.clone().into_upload_request(eof_bytes).unwrap();
    assert_eq!(serde_json::to_value(eof_request).unwrap(), fixture["eof"]);

    let append_bytes = b"\n \n{\"uuid\":\"r1\"}\n{\"uuid\":\"r2\"}\n{\"uuid\":\"r3\"}\n";
    let append_scan =
        scan_claude_jsonl("session-1", append_bytes, 12, Some(&eof_scan.checkpoint)).unwrap();
    let append_request = append_scan.into_upload_request(append_bytes).unwrap();
    assert_eq!(
        serde_json::to_value(append_request).unwrap(),
        fixture["append"]
    );

    let vertical_tab_bytes = b"{\"uuid\":\"vt\"}\n\x0b";
    let vertical_tab_scan =
        scan_claude_jsonl("vertical-tab-session", vertical_tab_bytes, 10, None).unwrap();
    let vertical_tab_request = vertical_tab_scan
        .into_upload_request(vertical_tab_bytes)
        .unwrap();
    assert_eq!(
        serde_json::to_value(vertical_tab_request).unwrap(),
        fixture["vertical_tab"]
    );
}

#[test]
fn identifier_validation_matches_the_worker_utf16_contract() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/archive-identifiers.json")).unwrap();
    for control in vectors["controls"].as_array().unwrap() {
        let control = control.as_str().unwrap();
        let source_bytes = serde_json::to_vec(&serde_json::json!({
            "uuid": control
        }))
        .unwrap();
        assert!(matches!(
            scan_claude_jsonl("session-1", &source_bytes, 10, None),
            Err(collector_archive::JsonlError::Archive(
                ArchiveError::InvalidIdentifier { .. }
            ))
        ));
    }

    for separator in vectors["accepted"].as_array().unwrap() {
        let separator = separator.as_str().unwrap();
        let source_bytes = serde_json::to_vec(&serde_json::json!({
            "uuid": format!("collector{separator}")
        }))
        .unwrap();
        assert!(scan_claude_jsonl("session-1", &source_bytes, 10, None).is_ok());
    }

    let boundary = &vectors["boundary"];
    let identity_prefix = "claude:part:parent:claude:id:";
    let identity_suffix = ":0";
    let stable_prefix = boundary["stable_id_prefix"].as_str().unwrap();
    let non_bmp = boundary["non_bmp"].as_str().unwrap();
    let target_units = boundary["target_identity_utf16_units"].as_u64().unwrap() as usize;
    let stable_id = format!(
        "{}{}{}",
        stable_prefix,
        "x".repeat(
            target_units
                - identity_prefix.encode_utf16().count()
                - identity_suffix.encode_utf16().count()
                - stable_prefix.encode_utf16().count()
                - non_bmp.encode_utf16().count()
        ),
        non_bmp,
    );
    let boundary_bytes = serde_json::to_vec(&serde_json::json!({ "uuid": stable_id })).unwrap();
    let boundary_scan = scan_claude_jsonl("session-1", &boundary_bytes, 10, None).unwrap();
    assert_eq!(
        boundary_scan.observations[0]
            .source_record_identity
            .encode_utf16()
            .count(),
        target_units
    );

    let over_limit = &vectors["over_limit"];
    let over_target_units = over_limit["target_identity_utf16_units"].as_u64().unwrap() as usize;
    let over_limit = serde_json::to_vec(&serde_json::json!({
        "uuid": format!(
            "{}{}{}",
            over_limit["stable_id_prefix"].as_str().unwrap(),
            "x".repeat(
                over_target_units
                    - identity_prefix.encode_utf16().count()
                    - identity_suffix.encode_utf16().count()
                    - over_limit["stable_id_prefix"].as_str().unwrap().encode_utf16().count()
                    - over_limit["non_bmp"].as_str().unwrap().encode_utf16().count()
            ),
            over_limit["non_bmp"].as_str().unwrap(),
        )
    }))
    .unwrap();
    assert!(matches!(
        scan_claude_jsonl("session-1", &over_limit, 10, None),
        Err(collector_archive::JsonlError::Archive(
            ArchiveError::InvalidIdentifier { .. }
        ))
    ));
}

#[test]
fn vertical_tab_is_an_incomplete_tail_not_an_archive_blank_line() {
    let bytes = b"{\"a\":1}\n\x0b";
    let scan = scan_codex_jsonl("session-1", bytes, 10, None).unwrap();
    assert_eq!(scan.observations.len(), 1);
    assert_eq!(scan.checkpoint.last_complete_byte_offset, 8);
    assert_eq!(scan.checkpoint.observed_file_size, 9);
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
