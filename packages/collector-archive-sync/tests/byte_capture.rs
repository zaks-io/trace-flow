use std::collections::HashSet;

use collector_archive::{default_transcript_part_id, sha256, ArchiveObservation};
use collector_archive_sync::{
    apply_archive_upload_response, capture_archive_snapshots, prepare_next_archive_upload,
    ArchiveAcknowledgement, ArchiveHistoryChoice, ArchiveHistoryGeneration, ArchiveHistoryPlan,
    ArchiveHistoryState, ArchivePolicy, ArchiveSnapshot, ArchiveSource, ArchiveSpool,
    ArchiveWorkClass, DeferredArchiveSnapshot, MemoryKeyStore, PendingLoad, UploadOutcome,
};

fn plan() -> ArchiveHistoryPlan {
    ArchiveHistoryPlan::new(vec![ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: ArchiveSource::Codex,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 0,
        },
        0,
        vec![],
    )])
}

fn snapshot(bytes: &[u8]) -> ArchiveSnapshot {
    ArchiveSnapshot {
        source: ArchiveSource::Codex,
        source_session_id: "bytes-session".into(),
        base_transcript_part_id: default_transcript_part_id(ArchiveSource::Codex),
        source_transcript_part_id: default_transcript_part_id(ArchiveSource::Codex),
        bytes: bytes.to_vec(),
        deferred_file: None,
        observed_at: 10,
        class: ArchiveWorkClass::Live,
        activity_rank_ms: None,
    }
}

fn capture(spool: &mut ArchiveSpool, keys: &MemoryKeyStore, snapshot: &ArchiveSnapshot) -> u32 {
    let report = capture_archive_snapshots(
        spool,
        keys,
        std::slice::from_ref(snapshot),
        ArchivePolicy::Enrolled,
        &plan(),
        10,
        None,
    );
    assert_eq!(report.first_error, None);
    report.captured
}

fn restore(spool: &ArchiveSpool, part: &str) -> Vec<u8> {
    let mut bytes = vec![];
    for pending in spool
        .slices_for_part(ArchiveSource::Codex, "bytes-session", part)
        .unwrap()
    {
        let upload: serde_json::Value = serde_json::from_slice(&pending.body).unwrap();
        for observation in upload["observations"].as_array().unwrap() {
            let observation: ArchiveObservation =
                serde_json::from_value(observation.clone()).unwrap();
            bytes.extend(observation.payload_bytes().unwrap());
        }
    }
    bytes
}

#[test]
fn rewrites_restart_and_deletion_preserve_all_captured_generations() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let root = dir.path().join("spool");
    let path = dir.path().join("source.jsonl");
    let mut spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
    let mut expected = vec![];
    for bytes in [
        b"{invalid one\xf0\x9f".as_slice(),
        b"{invalid two\xf0\x9f",
        b"short",
    ] {
        std::fs::write(&path, bytes).unwrap();
        let mut input = snapshot(&[]);
        input.deferred_file = Some(DeferredArchiveSnapshot {
            expected_file_identity: None,
            expected_identity_prefix: None,
            path: path.clone(),
            prior_offset: 0,
            minimum_observed_size: 0,
        });
        assert_eq!(capture(&mut spool, &keys, &input), 1);
        let part = spool
            .current_part(
                input.source,
                &input.source_session_id,
                &input.base_transcript_part_id,
            )
            .unwrap();
        expected.push((part, bytes.to_vec()));
    }
    std::fs::remove_file(&path).unwrap();
    drop(spool);
    let spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
    assert_eq!(
        expected
            .iter()
            .map(|(part, _)| part)
            .collect::<HashSet<_>>()
            .len(),
        3
    );
    for (part, bytes) in expected {
        assert_eq!(restore(&spool, &part), bytes);
    }
    assert!(
        prepare_next_archive_upload(&spool, &plan(), ArchivePolicy::Enrolled)
            .unwrap()
            .is_some()
    );
}

#[test]
fn collector_instances_have_independent_stable_capture_streams() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let input = snapshot(b"partial source without newline");
    let mut parts = HashSet::new();
    for root in [dir.path().join("first"), dir.path().join("second")] {
        let mut spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
        assert_eq!(capture(&mut spool, &keys, &input), 1);
        let part = spool
            .current_part(
                input.source,
                &input.source_session_id,
                &input.base_transcript_part_id,
            )
            .unwrap();
        drop(spool);
        let mut spool = ArchiveSpool::open(&root, "org", &keys).unwrap();
        assert_eq!(capture(&mut spool, &keys, &input), 0);
        assert_eq!(
            spool
                .current_part(
                    input.source,
                    &input.source_session_id,
                    &input.base_transcript_part_id
                )
                .unwrap(),
            part
        );
        parts.insert(part);
    }
    assert_eq!(parts.len(), 2);
}

#[test]
fn empty_truncation_is_durable_and_can_later_append() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org", &keys).unwrap();
    capture(&mut spool, &keys, &snapshot(b"original"));
    assert_eq!(capture(&mut spool, &keys, &snapshot(b"")), 1);
    let part = spool
        .current_part(
            ArchiveSource::Codex,
            "bytes-session",
            &default_transcript_part_id(ArchiveSource::Codex),
        )
        .unwrap();
    let pending = spool
        .slices_for_part(ArchiveSource::Codex, "bytes-session", &part)
        .unwrap();
    assert_eq!(pending.len(), 1);
    let upload: serde_json::Value = serde_json::from_slice(&pending[0].body).unwrap();
    assert_eq!(upload["checkpoint"]["record_count"], 0);
    assert_eq!(capture(&mut spool, &keys, &snapshot(b"")), 0);
    assert_eq!(capture(&mut spool, &keys, &snapshot(b"appended")), 1);
    assert_eq!(restore(&spool, &part), b"appended");
}

#[test]
fn oversized_malformed_source_is_captured_in_fair_bounded_passes() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path().join("spool"), "org", &keys).unwrap();
    let path = dir.path().join("source.jsonl");
    let mut bytes = vec![0xff; 17 * 1024 * 1024];
    bytes.extend(b"\xf0\x9f");
    std::fs::write(&path, &bytes).unwrap();
    let mut input = snapshot(&[]);
    input.deferred_file = Some(DeferredArchiveSnapshot {
        expected_file_identity: None,
        expected_identity_prefix: None,
        path: path.clone(),
        prior_offset: 0,
        minimum_observed_size: 0,
    });
    let mut passes = 0;
    loop {
        let count = capture(&mut spool, &keys, &input);
        assert!(count <= 8);
        if count == 0 {
            break;
        }
        passes += 1;
        assert!(passes <= 5);
    }
    assert_eq!(passes, 5);
    std::fs::remove_file(path).unwrap();
    let part = spool
        .current_part(
            input.source,
            &input.source_session_id,
            &input.base_transcript_part_id,
        )
        .unwrap();
    assert_eq!(sha256(&restore(&spool, &part)), sha256(&bytes));
}

#[test]
fn wrong_receipt_cannot_retire_source_deleted_capture() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org", &keys).unwrap();
    capture(&mut spool, &keys, &snapshot(b"{unfinished"));
    let prepared = prepare_next_archive_upload(&spool, &plan(), ArchivePolicy::Enrolled)
        .unwrap()
        .unwrap();
    let upload: serde_json::Value = serde_json::from_slice(prepared.body()).unwrap();
    let ack = receipt(prepared.body(), &upload);
    let mut wrong = ack.clone();
    wrong.request_sha256 = Some(sha256(b"different request").to_string());
    assert_eq!(
        apply_archive_upload_response(&mut spool, &keys, &prepared, Ok(wrong)),
        Err("archive_ack_mismatch")
    );
    assert!(spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|p| matches!(p, PendingLoad::Ready(_))));
    assert_eq!(
        apply_archive_upload_response(&mut spool, &keys, &prepared, Ok(ack)),
        Ok(UploadOutcome::Advanced)
    );
    assert!(spool.all_pending().unwrap().is_empty());
}

#[test]
fn acknowledged_rewrite_cannot_hide_an_uncaptured_deleted_tail() {
    use collector_archive_sync::{ArchiveBaselineTarget, ArchiveInitialImport};
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path().join("spool"), "org", &keys).unwrap();
    let path = dir.path().join("source.jsonl");
    let bytes = vec![0xff; 4 * 1024 * 1024 + 1];
    std::fs::write(&path, &bytes).unwrap();
    let mut input = snapshot(&[]);
    input.deferred_file = Some(DeferredArchiveSnapshot {
        expected_file_identity: None,
        expected_identity_prefix: None,
        path: path.clone(),
        prior_offset: 0,
        minimum_observed_size: 0,
    });
    let history = ArchiveHistoryPlan::new(vec![ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: input.source,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 0,
        },
        0,
        vec![ArchiveBaselineTarget {
            source_session_id: input.source_session_id.clone(),
            source_transcript_part_id: input.base_transcript_part_id.clone(),
            activity_rank_ms: 0,
            registered_size_bytes: bytes.len() as u64,
            registered_complete_byte_offset: 0,
        }],
    )]);
    assert_eq!(capture(&mut spool, &keys, &input), 8);
    for rewritten in [false, true] {
        if rewritten {
            std::fs::write(&path, b"replacement").unwrap();
            assert_eq!(capture(&mut spool, &keys, &input), 1);
        }
        while let Some(prepared) =
            prepare_next_archive_upload(&spool, &history, ArchivePolicy::Enrolled).unwrap()
        {
            let body = serde_json::from_slice(prepared.body()).unwrap();
            let ack = receipt(prepared.body(), &body);
            assert_eq!(
                apply_archive_upload_response(&mut spool, &keys, &prepared, Ok(ack)),
                Ok(UploadOutcome::Advanced)
            );
        }
        let report = capture_archive_snapshots(
            &mut spool,
            &keys,
            &[],
            ArchivePolicy::Enrolled,
            &history,
            20,
            None,
        );
        assert_eq!(
            report.history[0].initial_import,
            ArchiveInitialImport::InProgress
        );
        assert_eq!(
            report.first_error.as_deref(),
            Some("archive_history_missing_baseline")
        );
    }
    std::fs::remove_file(path).unwrap();
}

fn receipt(body: &[u8], upload: &serde_json::Value) -> ArchiveAcknowledgement {
    ArchiveAcknowledgement {
        status: "acknowledged".into(),
        duplicate: false,
        source: ArchiveSource::Codex,
        source_session_id: "bytes-session".into(),
        source_transcript_part_id: upload["checkpoint"]["source_transcript_part_id"]
            .as_str()
            .map(str::to_string),
        contribution_id: "contribution".into(),
        appended_records: 1,
        appended_checkpoint: true,
        record_count: 1,
        generation: 1,
        chain_head: sha256(b"verified chain").to_string(),
        manifest_key: "immutable-manifest".into(),
        chunk_keys: vec![],
        request_sha256: Some(sha256(body).to_string()),
        captured_byte_offset: upload["checkpoint"]["last_complete_byte_offset"].as_u64(),
        captured_prefix_sha256: upload["checkpoint"]["complete_prefix_sha256"]
            .as_str()
            .map(str::to_string),
    }
}

#[test]
fn metadata_cannot_consume_space_reserved_for_a_large_verified_receipt() {
    let dir = tempfile::TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org", &keys).unwrap();
    capture(&mut spool, &keys, &snapshot(b"{unfinished"));
    let used = spool.on_disk_bytes().unwrap();
    drop(spool);
    let cap = used + 2 * 96 * 1024;
    let mut spool = ArchiveSpool::open_with_cap(dir.path(), "org", &keys, cap).unwrap();
    let prepared = prepare_next_archive_upload(&spool, &plan(), ArchivePolicy::Enrolled)
        .unwrap()
        .unwrap();
    let upload: serde_json::Value = serde_json::from_slice(prepared.body()).unwrap();
    let checkpoint: collector_archive::CompletedScanCheckpoint =
        serde_json::from_value(upload["checkpoint"].clone()).unwrap();
    assert!(matches!(
        spool.persist_progress(ArchiveSource::Codex, "bytes-session", &checkpoint),
        Err(collector_archive_sync::ArchiveSyncError::CapacityExceeded)
    ));
    let mut ack = receipt(prepared.body(), &upload);
    ack.chunk_keys = vec!["a".repeat(100); 600];
    assert_eq!(
        apply_archive_upload_response(&mut spool, &keys, &prepared, Ok(ack)),
        Ok(UploadOutcome::Advanced)
    );
    assert!(spool.on_disk_bytes().unwrap() <= cap);
    assert!(spool.all_pending().unwrap().is_empty());
}
