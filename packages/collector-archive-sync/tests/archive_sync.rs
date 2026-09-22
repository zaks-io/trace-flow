mod support;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

use collector_archive::{
    claude_transcript_part_id, default_transcript_part_id, scan_claude_jsonl, ArchiveSource,
};
use collector_archive_sync::{
    acknowledgement_matches, archive_source_session_id, build_bounded_pending_for_part,
    transcript_part_for, ArchiveAcknowledgement, ArchiveBaselineTarget, ArchiveClient,
    ArchiveClientConfig, ArchiveClientError, ArchiveEnrollmentRecord, ArchiveEnrollmentRequest,
    ArchiveHistoryChoice, ArchiveHistoryGeneration, ArchiveHistoryPlan, ArchiveHistoryState,
    ArchiveInitialImport, ArchiveKeyStore, ArchivePolicy, ArchiveSnapshot, ArchiveSourceChoice,
    ArchiveSpool, ArchiveSpoolKey, ArchiveSyncError, ArchiveUploader, ArchiveWorkClass,
    BlockedArchiveRecord, DeferredArchiveSnapshot, MemoryKeyStore, PendingArchiveRequest,
    PendingLoad, ARCHIVE_CAPTURE_WINDOW_BYTES, ARCHIVE_RECORD_POLICY_VERSION,
    ARCHIVE_SPOOL_CAP_BYTES, ARCHIVE_SPOOL_KEYRING_SERVICE, MAX_ARCHIVE_UPLOAD_BYTES,
    MAX_UPLOAD_OBSERVATIONS,
};
use collector_contracts::AgentSource;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const CLAUDE: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/claude.jsonl");
const CODEX: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/codex.jsonl");
const ALL_ARCHIVE_SOURCES: &[ArchiveSource] = &[ArchiveSource::Claude, ArchiveSource::Codex];
const TEST_NOW_MS: i64 = 1_800_000_000_000;

fn plan_for(sources: &[ArchiveSource]) -> ArchiveHistoryPlan {
    ArchiveHistoryPlan::new(
        sources
            .iter()
            .copied()
            .map(|source| {
                ArchiveHistoryState::new(
                    ArchiveHistoryGeneration {
                        source,
                        history_choice: ArchiveHistoryChoice::AllHistory,
                        authorized_at: 0,
                    },
                    0,
                    Vec::new(),
                )
            })
            .collect(),
    )
}

fn state_with_target(
    source: ArchiveSource,
    choice: ArchiveHistoryChoice,
    session: &str,
) -> ArchiveHistoryState {
    ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source,
            history_choice: choice,
            authorized_at: 10,
        },
        10,
        vec![ArchiveBaselineTarget {
            source_session_id: session.to_string(),
            source_transcript_part_id: default_transcript_part_id(source),
            activity_rank_ms: 1,
            registered_size_bytes: 1,
            registered_complete_byte_offset: 1,
        }],
    )
}

struct ScriptedUploader {
    calls: Cell<u32>,
    bodies: RefCell<Vec<Vec<u8>>>,
    sources: RefCell<Vec<ArchiveSource>>,
    scripted: RefCell<VecDeque<Result<ArchiveAcknowledgement, ArchiveClientError>>>,
}

impl ScriptedUploader {
    fn new(
        results: impl IntoIterator<Item = Result<ArchiveAcknowledgement, ArchiveClientError>>,
    ) -> Self {
        Self {
            calls: Cell::new(0),
            bodies: RefCell::new(Vec::new()),
            sources: RefCell::new(Vec::new()),
            scripted: RefCell::new(results.into_iter().collect()),
        }
    }
}

impl ArchiveUploader for ScriptedUploader {
    async fn upload(
        &self,
        source: ArchiveSource,
        body: &[u8],
        _cancel: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
        self.calls.set(self.calls.get() + 1);
        self.bodies.borrow_mut().push(body.to_vec());
        self.sources.borrow_mut().push(source);
        self.scripted.borrow_mut().pop_front().unwrap_or_else(|| {
            Err(ArchiveClientError::Unavailable {
                reason: "scripted archive upload exhausted".to_string(),
            })
        })
    }
}

fn ack_for(pending: &PendingArchiveRequest) -> ArchiveAcknowledgement {
    let (request_sha256, captured_byte_offset, captured_prefix_sha256) =
        byte_receipt_fields(&pending.body);
    ArchiveAcknowledgement {
        relative_path: None,
        request_sha256,
        captured_byte_offset,
        captured_prefix_sha256,
        status: "acknowledged".to_string(),
        duplicate: false,
        source: pending.source,
        source_session_id: pending.source_session_id.clone(),
        source_transcript_part_id: Some(pending.source_transcript_part_id.clone()),
        contribution_id: "con_1".to_string(),
        appended_records: pending.expected_appended_records,
        appended_checkpoint: true,
        record_count: pending.expected_record_count,
        generation: 1,
        chain_head: collector_archive::sha256(b"chain").to_string(),
        manifest_key: "manifest".to_string(),
        chunk_keys: vec![],
    }
}

fn byte_receipt_fields(body: &[u8]) -> (Option<String>, Option<u64>, Option<String>) {
    let value: serde_json::Value = serde_json::from_slice(body).unwrap();
    if value["checkpoint"]["archive_format_version"].as_u64() != Some(2) {
        return (None, None, None);
    }
    (
        Some(collector_archive::sha256(body).to_string()),
        value["checkpoint"]["last_complete_byte_offset"].as_u64(),
        value["checkpoint"]["complete_prefix_sha256"]
            .as_str()
            .map(str::to_string),
    )
}

fn snapshot(source: ArchiveSource, bytes: &[u8], observed_at: i64) -> ArchiveSnapshot {
    let source_session_id = archive_source_session_id(source, bytes).unwrap();
    ArchiveSnapshot {
        relative_path: None,
        source,
        source_session_id,
        base_transcript_part_id: default_transcript_part_id(source),
        source_transcript_part_id: default_transcript_part_id(source),
        bytes: bytes.to_vec(),
        deferred_file: None,
        observed_at,
        class: ArchiveWorkClass::Live,
        activity_rank_ms: None,
    }
}

fn snapshot_for_path(
    source: ArchiveSource,
    path: &str,
    bytes: &[u8],
    observed_at: i64,
) -> ArchiveSnapshot {
    let source_session_id = archive_source_session_id(source, bytes).unwrap();
    let source_transcript_part_id = transcript_part_for(source, Some(path), bytes).unwrap();
    ArchiveSnapshot {
        relative_path: None,
        source,
        source_session_id,
        base_transcript_part_id: source_transcript_part_id.clone(),
        source_transcript_part_id,
        bytes: bytes.to_vec(),
        deferred_file: None,
        observed_at,
        class: ArchiveWorkClass::Live,
        activity_rank_ms: None,
    }
}

fn current_snapshot(
    spool: &ArchiveSpool,
    source: ArchiveSource,
    bytes: &[u8],
    observed_at: i64,
) -> ArchiveSnapshot {
    let mut snapshot = snapshot(source, bytes, observed_at);
    snapshot.source_transcript_part_id = spool
        .current_part(
            source,
            &snapshot.source_session_id,
            &snapshot.base_transcript_part_id,
        )
        .unwrap();
    snapshot
}

fn pending_from_bytes(
    source: ArchiveSource,
    bytes: &[u8],
    observed_at: i64,
) -> PendingArchiveRequest {
    let session = collector_archive_sync::archive_source_session_id(source, bytes).unwrap();
    let part = default_transcript_part_id(source);
    let scan = collector_archive_sync::scan_snapshot_part(
        source,
        &session,
        &part,
        bytes,
        observed_at,
        None,
    )
    .unwrap();
    let request = scan.into_upload_request(bytes).unwrap();
    PendingArchiveRequest::from_upload(source, &request, serde_json::to_vec(&request).unwrap())
}

fn pending_disk_path(
    root: &std::path::Path,
    pending: &PendingArchiveRequest,
) -> std::path::PathBuf {
    root.join("pending")
        .join(pending.source.as_str())
        .join(&pending.source_session_id)
        .join(format!(
            "{}.bin",
            pending.source_transcript_part_id.replace(':', "_")
        ))
}

fn progress_disk_path(
    root: &std::path::Path,
    pending: &PendingArchiveRequest,
) -> std::path::PathBuf {
    root.join("progress")
        .join(pending.source.as_str())
        .join(&pending.source_session_id)
        .join(format!(
            "{}.bin",
            pending.source_transcript_part_id.replace(':', "_")
        ))
}

fn ack_staging_disk_path(
    root: &std::path::Path,
    pending: &PendingArchiveRequest,
) -> std::path::PathBuf {
    root.join("progress")
        .join(pending.source.as_str())
        .join(&pending.source_session_id)
        .join(format!(
            "{}.ack.tmp",
            pending.source_transcript_part_id.replace(':', "_")
        ))
}

fn ack_scratch_disk_path(
    root: &std::path::Path,
    pending: &PendingArchiveRequest,
) -> std::path::PathBuf {
    root.join("progress")
        .join(pending.source.as_str())
        .join(&pending.source_session_id)
        .join(format!(
            "{}.ack.tmp.tmp",
            pending.source_transcript_part_id.replace(':', "_")
        ))
}

fn actual_file_bytes(root: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, total);
                continue;
            }
            if path.is_file() {
                *total += path.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    let mut total = 0;
    walk(root, &mut total);
    total
}

fn checkpoint_from_pending(
    pending: &PendingArchiveRequest,
) -> collector_archive::CompletedScanCheckpoint {
    let value: serde_json::Value = serde_json::from_slice(&pending.body).unwrap();
    serde_json::from_value(value["checkpoint"].clone()).unwrap()
}

fn real_durable_bytes(root: &std::path::Path) -> u64 {
    fn walk(dir: &std::path::Path, total: &mut u64) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, total);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if name.ends_with(".tmp") && !name.ends_with(".ack.tmp") {
                continue;
            }
            *total += path.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    let mut total = 0;
    walk(root, &mut total);
    total
}

fn pad_spool_leaving_room(root: &std::path::Path, cap: u64, room: u64) {
    let used = real_durable_bytes(root);
    let pad = cap.saturating_sub(used).saturating_sub(room);
    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(root.join("pad.bin"))
        .unwrap();
    file.set_len(pad).unwrap();
}

fn server_aggregate_duplicate_ack(pending: &PendingArchiveRequest) -> ArchiveAcknowledgement {
    ArchiveAcknowledgement {
        relative_path: None,
        request_sha256: None,
        captured_byte_offset: None,
        captured_prefix_sha256: None,
        status: "acknowledged".to_string(),
        duplicate: false,
        source: pending.source,
        source_session_id: pending.source_session_id.clone(),
        source_transcript_part_id: None,
        contribution_id: "con_1".to_string(),
        appended_records: 0,
        appended_checkpoint: false,
        record_count: 3,
        generation: 1,
        chain_head: "sha256:00".to_string(),
        manifest_key: "manifest".to_string(),
        chunk_keys: vec![],
    }
}

struct FailingDeleteKeyStore {
    inner: MemoryKeyStore,
}

impl FailingDeleteKeyStore {
    fn new() -> Self {
        Self {
            inner: MemoryKeyStore::new(),
        }
    }
}

impl ArchiveKeyStore for FailingDeleteKeyStore {
    fn load(&self, org_id: &str) -> Result<Option<ArchiveSpoolKey>, ArchiveSyncError> {
        self.inner.load(org_id)
    }

    fn store(&self, org_id: &str, key: &ArchiveSpoolKey) -> Result<(), ArchiveSyncError> {
        self.inner.store(org_id, key)
    }

    fn delete(&self, _org_id: &str) -> Result<(), ArchiveSyncError> {
        Err(ArchiveSyncError::KeyUnavailable)
    }
}

#[test]
fn spool_cap_is_exact_and_not_a_rounded_gigabyte() {
    assert_eq!(ARCHIVE_SPOOL_CAP_BYTES, 2_147_483_648);
    assert_ne!(ARCHIVE_SPOOL_CAP_BYTES, 2_000_000_000);
    assert_eq!(ARCHIVE_SPOOL_CAP_BYTES, 1u64 << 31);
}

#[test]
fn blocked_record_existing_metadata_values_remain_wire_compatible() {
    let existing = serde_json::json!({
        "source": "claude",
        "source_session_id": "session",
        "source_transcript_part_id": "claude:part:parent",
        "source_record_identity": "claude:part:parent:claude:id:record:0",
        "record_size_bytes": 42,
        "limit_bytes": 16_777_216,
        "policy_version": ARCHIVE_RECORD_POLICY_VERSION,
        "observed_file_size": 43,
        "source_fingerprint_bytes": 43,
        "observed_file_sha256": format!("sha256:{}", "0".repeat(64)),
        "pending_body_sha256": null,
    });

    let blocked: collector_archive_sync::BlockedArchiveRecord =
        serde_json::from_value(existing.clone()).unwrap();

    assert_eq!(
        blocked.source_record_identity.as_deref(),
        Some("claude:part:parent:claude:id:record:0")
    );
    assert_eq!(blocked.record_size_bytes, Some(42));
    assert_eq!(serde_json::to_value(blocked).unwrap(), existing);
}

#[test]
fn partial_blocked_fingerprint_never_matches_a_complete_source() {
    let prefix = b"{\"uuid\":\"blocked\"}\n";
    let mut original = prefix.to_vec();
    original.extend_from_slice(b"partial tail");
    let blocked = collector_archive_sync::BlockedArchiveRecord {
        source: ArchiveSource::Claude,
        source_session_id: "session".to_string(),
        source_transcript_part_id: "claude:part:parent".to_string(),
        source_record_identity: None,
        record_size_bytes: None,
        limit_bytes: MAX_ARCHIVE_UPLOAD_BYTES as u64,
        policy_version: ARCHIVE_RECORD_POLICY_VERSION.to_string(),
        observed_file_size: original.len() as u64,
        source_fingerprint_bytes: prefix.len() as u64,
        observed_file_sha256: collector_archive::sha256(prefix).to_string(),
        pending_body_sha256: None,
    };
    let mut changed_tail = original.clone();
    changed_tail[prefix.len()] ^= 1;

    assert!(!blocked.matches_source(&original));
    assert!(!blocked.matches_source(&changed_tail));
}

#[test]
fn crash_recovery_replays_the_same_pending_bytes() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let first = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    {
        let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
        spool.persist_pending(&first).unwrap();
    }
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let restored = spool
        .pending(ArchiveSource::Claude, &first.source_session_id)
        .unwrap()
        .expect("pending survived relaunch");
    assert_eq!(restored.body, first.body);
    assert_eq!(restored.expected_record_count, first.expected_record_count);
}

#[test]
fn path_escaping_session_id_does_not_write_outside_the_spool() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let escaped = PendingArchiveRequest {
        source: ArchiveSource::Claude,
        source_session_id: "../outside".to_string(),
        source_transcript_part_id: default_transcript_part_id(ArchiveSource::Claude),
        expected_record_count: 1,
        expected_appended_records: 1,
        capture_authorization: None,
        predecessor_part_id: None,
        body: b"{}".to_vec(),
    };
    assert!(spool.persist_pending(&escaped).is_err());
    assert!(!dir.path().join("outside.bin").exists());
    assert!(!dir.path().parent().unwrap().join("outside.bin").exists());
}

#[test]
fn corruption_fails_loud_and_does_not_advance_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    spool.persist_pending(&pending).unwrap();
    let path = pending_disk_path(dir.path(), &pending);
    let mut blob = fs::read(&path).unwrap();
    let last = blob.len() - 1;
    blob[last] ^= 0xff;
    fs::write(&path, blob).unwrap();
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .is_err());
    assert!(spool
        .progress(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
}

#[test]
fn capacity_rejects_new_data_without_evicting() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let first = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    {
        let spool = ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, u64::MAX).unwrap();
        spool.persist_pending(&first).unwrap();
    }
    let used = ArchiveSpool::open(dir.path(), "org_1", &keys)
        .unwrap()
        .on_disk_bytes()
        .unwrap();
    let spool = ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, used).unwrap();
    let before = spool.on_disk_bytes().unwrap();
    let second = pending_from_bytes(ArchiveSource::Codex, CODEX, 11);
    assert!(spool.persist_pending(&second).is_err());
    let restored = spool
        .pending(ArchiveSource::Claude, &first.source_session_id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.body, first.body);
    assert_eq!(spool.on_disk_bytes().unwrap(), before);
}

#[tokio::test]
async fn exact_body_retry_posts_the_persisted_bytes() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(uploader.bodies.borrow()[0], pending.body);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn acknowledgement_mismatch_does_not_advance() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let mut mismatch = ack_for(&pending);
    mismatch.source_session_id = "other-session".to_string();
    assert!(!acknowledgement_matches(&pending, &mismatch));
    let uploader = ScriptedUploader::new([Ok(mismatch)]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(report.failed, 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
    assert!(spool
        .progress(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn session_error_does_not_block_other_sessions() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let claude = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let codex = pending_from_bytes(ArchiveSource::Codex, CODEX, 11);
    spool.persist_pending(&claude).unwrap();
    spool.persist_pending(&codex).unwrap();
    let uploader = ScriptedUploader::new([
        Err(ArchiveClientError::InvalidUpload {
            reason: "unknown".to_string(),
        }),
        Ok(ack_for(&codex)),
    ]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.failed, 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &claude.source_session_id)
        .unwrap()
        .is_some());
    assert!(spool
        .pending(ArchiveSource::Codex, &codex.source_session_id)
        .unwrap()
        .is_none());
}

#[test]
fn cursor_cannot_become_an_archive_source() {
    assert!(ArchiveSource::try_from(AgentSource::Cursor).is_err());
}

#[tokio::test]
async fn cursor_snapshots_are_not_required_for_jsonl_uploads() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let claude = snapshot(ArchiveSource::Claude, CLAUDE, 10);
    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[claude],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(uploader.bodies.borrow().len(), 1);
}

#[tokio::test]
async fn unauthorized_source_is_neither_captured_nor_uploaded() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let codex = pending_from_bytes(ArchiveSource::Codex, CODEX, 11);
    spool.persist_pending(&codex).unwrap();
    let uploader = ScriptedUploader::new([]);

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, CODEX, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(&[ArchiveSource::Claude]),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(uploader.calls.get(), 0);
    assert_eq!(report.captured, 0);
    assert_eq!(report.uploaded, 0);
    assert!(spool
        .pending(ArchiveSource::Codex, &codex.source_session_id)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn terminal_revocation_purges_spool_key_and_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let scan = scan_claude_jsonl(&pending.source_session_id, CLAUDE, 10, None).unwrap();
    spool
        .persist_progress(
            ArchiveSource::Claude,
            &pending.source_session_id,
            &scan.checkpoint,
        )
        .unwrap();
    assert!(keys.load("org_1").unwrap().is_some());
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "credential_revoked".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(report.purged);
    assert!(keys.load("org_1").unwrap().is_none());
    assert!(!dir.path().join("pending").exists());
}

#[tokio::test]
async fn expired_credential_retains_pending_spool_key_and_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let scan = scan_claude_jsonl(&pending.source_session_id, CLAUDE, 10, None).unwrap();
    spool
        .persist_progress(
            ArchiveSource::Claude,
            &pending.source_session_id,
            &scan.checkpoint,
        )
        .unwrap();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Unauthorized {
        reason: "expired".to_string(),
    })]);

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert!(report.frozen);
    assert!(!report.purged);
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
    assert!(progress_disk_path(dir.path(), &pending).exists());
}

#[tokio::test]
async fn local_revoked_policy_purges_without_uploading() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Revoked,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(report.purged);
    assert_eq!(uploader.calls.get(), 0);
    assert!(keys.load("org_1").unwrap().is_none());
}

#[tokio::test]
async fn server_frozen_denial_does_not_purge_or_advance() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "frozen".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(report.frozen);
    assert!(!report.purged);
    assert_eq!(report.captured, 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
    assert!(keys.load("org_1").unwrap().is_some());
}

#[tokio::test]
async fn live_frozen_during_capture_stops_later_sessions() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let claude = snapshot(ArchiveSource::Claude, CLAUDE, 10);
    let codex = snapshot(ArchiveSource::Codex, CODEX, 11);
    let claude_session = claude.source_session_id.clone();
    let codex_session = codex.source_session_id.clone();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "frozen".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[claude, codex],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(report.frozen);
    assert!(!report.purged);
    assert_eq!(uploader.calls.get(), 1);
    assert_eq!(report.captured, 2);
    assert!(spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|load| matches!(load, PendingLoad::Ready(pending) if pending.source == ArchiveSource::Claude && pending.source_session_id == claude_session)));
    assert!(spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|load| matches!(load, PendingLoad::Ready(pending) if pending.source == ArchiveSource::Codex && pending.source_session_id == codex_session)));
    assert!(keys.load("org_1").unwrap().is_some());
}

#[tokio::test]
async fn grace_and_frozen_retain_without_uploading() {
    for policy in [ArchivePolicy::Frozen, ArchivePolicy::Grace] {
        let dir = TempDir::new().unwrap();
        let keys = MemoryKeyStore::new();
        let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
        let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
        spool.persist_pending(&pending).unwrap();
        let uploader = ScriptedUploader::new([]);
        let report = support::capture_and_upload(
            &uploader,
            &mut spool,
            &keys,
            &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
            policy,
            &plan_for(ALL_ARCHIVE_SOURCES),
            TEST_NOW_MS,
            None,
        )
        .await;
        assert!(!report.purged);
        assert_eq!(uploader.calls.get(), 0);
        assert_eq!(report.captured, 0);
        assert!(spool
            .pending(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .is_some());
        assert!(keys.load("org_1").unwrap().is_some());
    }
}

#[tokio::test]
async fn inactive_pending_denial_stops_later_parts_without_capturing() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let later = snapshot(ArchiveSource::Codex, CODEX, 11);
    let later_session = later.source_session_id.clone();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "not_activated".to_string(),
    })]);

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[later],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(uploader.calls.get(), 1);
    assert!(report.frozen);
    assert_eq!(report.failed, 0);
    assert_eq!(report.captured, 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
    assert!(spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|load| matches!(load, PendingLoad::Ready(pending) if pending.source == ArchiveSource::Codex && pending.source_session_id == later_session)));
}

#[test]
fn enrollment_file_is_non_secret() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("archive-enrollment.json");
    ArchiveEnrollmentRecord::save(&path, ArchivePolicy::Frozen).unwrap();
    assert_eq!(
        ArchiveEnrollmentRecord::load(&path).unwrap(),
        ArchivePolicy::Frozen
    );
}

#[test]
fn open_existing_does_not_mint_a_key_and_files_without_a_key_are_corrupt() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    assert!(ArchiveSpool::open_existing(dir.path(), "org_1", &keys)
        .unwrap()
        .is_none());
    assert!(keys.load("org_1").unwrap().is_none());
    std::fs::create_dir_all(dir.path().join("pending").join("claude")).unwrap();
    std::fs::write(
        dir.path().join("pending").join("claude").join("s.bin"),
        b"not-encrypted",
    )
    .unwrap();
    assert!(ArchiveSpool::open_existing(dir.path(), "org_1", &keys).is_err());
}

#[test]
fn key_debug_and_service_name_stay_non_secret() {
    let key = ArchiveSpoolKey::generate().unwrap();
    assert_eq!(format!("{key:?}"), "ArchiveSpoolKey(<redacted>)");
    assert_eq!(ARCHIVE_SPOOL_KEYRING_SERVICE, "trace-flow-archive-spool");
}

#[test]
fn source_records_remain_byte_for_byte() {
    let scan = scan_claude_jsonl("claude-session-001", CLAUDE, 10, None).unwrap();
    let original = CLAUDE
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

#[tokio::test]
async fn archive_client_posts_json_with_required_headers() {
    let seen = Arc::new(Mutex::new(String::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen_header = Arc::clone(&seen);
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|window| window == b"\r\n\r\n") || buf.len() > (1 << 20) {
                break;
            }
        }
        *seen_header.lock().unwrap() = String::from_utf8_lossy(&buf).into_owned();
        let body = r#"{"status":"acknowledged","source":"claude","source_session_id":"s","record_count":1}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let client = ArchiveClient::new(ArchiveClientConfig::new(
        format!("http://{addr}"),
        "tfc_secret",
    ))
    .unwrap();
    let ack = client
        .upload(ArchiveSource::Claude, br#"{"source_session_id":"s"}"#, None)
        .await
        .unwrap();
    assert_eq!(ack.record_count, 1);
    let request = seen.lock().unwrap().clone();
    let lowered = request.to_lowercase();
    assert!(lowered.contains("x-trace-flow-collector-secret: tfc_secret"));
    assert!(lowered.contains("x-trace-flow-archive-source: claude"));
    assert!(lowered.contains("content-type: application/json"));
    assert!(!lowered.contains("content-encoding: gzip"));
    assert!(request.contains(r#"{"source_session_id":"s"}"#));
}

#[tokio::test]
async fn archive_client_enrolls_with_the_collector_secret_and_exact_consent() {
    let seen = Arc::new(Mutex::new(String::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen_request = Arc::clone(&seen);
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap();
        *seen_request.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).into_owned();
        let body = r#"{"enrolled":true,"authorizedSources":[{"source":"claude","historyChoice":"all_history","authorizedAt":1770000000001}],"reason":null}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });

    let client = ArchiveClient::new(ArchiveClientConfig::new(
        format!("http://{addr}"),
        "tfc_enrollment_secret",
    ))
    .unwrap();
    let request = ArchiveEnrollmentRequest {
        authorized_sources: vec![ArchiveSourceChoice {
            source: ArchiveSource::Claude,
            history_choice: ArchiveHistoryChoice::AllHistory,
        }],
        idempotency_key: "archive-enroll:request-1".to_string(),
    };
    let response = client.enroll(&request).await.unwrap();
    assert!(response.enrolled);

    let raw = seen.lock().unwrap().clone();
    let lowered = raw.to_lowercase();
    assert!(lowered.starts_with("post /v1/archive/enrollments http/1.1"));
    assert!(lowered.contains("x-trace-flow-collector-secret: tfc_enrollment_secret"));
    assert!(lowered.contains("content-type: application/json"));
    assert!(raw.contains(
        r#"{"authorizedSources":[{"source":"claude","historyChoice":"all_history"}],"idempotencyKey":"archive-enroll:request-1"}"#
    ));
    assert!(!format!("{request:?}").contains("tfc_enrollment_secret"));
}

struct AckingUploader {
    bodies: RefCell<Vec<Vec<u8>>>,
    session_record_count: Cell<u64>,
}

#[cfg(unix)]
struct PermissionRestoringUploader {
    inner: AckingUploader,
    path: std::path::PathBuf,
    permissions: RefCell<Option<std::fs::Permissions>>,
}

#[cfg(unix)]
impl PermissionRestoringUploader {
    fn new(path: std::path::PathBuf, permissions: std::fs::Permissions) -> Self {
        Self {
            inner: AckingUploader::new(),
            path,
            permissions: RefCell::new(Some(permissions)),
        }
    }
}

#[cfg(unix)]
impl ArchiveUploader for PermissionRestoringUploader {
    async fn upload(
        &self,
        source: ArchiveSource,
        body: &[u8],
        cancel: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
        if let Some(permissions) = self.permissions.borrow_mut().take() {
            fs::set_permissions(&self.path, permissions).unwrap();
        }
        self.inner.upload(source, body, cancel).await
    }
}

impl AckingUploader {
    fn new() -> Self {
        Self {
            bodies: RefCell::new(Vec::new()),
            session_record_count: Cell::new(0),
        }
    }
}

impl ArchiveUploader for AckingUploader {
    async fn upload(
        &self,
        source: ArchiveSource,
        body: &[u8],
        _cancel: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        let appended = value["observations"].as_array().map(Vec::len).unwrap_or(0) as u64;
        let part_count = value["checkpoint"]["record_count"].as_u64().unwrap();
        self.session_record_count
            .set(self.session_record_count.get() + appended);
        self.bodies.borrow_mut().push(body.to_vec());
        let (request_sha256, captured_byte_offset, captured_prefix_sha256) =
            byte_receipt_fields(body);
        Ok(ArchiveAcknowledgement {
            relative_path: None,
            request_sha256,
            captured_byte_offset,
            captured_prefix_sha256,
            status: "acknowledged".to_string(),
            duplicate: false,
            source,
            source_session_id: value["source_session_id"].as_str().unwrap().to_string(),
            source_transcript_part_id: value["checkpoint"]["source_transcript_part_id"]
                .as_str()
                .map(str::to_string),
            contribution_id: "con_1".to_string(),
            appended_records: appended,
            appended_checkpoint: true,
            record_count: self.session_record_count.get().max(part_count),
            generation: 1,
            chain_head: collector_archive::sha256(b"chain").to_string(),
            manifest_key: "manifest".to_string(),
            chunk_keys: vec![],
        })
    }
}

fn padded_records(count: usize, pad: usize, session: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for index in 0..count {
        let line = format!(
            r#"{{"sessionId":"{session}","uuid":"r{index}","pad":"{}"}}"#,
            "x".repeat(pad)
        );
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    }
    out
}

fn pending_payload_bytes(records: &[PendingArchiveRequest]) -> Vec<u8> {
    let mut records = records.to_vec();
    records.sort_by_key(|record| record.expected_record_count);
    records
        .iter()
        .flat_map(|record| {
            let body: serde_json::Value = serde_json::from_slice(&record.body).unwrap();
            body["observations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|observation| {
                    serde_json::from_value::<collector_archive::ArchiveObservation>(
                        observation.clone(),
                    )
                    .unwrap()
                    .payload_bytes()
                    .unwrap()
                })
                .collect::<Vec<_>>()
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn oversized_session_splits_at_byte_limit() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(24, 400_000, "big-session");
    let full = collector_archive_sync::scan_snapshot_part(
        ArchiveSource::Claude,
        "big-session",
        &default_transcript_part_id(ArchiveSource::Claude),
        &bytes,
        10,
        None,
    )
    .unwrap()
    .into_upload_request(&bytes)
    .unwrap();
    assert!(serde_json::to_vec(&full).unwrap().len() > MAX_ARCHIVE_UPLOAD_BYTES);

    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &bytes, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(report.uploaded >= 2);
    assert_eq!(report.failed, 0);
    for body in uploader.bodies.borrow().iter() {
        assert!(body.len() <= MAX_ARCHIVE_UPLOAD_BYTES);
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert!(value["observations"].as_array().unwrap().len() <= MAX_UPLOAD_OBSERVATIONS);
    }
    let current_part = spool
        .current_part(
            ArchiveSource::Claude,
            "big-session",
            &default_transcript_part_id(ArchiveSource::Claude),
        )
        .unwrap();
    let progress = spool
        .progress_part(ArchiveSource::Claude, "big-session", &current_part)
        .unwrap()
        .expect("progress advanced through remaining bytes");
    assert_eq!(progress.last_complete_byte_offset, bytes.len() as u64);
    assert_eq!(progress.record_count, uploader.bodies.borrow().len() as u64);
    let first: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    let second: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[1]).unwrap();
    assert_eq!(
        second["prior_checkpoint"]["record_count"],
        first["checkpoint"]["record_count"]
    );
    assert_eq!(
        second["prior_checkpoint"]["complete_prefix_sha256"],
        first["checkpoint"]["complete_prefix_sha256"]
    );
}

#[tokio::test]
async fn oversized_json_record_is_preserved_as_bounded_byte_segments() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(1, MAX_ARCHIVE_UPLOAD_BYTES + 1, "blocked-session");
    let current = snapshot(ArchiveSource::Claude, &bytes, 10);
    let uploader = AckingUploader::new();

    let first = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        std::slice::from_ref(&current),
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(first.failed, 0);
    assert_eq!(first.blocked, 0);
    assert!(first.uploaded > 1);
    assert!(uploader
        .bodies
        .borrow()
        .iter()
        .all(|body| body.len() <= MAX_ARCHIVE_UPLOAD_BYTES));
    let base_part = default_transcript_part_id(ArchiveSource::Claude);
    let current_part = spool
        .current_part(ArchiveSource::Claude, "blocked-session", &base_part)
        .unwrap();
    let progress = spool
        .progress_part(ArchiveSource::Claude, "blocked-session", &current_part)
        .unwrap()
        .unwrap();
    assert_eq!(progress.last_complete_byte_offset, bytes.len() as u64);

    let second = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[current],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(second.failed, 0);
    assert_eq!(second.blocked, 0);
    assert_eq!(second.uploaded, 0);
    assert!(second.first_error.is_none());

    let mut changed = bytes;
    changed.push(b' ');
    let changed_report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &changed, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(changed_report.failed, 0);
    assert_eq!(changed_report.blocked, 0);
    assert_eq!(changed_report.uploaded, 1);
}

#[tokio::test]
async fn arbitrary_large_records_upload_as_bounded_byte_segments() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let source = ArchiveSource::Claude;
    let session = "partially-blocked-session";
    let part = default_transcript_part_id(source);
    let mut bytes = Vec::new();
    for (index, pad) in [
        (0, 9_000_000),
        (1, 9_000_000),
        (2, MAX_ARCHIVE_UPLOAD_BYTES + 1),
    ] {
        let line = format!(
            r#"{{"sessionId":"{session}","uuid":"r{index}","pad":"{}"}}"#,
            "x".repeat(pad)
        );
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
    }
    let current = snapshot(source, &bytes, 10);
    let uploader = AckingUploader::new();

    let first = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        std::slice::from_ref(&current),
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(first.uploaded > 2, "{first:?}");
    assert_eq!(first.failed, 0);
    assert_eq!(first.blocked, 0);
    let first_uploads = uploader.bodies.borrow().len();
    assert_eq!(first_uploads, first.uploaded as usize);

    let second = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        std::slice::from_ref(&current),
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(second.uploaded, 0);
    assert_eq!(second.failed, 0);
    assert_eq!(second.blocked, 0);
    assert_eq!(uploader.bodies.borrow().len(), first_uploads);
    assert!(spool
        .slices_for_part(source, session, &part)
        .unwrap()
        .is_empty());

    let fitting = format!(
        r#"{{"sessionId":"{session}","uuid":"r3","pad":"{}"}}"#,
        "x".repeat(1_000)
    );
    bytes.extend_from_slice(fitting.as_bytes());
    bytes.push(b'\n');
    let third = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(source, &bytes, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(third.uploaded, 1);
    assert_eq!(third.failed, 0);
    assert_eq!(third.blocked, 0);
    assert_eq!(uploader.bodies.borrow().len(), first_uploads + 1);
    assert!(spool
        .slices_for_part(source, session, &part)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn server_stored_element_rejection_is_blocked_without_format_fallback() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::InvalidUpload {
        reason: "archive_element_exceeds_chunk_limit".to_string(),
    })]);

    let first = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(first.failed, 1);
    assert_eq!(first.blocked, 1);
    assert_eq!(
        first.first_error.as_deref(),
        Some("archive_record_too_large")
    );
    assert_eq!(uploader.calls.get(), 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
    let blocked = spool
        .blocked_part(
            ArchiveSource::Claude,
            &pending.source_session_id,
            &pending.source_transcript_part_id,
        )
        .unwrap()
        .expect("durable blocked record metadata");
    assert_eq!(blocked.source_record_identity, None);
    assert_eq!(blocked.record_size_bytes, None);
    assert_eq!(blocked.observed_file_size, CLAUDE.len() as u64);
    assert_eq!(blocked.source_fingerprint_bytes, CLAUDE.len() as u64);
    assert_eq!(
        blocked.observed_file_sha256,
        collector_archive::sha256(CLAUDE).to_string()
    );

    let second = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(second.failed, 0);
    assert_eq!(second.blocked, 0);
    assert_eq!(uploader.calls.get(), 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
}

#[test]
fn generation_record_round_trip_retains_previous_state_and_purges() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let source = ArchiveSource::Codex;
    let session = "generation-session";
    let base_part = default_transcript_part_id(source);
    let bytes = br#"{"type":"session_meta","payload":{"id":"generation-session"}}
{"type":"event_msg","payload":{"value":"rewritten"}}
"#;
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    assert_eq!(
        spool.current_part(source, session, &base_part).unwrap(),
        base_part
    );
    let pending = pending_from_bytes(source, bytes, 10);
    spool.persist_slice(&pending).unwrap();
    spool
        .persist_blocked_record(&BlockedArchiveRecord {
            source,
            source_session_id: session.to_string(),
            source_transcript_part_id: base_part.clone(),
            source_record_identity: None,
            record_size_bytes: None,
            limit_bytes: MAX_ARCHIVE_UPLOAD_BYTES as u64,
            policy_version: ARCHIVE_RECORD_POLICY_VERSION.to_string(),
            observed_file_size: bytes.len() as u64,
            source_fingerprint_bytes: bytes.len() as u64,
            observed_file_sha256: collector_archive::sha256(bytes).to_string(),
            pending_body_sha256: None,
        })
        .unwrap();
    assert!(spool
        .fork_part(
            source,
            session,
            &base_part,
            &base_part,
            &default_transcript_part_id(ArchiveSource::Claude),
            "prefix_changed",
            1_789_000_000_000,
        )
        .is_err());
    assert!(!spool
        .slices_for_part(source, session, &base_part)
        .unwrap()
        .is_empty());
    assert!(spool
        .blocked_part(source, session, &base_part)
        .unwrap()
        .is_some());
    let new_part =
        collector_archive::rewrite_transcript_part_id(source, &base_part, bytes).unwrap();
    spool
        .fork_part(
            source,
            session,
            &base_part,
            &base_part,
            &new_part,
            "prefix_changed",
            1_789_000_000_000,
        )
        .unwrap();
    drop(spool);

    let reopened = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    assert_eq!(
        reopened.current_part(source, session, &base_part).unwrap(),
        new_part
    );
    let generation = reopened
        .generation_record(source, session, &base_part)
        .unwrap()
        .unwrap();
    assert_eq!(generation.history.len(), 1);
    assert_eq!(generation.history[0].part_id, base_part);
    assert_eq!(generation.history[0].reason, "prefix_changed");
    assert!(!reopened
        .slices_for_part(source, session, &generation.history[0].part_id)
        .unwrap()
        .is_empty());
    assert!(reopened
        .blocked_part(source, session, &generation.history[0].part_id)
        .unwrap()
        .is_some());
    assert!(dir
        .path()
        .join("generations/codex/generation-session")
        .exists());

    reopened.persist_slice(&pending).unwrap();
    assert_eq!(reopened.all_pending().unwrap().len(), 1);
    assert!(!reopened
        .slices_for_part(source, session, &base_part)
        .unwrap()
        .is_empty());

    reopened.purge(&keys).unwrap();
    assert!(!dir.path().exists());
}

#[tokio::test]
async fn changed_prefix_after_ack_forks_and_uploads_from_record_zero() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"prefix-session"}}
{"type":"event_msg","payload":{"value":"before"}}
"#;
    let original_snapshot = snapshot(ArchiveSource::Codex, original, 10);
    let source_session_id = original_snapshot.source_session_id.clone();
    let base_part = original_snapshot.source_transcript_part_id.clone();
    let first = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[original_snapshot],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(first.uploaded, 1);
    assert_eq!(first.failed, 0);
    let initial_part = spool
        .current_part(ArchiveSource::Codex, &source_session_id, &base_part)
        .unwrap();

    let mut changed = original.to_vec();
    let marker = b"before";
    let marker_start = changed
        .windows(marker.len())
        .position(|window| window == marker)
        .unwrap();
    changed[marker_start..marker_start + marker.len()].copy_from_slice(b"change");
    let uploader = AckingUploader::new();
    let changed_report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, &changed, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(changed_report.failed, 0);
    assert_eq!(changed_report.forked, 1);
    assert_eq!(changed_report.fork_events.len(), 1);
    let fork = &changed_report.fork_events[0];
    assert_eq!(fork.source, ArchiveSource::Codex);
    assert_eq!(fork.source_session_id, source_session_id);
    assert_eq!(fork.previous_part_id, initial_part);
    assert_eq!(fork.reason, "prefix_changed");
    assert_eq!(fork.previous_offset, original.len() as u64);
    assert_eq!(fork.new_size, changed.len() as u64);
    assert_eq!(changed_report.uploaded, 1);
    assert_eq!(changed_report.first_error, None);
    let current_part = spool
        .current_part(ArchiveSource::Codex, &source_session_id, &base_part)
        .unwrap();
    assert_ne!(current_part, base_part);
    assert_eq!(
        spool
            .progress_part(ArchiveSource::Codex, &source_session_id, &initial_part)
            .unwrap()
            .unwrap()
            .last_complete_byte_offset,
        original.len() as u64
    );
    assert_eq!(
        spool
            .progress_part(ArchiveSource::Codex, &source_session_id, &current_part)
            .unwrap()
            .unwrap()
            .last_complete_byte_offset,
        changed.len() as u64
    );
    let body: serde_json::Value =
        serde_json::from_slice(uploader.bodies.borrow().last().unwrap()).unwrap();
    assert_eq!(body["observations"].as_array().unwrap().len(), 1);
    assert_eq!(
        body["checkpoint"]["source_transcript_part_id"],
        current_part
    );
}

#[tokio::test]
async fn shortened_compaction_forks_and_uploads_the_rewritten_prefix() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"prefix-one"}}
{"type":"event_msg","payload":{"value":"before"}}
{"type":"event_msg","payload":{"value":"after"}}
"#;
    let compacted = br#"{"type":"session_meta","payload":{"id":"prefix-one"}}
{"type":"compacted","payload":{"summary":"short"}}
"#;
    let initial = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, original, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(initial.uploaded, 1);
    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, compacted, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.failed, 0);
    assert_eq!(report.forked, 1);
    assert_eq!(report.uploaded, 1);
    let body: serde_json::Value =
        serde_json::from_slice(uploader.bodies.borrow().last().unwrap()).unwrap();
    assert_eq!(body["observations"].as_array().unwrap().len(), 1);
    let generation = spool
        .generation_record(
            ArchiveSource::Codex,
            "prefix-one",
            &default_transcript_part_id(ArchiveSource::Codex),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        generation.history.last().unwrap().reason,
        "prefix_shortened"
    );
    assert_eq!(
        generation.history.last().unwrap().superseded_at,
        TEST_NOW_MS
    );
}

#[tokio::test]
async fn compacted_baseline_completes_at_the_current_local_extent() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"baseline-compaction"}}
{"type":"event_msg","payload":{"value":"before"}}
{"type":"event_msg","payload":{"value":"after"}}
"#;
    let partial = br#"{"type":"session_meta","payload":{"id":"baseline-compaction"}}
{"type":"event_msg","payload":{"value":"before"}}
"#;
    let compacted_complete = br#"{"type":"session_meta","payload":{"id":"baseline-compaction"}}
{"type":"compacted","payload":{"summary":"current"}}
"#;
    let mut compacted = compacted_complete.to_vec();
    compacted.extend_from_slice(br#"{"type":"event_msg","payload":{"value":"unfinished"}"#);
    let source = ArchiveSource::Codex;
    let session = "baseline-compaction";
    let base_part = default_transcript_part_id(source);
    let state = ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 10,
        },
        10,
        vec![ArchiveBaselineTarget {
            source_session_id: session.to_string(),
            source_transcript_part_id: base_part.clone(),
            activity_rank_ms: 10,
            registered_size_bytes: original.len() as u64,
            registered_complete_byte_offset: original.len() as u64,
        }],
    );
    let initial_plan =
        ArchiveHistoryPlan::new(vec![state.clone()]).with_present_part_extents(vec![(
            source,
            session.to_string(),
            base_part.clone(),
            partial.len() as u64,
        )]);
    let initial = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(source, partial, 10)],
        ArchivePolicy::Enrolled,
        &initial_plan,
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(
        initial.history[0].initial_import,
        ArchiveInitialImport::InProgress
    );

    let current_plan = ArchiveHistoryPlan::new(vec![state]).with_present_part_extents(vec![(
        source,
        session.to_string(),
        base_part,
        compacted_complete.len() as u64,
    )]);
    let report = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(source, &compacted, 11)],
        ArchivePolicy::Enrolled,
        &current_plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.failed, 0);
    assert_eq!(report.forked, 1);
    assert_eq!(report.history[0].completed_targets, 1);
    assert_eq!(
        report.history[0].initial_import,
        ArchiveInitialImport::Complete
    );
}

#[tokio::test]
async fn changed_prefix_retains_and_uploads_unacknowledged_predecessor() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"pending-rewrite"}}
{"type":"event_msg","payload":{"value":"original"}}
"#;
    support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, original, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    let base_part = default_transcript_part_id(ArchiveSource::Codex);
    let initial_part = spool
        .current_part(ArchiveSource::Codex, "pending-rewrite", &base_part)
        .unwrap();
    let progress = spool
        .progress_part(ArchiveSource::Codex, "pending-rewrite", &initial_part)
        .unwrap()
        .unwrap();
    let appended = [
        original.as_slice(),
        b"{\"type\":\"event_msg\",\"payload\":{\"value\":\"unacknowledged\"}}\n",
    ]
    .concat();
    let pending = build_bounded_pending_for_part(
        ArchiveSource::Codex,
        "pending-rewrite",
        &initial_part,
        &appended,
        11,
        Some(&progress),
    )
    .unwrap()
    .unwrap();
    spool.persist_slice(&pending).unwrap();

    let rewritten = br#"{"type":"session_meta","payload":{"id":"pending-rewrite"}}
{"type":"event_msg","payload":{"value":"rewritten"}}
"#;
    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, rewritten, 12)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.forked, 1);
    assert_eq!(report.failed, 0);
    assert_eq!(uploader.bodies.borrow().len(), 2);
    assert!(uploader
        .bodies
        .borrow()
        .iter()
        .any(|body| body == &pending.body));
    assert!(spool
        .slices_for_part(ArchiveSource::Codex, "pending-rewrite", &initial_part)
        .unwrap()
        .is_empty());

    let retry = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(retry.failed, 0);
    assert_eq!(retry.uploaded, 0);
    assert!(spool
        .slices_for_part(ArchiveSource::Codex, "pending-rewrite", &initial_part)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn new_only_retry_uses_capture_authorization_after_source_deletion() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let snapshot = snapshot(ArchiveSource::Codex, CODEX, 20);
    let session = snapshot.source_session_id.clone();
    let state = ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: ArchiveSource::Codex,
            history_choice: ArchiveHistoryChoice::NewOnly,
            authorized_at: 10,
        },
        10,
        Vec::new(),
    );
    let capture_plan = ArchiveHistoryPlan::new(vec![state.clone()]).with_live_sessions(vec![(
        ArchiveSource::Codex,
        session.clone(),
        20,
    )]);
    let unavailable = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);

    let captured = support::capture_and_upload(
        &unavailable,
        &mut spool,
        &keys,
        std::slice::from_ref(&snapshot),
        ArchivePolicy::Enrolled,
        &capture_plan,
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(captured.captured, 1);
    assert_eq!(captured.uploaded, 0);
    let current_part = spool
        .current_part(
            ArchiveSource::Codex,
            &session,
            &snapshot.source_transcript_part_id,
        )
        .unwrap();
    let persisted = spool
        .pending_part(ArchiveSource::Codex, &session, &current_part)
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.capture_authorization,
        Some(collector_archive_sync::PendingCaptureAuthorization {
            history_choice: ArchiveHistoryChoice::NewOnly,
            authorized_at: 10,
        })
    );

    let retry_plan = ArchiveHistoryPlan::new(vec![state]);
    let uploader = AckingUploader::new();
    let retried = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &retry_plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(retried.failed, 0, "{retried:?}");
    assert_eq!(retried.uploaded, 1);
    assert!(spool
        .pending_part(ArchiveSource::Codex, &session, &current_part)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_second_rewrite_forks_from_the_current_part() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"twice"}}
{"type":"event_msg","payload":{"value":"one"}}
"#;
    support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, original, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    let first_rewrite = br#"{"type":"session_meta","payload":{"id":"twice"}}
{"type":"compacted","payload":{"summary":"two"}}
"#;
    let first_snapshot = current_snapshot(&spool, ArchiveSource::Codex, first_rewrite, 11);
    let first = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[first_snapshot],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(first.forked, 1);
    let second_rewrite = br#"{"type":"session_meta","payload":{"id":"twice"}}
{"type":"compacted","payload":{"summary":"three"}}
"#;
    let second_snapshot = current_snapshot(&spool, ArchiveSource::Codex, second_rewrite, 12);
    let second = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[second_snapshot],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(second.forked, 1);
    let generation = spool
        .generation_record(
            ArchiveSource::Codex,
            "twice",
            &default_transcript_part_id(ArchiveSource::Codex),
        )
        .unwrap()
        .unwrap();
    assert_eq!(generation.history.len(), 3);
    assert_eq!(generation.history[1].reason, "prefix_changed");
    assert_eq!(generation.history[2].reason, "prefix_changed");
}

#[tokio::test]
async fn append_after_a_fork_continues_on_the_current_part() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let original = br#"{"type":"session_meta","payload":{"id":"append-after-fork"}}
{"type":"event_msg","payload":{"value":"one"}}
"#;
    support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Codex, original, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    let rewritten = br#"{"type":"session_meta","payload":{"id":"append-after-fork"}}
{"type":"compacted","payload":{"summary":"two"}}
"#;
    let rewrite_snapshot = current_snapshot(&spool, ArchiveSource::Codex, rewritten, 11);
    support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[rewrite_snapshot],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    let appended = [
        rewritten.as_slice(),
        b"{\"type\":\"event_msg\",\"payload\":{\"value\":\"three\"}}\n",
    ]
    .concat();
    let append_snapshot = current_snapshot(&spool, ArchiveSource::Codex, &appended, 12);
    let report = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[append_snapshot],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.forked, 0);
    assert_eq!(report.uploaded, 1);
    let generation = spool
        .generation_record(
            ArchiveSource::Codex,
            "append-after-fork",
            &default_transcript_part_id(ArchiveSource::Codex),
        )
        .unwrap()
        .unwrap();
    assert_eq!(generation.history.len(), 2);
}

#[tokio::test]
async fn server_rejection_keeps_exact_single_record_metadata() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = b"{\"uuid\":\"single\",\"sessionId\":\"single-server-rejection\"}\n";
    let pending = pending_from_bytes(ArchiveSource::Claude, bytes, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::InvalidUpload {
        reason: "archive_element_exceeds_chunk_limit".to_string(),
    })]);

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(
        report.first_error.as_deref(),
        Some("archive_record_too_large")
    );
    let blocked = spool
        .blocked_part(
            ArchiveSource::Claude,
            &pending.source_session_id,
            &pending.source_transcript_part_id,
        )
        .unwrap()
        .expect("durable blocked record metadata");
    assert!(blocked
        .source_record_identity
        .as_deref()
        .is_some_and(|identity| identity.contains("claude:id:single:0")));
    assert_eq!(blocked.record_size_bytes, Some(bytes.len() as u64 - 1));
}

#[tokio::test]
async fn unsupported_wire_stays_pending_and_retries_the_identical_body() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let mut pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let mut value: serde_json::Value = serde_json::from_slice(&pending.body).unwrap();
    value["archive_upload_wire_version"] = serde_json::json!(2);
    pending.body = serde_json::to_vec(&value).unwrap();
    spool.persist_pending(&pending).unwrap();
    let unsupported = || {
        Err(ArchiveClientError::InvalidUpload {
            reason: "unsupported_archive_upload_wire_version".to_string(),
        })
    };
    let uploader = ScriptedUploader::new([unsupported(), unsupported()]);

    for _ in 0..2 {
        let report = support::capture_and_upload(
            &uploader,
            &mut spool,
            &keys,
            &[],
            ArchivePolicy::Enrolled,
            &plan_for(ALL_ARCHIVE_SOURCES),
            TEST_NOW_MS,
            None,
        )
        .await;
        assert_eq!(
            report.first_error.as_deref(),
            Some("archive_wire_unsupported")
        );
        assert_eq!(report.blocked, 0);
    }
    assert_eq!(uploader.calls.get(), 2);
    assert!(uploader
        .bodies
        .borrow()
        .iter()
        .all(|body| body == &pending.body));
    assert!(spool
        .blocked_part(
            ArchiveSource::Claude,
            &pending.source_session_id,
            &pending.source_transcript_part_id,
        )
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn bounded_upload_failure_keeps_later_records_after_source_disappears() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(300, 30_000, "disappear-session");
    let first = collector_archive_sync::build_bounded_pending_for_part(
        ArchiveSource::Claude,
        "disappear-session",
        &default_transcript_part_id(ArchiveSource::Claude),
        &bytes,
        10,
        None,
    )
    .unwrap()
    .expect("first bounded request");
    assert!(first.expected_record_count >= 1);
    assert!(first.expected_record_count < 300);

    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &bytes, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 0);
    assert_eq!(report.failed, 1);
    assert!(report.captured >= 2);
    assert_eq!(uploader.calls.get(), 1);

    let ready: Vec<PendingArchiveRequest> = spool
        .all_pending()
        .unwrap()
        .into_iter()
        .filter_map(|load| match load {
            PendingLoad::Ready(record) => Some(record),
            PendingLoad::Corrupt { .. } => None,
        })
        .collect();
    assert!(
        ready.len() >= 2,
        "every observed bounded request must be durable before upload can stop"
    );
    assert_eq!(pending_payload_bytes(&ready), bytes);
    assert_eq!(
        ready
            .iter()
            .map(|record| record.expected_record_count)
            .max(),
        Some(ready.len() as u64)
    );

    drop(spool);
    let mut relaunched = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let ack = AckingUploader::new();
    let replay = support::capture_and_upload(
        &ack,
        &mut relaunched,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(replay.failed, 0);
    assert!(replay.uploaded >= 2);
    assert!(replay.first_error.is_none());
    assert_eq!(ack.session_record_count.get(), ready.len() as u64);
    assert!(ack.bodies.borrow().len() >= 2);
    assert!(relaunched
        .all_pending()
        .unwrap()
        .iter()
        .all(|load| !matches!(load, PendingLoad::Ready(_))));
    assert!(relaunched
        .pending(ArchiveSource::Claude, "disappear-session")
        .unwrap()
        .is_none());
    let current_part = relaunched
        .current_part(
            ArchiveSource::Claude,
            "disappear-session",
            &default_transcript_part_id(ArchiveSource::Claude),
        )
        .unwrap();
    let progress = relaunched
        .progress_part(ArchiveSource::Claude, "disappear-session", &current_part)
        .unwrap()
        .expect("progress recovered every observed byte");
    assert_eq!(progress.last_complete_byte_offset, bytes.len() as u64);
}

#[tokio::test]
async fn existing_pending_does_not_strand_later_observed_bytes() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(300, 30_000, "pending-session");
    let initial_bytes = padded_records(100, 30_000, "pending-session");
    let initial_uploader = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);
    let initial = support::capture_and_upload(
        &initial_uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &initial_bytes, 10)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(initial.uploaded, 0);
    assert_eq!(initial.failed, 1);
    assert!(initial.captured > 1);

    let uploader = ScriptedUploader::new([
        Err(ArchiveClientError::Unavailable {
            reason: "archive unavailable".to_string(),
        }),
        Err(ArchiveClientError::Unavailable {
            reason: "archive unavailable".to_string(),
        }),
    ]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &bytes, 11)],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 0);
    assert!(report.failed >= 1);
    assert!(report.captured >= 1);

    let ready: Vec<PendingArchiveRequest> = spool
        .all_pending()
        .unwrap()
        .into_iter()
        .filter_map(|load| match load {
            PendingLoad::Ready(record) => Some(record),
            PendingLoad::Corrupt { .. } => None,
        })
        .collect();
    assert!(
        ready.len() >= 2,
        "existing pending must not skip later observed snapshot bytes"
    );
    assert_eq!(pending_payload_bytes(&ready), bytes);

    drop(spool);
    let mut relaunched = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let ack = AckingUploader::new();
    let replay = support::capture_and_upload(
        &ack,
        &mut relaunched,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(replay.failed, 0);
    assert!(replay.uploaded >= 2);
    assert_eq!(ack.session_record_count.get(), ready.len() as u64);
    let current_part = relaunched
        .current_part(
            ArchiveSource::Claude,
            "pending-session",
            &default_transcript_part_id(ArchiveSource::Claude),
        )
        .unwrap();
    let progress = relaunched
        .progress_part(ArchiveSource::Claude, "pending-session", &current_part)
        .unwrap()
        .expect("existing-pending remainder recovered after source disappearance");
    assert_eq!(progress.last_complete_byte_offset, bytes.len() as u64);
}

#[tokio::test]
async fn oversized_session_splits_at_observation_count() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(5, 8, "count-session");
    let pending = collector_archive_sync::build_bounded_pending_for_part_with_limits(
        ArchiveSource::Claude,
        "count-session",
        &default_transcript_part_id(ArchiveSource::Claude),
        &bytes,
        10,
        None,
        MAX_ARCHIVE_UPLOAD_BYTES,
        2,
    )
    .unwrap()
    .unwrap();
    assert_eq!(pending.expected_record_count, 2);
    assert_eq!(pending.expected_appended_records, 2);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([Ok(ack_for(&pending))]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    let progress = spool
        .progress(ArchiveSource::Claude, "count-session")
        .unwrap()
        .unwrap();
    assert_eq!(progress.record_count, 2);
    let rest = collector_archive_sync::build_bounded_pending_for_part_with_limits(
        ArchiveSource::Claude,
        "count-session",
        &default_transcript_part_id(ArchiveSource::Claude),
        &bytes,
        11,
        Some(&progress),
        MAX_ARCHIVE_UPLOAD_BYTES,
        2,
    )
    .unwrap()
    .unwrap();
    assert_eq!(rest.expected_record_count, 4);
    assert_eq!(rest.expected_appended_records, 2);
}

#[tokio::test]
async fn acknowledgement_at_exact_cap_clears_pending() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let mut spool =
        ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES).unwrap();
    spool.persist_pending(&pending).unwrap();
    let acknowledgement = ack_for(&pending);
    let staging = spool
        .verified_ack_transition_len(&pending, &acknowledgement)
        .unwrap();
    pad_spool_leaving_room(dir.path(), ARCHIVE_SPOOL_CAP_BYTES, staging);
    assert_eq!(
        real_durable_bytes(dir.path()).saturating_add(staging),
        ARCHIVE_SPOOL_CAP_BYTES
    );
    let uploader = ScriptedUploader::new([Ok(acknowledgement)]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.failed, 0);
    assert!(real_durable_bytes(dir.path()) <= ARCHIVE_SPOOL_CAP_BYTES);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
    assert!(spool
        .progress(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_some());
}

#[test]
fn relaunch_clears_pending_already_covered_by_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let scan = scan_claude_jsonl(&pending.source_session_id, CLAUDE, 10, None).unwrap();
    let used = {
        let spool = ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, u64::MAX).unwrap();
        spool.persist_pending(&pending).unwrap();
        spool
            .persist_progress(
                ArchiveSource::Claude,
                &pending.source_session_id,
                &scan.checkpoint,
            )
            .unwrap();
        assert!(spool
            .pending(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .is_some());
        spool.on_disk_bytes().unwrap()
    };
    let relaunched = ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, used).unwrap();
    assert!(relaunched
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
    assert_eq!(
        relaunched
            .progress(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .unwrap()
            .record_count,
        scan.checkpoint.record_count
    );
}

#[tokio::test]
async fn corrupt_claude_pending_does_not_block_codex() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let claude = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let codex = pending_from_bytes(ArchiveSource::Codex, CODEX, 11);
    spool.persist_pending(&claude).unwrap();
    spool.persist_pending(&codex).unwrap();
    let path = pending_disk_path(dir.path(), &claude);
    let mut blob = fs::read(&path).unwrap();
    let last = blob.len() - 1;
    blob[last] ^= 0xff;
    fs::write(&path, &blob).unwrap();
    assert_eq!(fs::read(&path).unwrap(), blob);

    let uploader = ScriptedUploader::new([Ok(ack_for(&codex))]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.failed, 1);
    assert_eq!(report.first_error.as_deref(), Some("archive_spool_corrupt"));
    assert_eq!(fs::read(&path).unwrap(), blob);
    assert!(spool
        .pending(ArchiveSource::Claude, &claude.source_session_id)
        .is_err());
    assert!(spool
        .pending(ArchiveSource::Codex, &codex.source_session_id)
        .unwrap()
        .is_none());
    let loads = spool.all_pending().unwrap();
    assert!(loads.iter().any(|load| matches!(
        load,
        PendingLoad::Corrupt {
            source: ArchiveSource::Claude,
            class: "archive_spool_corrupt",
            ..
        }
    )));
}

#[tokio::test]
async fn claude_parent_and_subagent_same_session_upload_independently() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let parent_bytes = br#"{"sessionId":"session-1","uuid":"parent-1"}
{"sessionId":"session-1","uuid":"parent-2"}
"#;
    let subagent_bytes = br#"{"sessionId":"session-1","uuid":"sub-1","agentId":"agent-001"}
{"sessionId":"session-1","uuid":"sub-2","agentId":"agent-001"}
"#;
    let parent_part = default_transcript_part_id(ArchiveSource::Claude);
    let sub_part = claude_transcript_part_id("agent-001").unwrap();
    let snapshots = [
        ArchiveSnapshot {
            relative_path: None,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            base_transcript_part_id: parent_part.clone(),
            source_transcript_part_id: parent_part.clone(),
            bytes: parent_bytes.to_vec(),
            deferred_file: None,
            observed_at: 10,
            class: ArchiveWorkClass::Live,
            activity_rank_ms: None,
        },
        ArchiveSnapshot {
            relative_path: None,
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            base_transcript_part_id: sub_part.clone(),
            source_transcript_part_id: sub_part.clone(),
            bytes: subagent_bytes.to_vec(),
            deferred_file: None,
            observed_at: 11,
            class: ArchiveWorkClass::Live,
            activity_rank_ms: None,
        },
    ];
    let uploader = AckingUploader::new();
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &snapshots,
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 2);
    assert_eq!(report.failed, 0);
    assert_eq!(uploader.bodies.borrow().len(), 2);
    let first: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    let second: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[1]).unwrap();
    let captured_parent_part = first["checkpoint"]["source_transcript_part_id"]
        .as_str()
        .unwrap();
    let captured_sub_part = second["checkpoint"]["source_transcript_part_id"]
        .as_str()
        .unwrap();
    assert_ne!(captured_parent_part, parent_part);
    assert_ne!(captured_sub_part, sub_part);
    assert_ne!(captured_parent_part, captured_sub_part);
    assert_eq!(first["checkpoint"]["record_count"], 1);
    assert_eq!(second["checkpoint"]["record_count"], 1);
    let parent_progress = spool
        .progress_part(ArchiveSource::Claude, "session-1", captured_parent_part)
        .unwrap()
        .unwrap();
    let sub_progress = spool
        .progress_part(ArchiveSource::Claude, "session-1", captured_sub_part)
        .unwrap()
        .unwrap();
    assert_eq!(parent_progress.record_count, 1);
    assert_eq!(sub_progress.record_count, 1);
    assert_ne!(
        parent_progress.source_transcript_part_id(),
        sub_progress.source_transcript_part_id()
    );
    assert_ne!(
        parent_progress.prefix_chain_sha256,
        sub_progress.prefix_chain_sha256
    );
}

#[tokio::test]
async fn missing_or_empty_agent_id_subagent_does_not_collide_with_parent_across_relaunch() {
    let parent_path = "/home/.claude/projects/p/session-1.jsonl";
    let cases = [
        (
            "/home/.claude/projects/p/session-1/subagents/child.jsonl",
            br#"{"sessionId":"session-1","uuid":"sub-1"}
{"sessionId":"session-1","uuid":"sub-2"}
"#
            .as_slice(),
            "path:child.jsonl",
        ),
        (
            "/home/.claude/projects/p/session-1/subagents/empty.jsonl",
            br#"{"sessionId":"session-1","uuid":"sub-empty-1","agentId":""}
{"sessionId":"session-1","uuid":"sub-empty-2","agentId":"   "}
"#
            .as_slice(),
            "path:empty.jsonl",
        ),
    ];
    for (child_path, child_bytes, expected_identity) in cases {
        let dir = TempDir::new().unwrap();
        let keys = MemoryKeyStore::new();
        let parent_bytes = br#"{"sessionId":"session-1","uuid":"parent-1"}
{"sessionId":"session-1","uuid":"parent-2"}
"#;
        let child = snapshot_for_path(ArchiveSource::Claude, child_path, child_bytes, 10);
        let parent = snapshot_for_path(ArchiveSource::Claude, parent_path, parent_bytes, 11);
        let parent_part = default_transcript_part_id(ArchiveSource::Claude);
        let child_part = claude_transcript_part_id(expected_identity).unwrap();
        assert_eq!(child.source_transcript_part_id, child_part);
        assert_eq!(parent.source_transcript_part_id, parent_part);
        assert_ne!(child_part, parent_part);

        let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
        let uploader = AckingUploader::new();
        let first = support::capture_and_upload(
            &uploader,
            &mut spool,
            &keys,
            &[child.clone(), parent.clone()],
            ArchivePolicy::Enrolled,
            &plan_for(ALL_ARCHIVE_SOURCES),
            TEST_NOW_MS,
            None,
        )
        .await;
        assert_eq!(first.failed, 0, "child-first cycle must isolate parts");
        assert_eq!(first.uploaded, 2);
        let captured_child_part = spool
            .current_part(ArchiveSource::Claude, "session-1", &child_part)
            .unwrap();
        let captured_parent_part = spool
            .current_part(ArchiveSource::Claude, "session-1", &parent_part)
            .unwrap();
        assert_ne!(captured_child_part, child_part);
        assert_ne!(captured_parent_part, parent_part);
        assert_ne!(captured_child_part, captured_parent_part);
        drop(spool);

        let parent_append = snapshot_for_path(
            ArchiveSource::Claude,
            parent_path,
            br#"{"sessionId":"session-1","uuid":"parent-1"}
{"sessionId":"session-1","uuid":"parent-2"}
{"sessionId":"session-1","uuid":"parent-3"}
"#,
            12,
        );
        let mut relaunched = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
        let relaunch_uploader = AckingUploader::new();
        let second = support::capture_and_upload(
            &relaunch_uploader,
            &mut relaunched,
            &keys,
            &[child, parent_append],
            ArchivePolicy::Enrolled,
            &plan_for(ALL_ARCHIVE_SOURCES),
            TEST_NOW_MS,
            None,
        )
        .await;
        assert_eq!(second.failed, 0, "relaunch must keep parent progressing");
        assert_eq!(second.uploaded, 1);
        let relaunch_body =
            serde_json::from_slice::<serde_json::Value>(&relaunch_uploader.bodies.borrow()[0])
                .unwrap();
        assert_eq!(
            relaunch_body["checkpoint"]["source_transcript_part_id"].as_str(),
            Some(captured_parent_part.as_str())
        );
        assert_eq!(relaunch_body["checkpoint"]["record_count"], 2);
        let parent_progress = relaunched
            .progress_part(ArchiveSource::Claude, "session-1", &captured_parent_part)
            .unwrap()
            .unwrap();
        let child_progress = relaunched
            .progress_part(ArchiveSource::Claude, "session-1", &captured_child_part)
            .unwrap()
            .unwrap();
        assert_eq!(parent_progress.record_count, 2);
        assert_eq!(child_progress.record_count, 1);
        assert_ne!(
            parent_progress.source_transcript_part_id(),
            child_progress.source_transcript_part_id()
        );
    }
}

#[test]
fn missing_key_with_existing_ciphertext_does_not_mint_a_replacement() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let path = pending_disk_path(dir.path(), &pending);
    let original_key = {
        let spool =
            ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES)
                .unwrap();
        spool.persist_pending(&pending).unwrap();
        pad_spool_leaving_room(dir.path(), ARCHIVE_SPOOL_CAP_BYTES, 0);
        assert_eq!(real_durable_bytes(dir.path()), ARCHIVE_SPOOL_CAP_BYTES);
        keys.load("org_1").unwrap().unwrap()
    };
    let original_bytes = *original_key.as_bytes();
    let ciphertext = fs::read(&path).unwrap();
    keys.delete("org_1").unwrap();

    match ArchiveSpool::open(dir.path(), "org_1", &keys) {
        Err(ArchiveSyncError::Corrupt) => {}
        Ok(_) => panic!("missing key must not mint a replacement over existing ciphertext"),
        Err(err) => panic!("expected archive_spool_corrupt, got {}", err.class()),
    }
    assert!(keys.load("org_1").unwrap().is_none());
    assert_eq!(fs::read(&path).unwrap(), ciphertext);
    assert_eq!(real_durable_bytes(dir.path()), ARCHIVE_SPOOL_CAP_BYTES);

    match ArchiveSpool::open(dir.path(), "org_1", &keys) {
        Err(ArchiveSyncError::Corrupt) => {}
        Ok(_) => panic!("relaunch must still refuse to mint a replacement key"),
        Err(err) => panic!("expected archive_spool_corrupt, got {}", err.class()),
    }
    assert!(keys.load("org_1").unwrap().is_none());

    let replacement = ArchiveSpoolKey::generate().unwrap();
    assert_ne!(replacement.as_bytes(), &original_bytes);
    keys.store("org_1", &ArchiveSpoolKey::from_bytes(original_bytes))
        .unwrap();
    let restored = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    assert_eq!(fs::read(&path).unwrap(), ciphertext);
    assert_eq!(
        restored
            .pending(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .unwrap()
            .body,
        pending.body
    );
    assert_eq!(restored.on_disk_bytes().unwrap(), ARCHIVE_SPOOL_CAP_BYTES);
    let extra = pending_from_bytes(ArchiveSource::Codex, CODEX, 11);
    assert!(matches!(
        restored.persist_pending(&extra),
        Err(ArchiveSyncError::CapacityExceeded)
    ));
    assert_eq!(fs::read(&path).unwrap(), ciphertext);
}

#[test]
fn acknowledgement_unlink_failure_never_exceeds_exact_cap() {
    acknowledgement_transition_stays_within_exact_cap();
}

#[test]
fn acknowledgement_transition_bytes_stay_within_exact_cap() {
    acknowledgement_transition_stays_within_exact_cap();
}

fn acknowledgement_transition_stays_within_exact_cap() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let spool =
        ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES).unwrap();
    spool.persist_pending(&pending).unwrap();
    let staging = spool.ack_transition_len(&pending).unwrap();
    pad_spool_leaving_room(dir.path(), ARCHIVE_SPOOL_CAP_BYTES, staging);
    assert_eq!(
        real_durable_bytes(dir.path()).saturating_add(staging),
        ARCHIVE_SPOOL_CAP_BYTES
    );
    spool.debug_fail_next_pending_clear();
    let checkpoint = checkpoint_from_pending(&pending);
    assert!(spool.commit_acknowledgement(&pending, &checkpoint).is_err());
    let after_fail = real_durable_bytes(dir.path());
    assert!(after_fail <= ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(after_fail, ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(spool.on_disk_bytes().unwrap(), after_fail);
    assert!(pending_disk_path(dir.path(), &pending).exists());
    assert!(!progress_disk_path(dir.path(), &pending).exists());
    assert!(ack_staging_disk_path(dir.path(), &pending).exists());

    let relaunched =
        ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES).unwrap();
    let after_relaunch = real_durable_bytes(dir.path());
    assert!(after_relaunch <= ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(relaunched.on_disk_bytes().unwrap(), after_relaunch);
    assert!(relaunched
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
    assert_eq!(
        relaunched
            .progress(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .unwrap()
            .record_count,
        checkpoint.record_count
    );
    assert!(!pending_disk_path(dir.path(), &pending).exists());
    assert!(progress_disk_path(dir.path(), &pending).exists());
    assert!(!ack_staging_disk_path(dir.path(), &pending).exists());
}

#[test]
fn repeated_acknowledgement_failure_counts_nested_tmp_file_bytes() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let spool =
        ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES).unwrap();
    spool.persist_pending(&pending).unwrap();
    let staging = spool.ack_transition_len(&pending).unwrap();
    let used = actual_file_bytes(dir.path());
    let pad = ARCHIVE_SPOOL_CAP_BYTES
        .saturating_sub(used)
        .saturating_sub(staging.saturating_mul(2));
    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dir.path().join("pad.bin"))
        .unwrap();
    file.set_len(pad).unwrap();
    assert_eq!(
        actual_file_bytes(dir.path()).saturating_add(staging.saturating_mul(2)),
        ARCHIVE_SPOOL_CAP_BYTES
    );

    let checkpoint = checkpoint_from_pending(&pending);
    spool.debug_fail_next_pending_clear();
    assert!(spool.commit_acknowledgement(&pending, &checkpoint).is_err());
    assert!(ack_staging_disk_path(dir.path(), &pending).exists());
    assert!(!ack_scratch_disk_path(dir.path(), &pending).exists());
    assert_eq!(
        actual_file_bytes(dir.path()),
        ARCHIVE_SPOOL_CAP_BYTES.saturating_sub(staging)
    );

    spool.debug_fail_next_ack_scratch_rename();
    assert!(spool.commit_acknowledgement(&pending, &checkpoint).is_err());
    assert!(ack_staging_disk_path(dir.path(), &pending).exists());
    assert!(ack_scratch_disk_path(dir.path(), &pending).exists());
    let after_repeat = actual_file_bytes(dir.path());
    assert!(after_repeat <= ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(after_repeat, ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(spool.on_disk_bytes().unwrap(), after_repeat);

    let relaunched =
        ArchiveSpool::open_with_cap(dir.path(), "org_1", &keys, ARCHIVE_SPOOL_CAP_BYTES).unwrap();
    let after_relaunch = actual_file_bytes(dir.path());
    assert!(after_relaunch <= ARCHIVE_SPOOL_CAP_BYTES);
    assert_eq!(relaunched.on_disk_bytes().unwrap(), after_relaunch);
    assert!(relaunched
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
    assert_eq!(
        relaunched
            .progress(ArchiveSource::Claude, &pending.source_session_id)
            .unwrap()
            .unwrap()
            .record_count,
        checkpoint.record_count
    );
    assert!(!pending_disk_path(dir.path(), &pending).exists());
    assert!(progress_disk_path(dir.path(), &pending).exists());
    assert!(!ack_staging_disk_path(dir.path(), &pending).exists());
    assert!(!ack_scratch_disk_path(dir.path(), &pending).exists());
}

#[tokio::test]
async fn session_aggregate_duplicate_parent_rescan_advances() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let parent_bytes = br#"{"sessionId":"session-1","uuid":"parent-1"}
"#;
    let pending = pending_from_bytes(ArchiveSource::Claude, parent_bytes, 10);
    assert_eq!(pending.expected_record_count, 1);
    assert_eq!(pending.expected_appended_records, 1);
    spool.persist_pending(&pending).unwrap();
    let ack = server_aggregate_duplicate_ack(&pending);
    assert!(acknowledgement_matches(&pending, &ack));
    let uploader = ScriptedUploader::new([Ok(ack)]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(report.failed, 0);
    assert!(spool
        .pending(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .is_none());
    let progress = spool
        .progress(ArchiveSource::Claude, &pending.source_session_id)
        .unwrap()
        .unwrap();
    assert_eq!(progress.record_count, pending.expected_record_count);
    assert_eq!(progress.record_count, 1);
}

#[tokio::test]
async fn failing_keyring_delete_does_not_claim_purge() {
    let dir = TempDir::new().unwrap();
    let keys = FailingDeleteKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    assert!(keys.load("org_1").unwrap().is_some());
    let uploader = ScriptedUploader::new([]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Revoked,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(!report.purged);
    assert!(report.failed >= 1);
    assert_eq!(
        report.first_error.as_deref(),
        Some("archive_key_unavailable")
    );
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(pending_disk_path(dir.path(), &pending).exists());

    let live_dir = TempDir::new().unwrap();
    let live_keys = FailingDeleteKeyStore::new();
    let mut live_spool = ArchiveSpool::open(live_dir.path(), "org_1", &live_keys).unwrap();
    let live_pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    live_spool.persist_pending(&live_pending).unwrap();
    let live_uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "credential_revoked".to_string(),
    })]);
    let live_report = support::capture_and_upload(
        &live_uploader,
        &mut live_spool,
        &live_keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(!live_report.purged);
    assert!(live_report.failed >= 1);
    assert_eq!(
        live_report.first_error.as_deref(),
        Some("archive_key_unavailable")
    );
    assert!(live_keys.load("org_1").unwrap().is_some());
    assert!(pending_disk_path(live_dir.path(), &live_pending).exists());

    let stop_dir = TempDir::new().unwrap();
    let stop_keys = FailingDeleteKeyStore::new();
    let mut stop_spool = ArchiveSpool::open(stop_dir.path(), "org_1", &stop_keys).unwrap();
    let stop_pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    stop_spool.persist_pending(&stop_pending).unwrap();
    let later = snapshot(ArchiveSource::Codex, CODEX, 11);
    let later_session = later.source_session_id.clone();
    let stop_uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "credential_revoked".to_string(),
    })]);
    let stop_report = support::capture_and_upload(
        &stop_uploader,
        &mut stop_spool,
        &stop_keys,
        &[later],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(!stop_report.purged);
    assert!(stop_report.halted);
    assert_eq!(stop_report.captured, 1);
    assert!(stop_spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|load| matches!(load, PendingLoad::Ready(pending) if pending.source == ArchiveSource::Codex && pending.source_session_id == later_session)));
}

#[tokio::test]
async fn enrollment_invalid_failed_delete_retries_cleanup_after_relaunch() {
    let dir = TempDir::new().unwrap();
    let spool_dir = dir.path().join("spool");
    let enroll = dir.path().join("archive-enrollment.json");
    ArchiveEnrollmentRecord::save(&enroll, ArchivePolicy::Enrolled).unwrap();
    let keys = FailingDeleteKeyStore::new();
    let mut spool = ArchiveSpool::open(&spool_dir, "org_1", &keys).unwrap();
    spool.set_enrollment_path(&enroll);
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "enrollment_invalid".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(!report.purged);
    assert!(report.failed >= 1);
    assert_eq!(
        ArchiveEnrollmentRecord::load(&enroll).unwrap(),
        ArchivePolicy::Revoked
    );
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(spool.cleanup_required());

    let policy = ArchiveEnrollmentRecord::load(&enroll).unwrap();
    assert_eq!(policy, ArchivePolicy::Revoked);
    let mut relaunched = ArchiveSpool::open_existing(&spool_dir, "org_1", &keys)
        .unwrap()
        .expect("retained spool after failed purge");
    relaunched.set_enrollment_path(&enroll);
    let later = snapshot(ArchiveSource::Codex, CODEX, 11);
    let later_session = later.source_session_id.clone();
    let unavailable = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);
    let relaunch_report = support::capture_and_upload(
        &unavailable,
        &mut relaunched,
        &keys,
        &[later],
        policy,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(unavailable.calls.get(), 0);
    assert_eq!(relaunch_report.captured, 0);
    assert!(!relaunch_report.purged);
    assert!(relaunch_report.failed >= 1);
    assert_eq!(
        relaunch_report.first_error.as_deref(),
        Some("archive_key_unavailable")
    );
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(relaunched
        .pending(ArchiveSource::Codex, &later_session)
        .unwrap()
        .is_none());
    assert_eq!(
        ArchiveEnrollmentRecord::load(&enroll).unwrap(),
        ArchivePolicy::Revoked
    );
}

#[tokio::test]
async fn failing_policy_replace_blocks_all_sources_and_retries_purge() {
    let dir = TempDir::new().unwrap();
    let spool_dir = dir.path().join("spool");
    let enroll = dir.path().join("archive-enrollment.json");
    ArchiveEnrollmentRecord::save(&enroll, ArchivePolicy::Enrolled).unwrap();
    fs::remove_file(&enroll).unwrap();
    fs::create_dir(&enroll).unwrap();
    let keys = FailingDeleteKeyStore::new();
    let mut spool = ArchiveSpool::open(&spool_dir, "org_1", &keys).unwrap();
    spool.set_enrollment_path(&enroll);
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let later = snapshot(ArchiveSource::Codex, CODEX, 11);
    let later_session = later.source_session_id.clone();
    let uploader = ScriptedUploader::new([Err(ArchiveClientError::Forbidden {
        reason: "enrollment_invalid".to_string(),
    })]);
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[later],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert!(!report.purged);
    assert!(report.halted);
    assert_eq!(report.captured, 1);
    assert!(spool.cleanup_required());
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(pending_disk_path(&spool_dir, &pending).exists());
    assert!(spool
        .all_pending()
        .unwrap()
        .iter()
        .any(|load| matches!(load, PendingLoad::Ready(pending) if pending.source == ArchiveSource::Codex && pending.source_session_id == later_session)));

    let mut relaunched = ArchiveSpool::open_existing(&spool_dir, "org_1", &keys)
        .unwrap()
        .expect("retained spool after failed purge");
    relaunched.set_enrollment_path(&enroll);
    let relaunch_later = snapshot(ArchiveSource::Codex, CODEX, 12);
    let relaunch_session = relaunch_later.source_session_id.clone();
    let unavailable = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);
    let relaunch_report = support::capture_and_upload(
        &unavailable,
        &mut relaunched,
        &keys,
        &[relaunch_later],
        ArchivePolicy::Enrolled,
        &plan_for(ALL_ARCHIVE_SOURCES),
        TEST_NOW_MS,
        None,
    )
    .await;
    assert_eq!(unavailable.calls.get(), 0);
    assert_eq!(relaunch_report.captured, 0);
    assert!(!relaunch_report.purged);
    assert!(relaunch_report.failed >= 1);
    assert_eq!(
        relaunch_report.first_error.as_deref(),
        Some("archive_key_unavailable")
    );
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(relaunched.cleanup_required());
    assert!(relaunched
        .pending(ArchiveSource::Codex, &relaunch_session)
        .unwrap()
        .is_none());
}

#[test]
fn finish_cleanup_keeps_marker_when_enrollment_replace_fails() {
    let dir = TempDir::new().unwrap();
    let spool_dir = dir.path().join("spool");
    let enroll = dir.path().join("archive-enrollment.json");
    ArchiveEnrollmentRecord::save(&enroll, ArchivePolicy::Enrolled).unwrap();
    fs::create_dir(enroll.with_extension("tmp")).unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(&spool_dir, "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    assert!(collector_archive_sync::finish_terminal_cleanup(
        &spool_dir,
        "org_1",
        &keys,
        Some(&enroll)
    )
    .is_err());
    assert!(collector_archive_sync::cleanup_obligation_exists(
        &spool_dir
    ));
    assert_eq!(
        ArchiveEnrollmentRecord::load(&enroll).unwrap(),
        ArchivePolicy::Enrolled
    );
    assert!(keys.load("org_1").unwrap().is_none());
    assert!(!pending_disk_path(&spool_dir, &pending).exists());
    assert!(
        ArchiveSpool::open(&spool_dir, "org_1", &keys).is_err(),
        "must not mint a replacement key while cleanup remains"
    );
    assert!(keys.load("org_1").unwrap().is_none());
}

#[tokio::test]
async fn current_new_only_authority_retains_excluded_pending() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let path = pending_disk_path(dir.path(), &pending);
    let mut encrypted = fs::read(&path).unwrap();
    let last = encrypted.len() - 1;
    encrypted[last] ^= 0xff;
    fs::write(&path, encrypted).unwrap();
    let plan = ArchiveHistoryPlan::new(vec![state_with_target(
        ArchiveSource::Claude,
        ArchiveHistoryChoice::NewOnly,
        &pending.source_session_id,
    )]);
    let uploader = AckingUploader::new();

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert!(uploader.bodies.borrow().is_empty());
    assert!(path.exists());
    assert_eq!(report.failed, 0);
    assert!(report.first_error.is_none());
    assert_eq!(report.history[0].retained_excluded_pending, 1);
}

#[cfg(unix)]
#[tokio::test]
async fn unreadable_excluded_directory_does_not_block_permitted_pending() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let excluded = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let permitted = pending_from_bytes(ArchiveSource::Codex, CODEX, 10);
    spool.persist_pending(&excluded).unwrap();
    spool.persist_pending(&permitted).unwrap();
    let excluded_dir = pending_disk_path(dir.path(), &excluded)
        .parent()
        .unwrap()
        .to_path_buf();
    let original_permissions = fs::metadata(&excluded_dir).unwrap().permissions();
    let mut unreadable = original_permissions.clone();
    unreadable.set_mode(0o000);
    fs::set_permissions(&excluded_dir, unreadable).unwrap();

    let plan = ArchiveHistoryPlan::new(vec![
        state_with_target(
            ArchiveSource::Claude,
            ArchiveHistoryChoice::NewOnly,
            &excluded.source_session_id,
        ),
        ArchiveHistoryState::new(
            ArchiveHistoryGeneration {
                source: ArchiveSource::Codex,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 10,
            },
            10,
            Vec::new(),
        ),
    ]);
    let uploader =
        PermissionRestoringUploader::new(excluded_dir.clone(), original_permissions.clone());
    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;
    fs::set_permissions(&excluded_dir, original_permissions).unwrap();

    assert_eq!(report.uploaded, 1, "{report:?}");
    assert_eq!(report.failed, 0);
    assert_eq!(report.first_error, None);
    let uploaded: serde_json::Value =
        serde_json::from_slice(&uploader.inner.bodies.borrow()[0]).unwrap();
    assert_eq!(uploaded["source_session_id"], permitted.source_session_id);
    assert!(pending_disk_path(dir.path(), &excluded).exists());
}

#[tokio::test]
async fn deferred_oversized_snapshot_makes_bounded_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path().join("spool"), "org_1", &keys).unwrap();
    let path = dir.path().join("claude.jsonl");
    let mut prefix = Vec::new();
    while prefix.len() <= ARCHIVE_CAPTURE_WINDOW_BYTES as usize + CLAUDE.len() {
        prefix.extend_from_slice(CLAUDE);
    }
    fs::write(&path, prefix).unwrap();
    let registered_size = 1024 * 1024 * 1024 + 1;
    let mut file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(registered_size).unwrap();
    file.seek(SeekFrom::End(-1)).unwrap();
    file.write_all(b"\n").unwrap();
    let mut deferred = snapshot(ArchiveSource::Claude, CLAUDE, 10);
    deferred.bytes.clear();
    deferred.deferred_file = Some(DeferredArchiveSnapshot {
        expected_file_identity: None,
        expected_identity_prefix: None,
        path,
        prior_offset: 0,
        minimum_observed_size: 0,
    });
    let uploader = AckingUploader::new();

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        std::slice::from_ref(&deferred),
        ArchivePolicy::Enrolled,
        &plan_for(&[ArchiveSource::Claude]),
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.failed, 0);
    assert!(report.uploaded > 0);
    let current_part = spool
        .current_part(
            ArchiveSource::Claude,
            &deferred.source_session_id,
            &deferred.source_transcript_part_id,
        )
        .unwrap();
    let progress = spool
        .progress_part(
            ArchiveSource::Claude,
            &deferred.source_session_id,
            &current_part,
        )
        .unwrap()
        .unwrap();
    assert!(progress.last_complete_byte_offset > 0);
    assert!(progress.last_complete_byte_offset < registered_size);
}

#[tokio::test]
async fn invalid_source_state_does_not_block_another_source() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let claude = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let codex = pending_from_bytes(ArchiveSource::Codex, CODEX, 10);
    spool.persist_pending(&claude).unwrap();
    spool.persist_pending(&codex).unwrap();
    let plan = ArchiveHistoryPlan::new(vec![ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: ArchiveSource::Codex,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 10,
        },
        10,
        Vec::new(),
    )])
    .with_failed_sources(vec![ArchiveSource::Claude]);
    let uploader = AckingUploader::new();

    let report = support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.uploaded, 1);
    assert_eq!(report.failed, 0);
    let claude_history = report
        .history
        .iter()
        .find(|history| history.source == ArchiveSource::Claude)
        .unwrap();
    assert_eq!(claude_history.retained_excluded_pending, 1);
    let uploaded: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    assert_eq!(uploaded["source_session_id"], codex.source_session_id);
    assert!(pending_disk_path(dir.path(), &claude).exists());
}

#[tokio::test]
async fn ambiguous_new_only_exclusion_is_reported_without_operational_failure() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let state = ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: ArchiveSource::Codex,
            history_choice: ArchiveHistoryChoice::NewOnly,
            authorized_at: 10,
        },
        10,
        Vec::new(),
    );
    let plan = ArchiveHistoryPlan::new(vec![state])
        .with_ambiguous_excluded(vec![(ArchiveSource::Codex, 2)]);

    let report = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(report.failed, 0);
    assert!(report.first_error.is_none());
    assert_eq!(report.history.len(), 1);
    assert_eq!(report.history[0].ambiguous_excluded_sessions, 2);
}

#[tokio::test]
async fn upload_selection_is_stable_after_live_first_capture() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let mut baseline = snapshot(ArchiveSource::Claude, CLAUDE, 10);
    baseline.class = ArchiveWorkClass::Baseline;
    baseline.activity_rank_ms = Some(i64::MAX);
    let live_bytes = br#"{"sessionId":"live-session","uuid":"live-1"}
"#;
    let live = snapshot(ArchiveSource::Claude, live_bytes, 11);
    let state = state_with_target(
        ArchiveSource::Claude,
        ArchiveHistoryChoice::AllHistory,
        &baseline.source_session_id,
    );
    let plan = ArchiveHistoryPlan::new(vec![state]).with_live_sessions(vec![(
        ArchiveSource::Claude,
        live.source_session_id.clone(),
        11,
    )]);
    let uploader = AckingUploader::new();

    support::capture_and_upload(
        &uploader,
        &mut spool,
        &keys,
        &[baseline.clone(), live],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    let first: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    assert_eq!(first["source_session_id"], baseline.source_session_id);
    let second: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[1]).unwrap();
    assert_eq!(second["source_session_id"], "live-session");
}

#[test]
fn encrypted_history_state_round_trips_and_purges_with_the_spool() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let state = state_with_target(
        ArchiveSource::Claude,
        ArchiveHistoryChoice::AllHistory,
        "baseline-session",
    );
    spool.commit_history_state(&state).unwrap();
    let encrypted = fs::read(dir.path().join("history/claude.bin")).unwrap();
    assert!(!encrypted
        .windows("baseline-session".len())
        .any(|window| window == b"baseline-session"));
    drop(spool);

    let reopened = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    assert_eq!(
        reopened.history_state(ArchiveSource::Claude).unwrap(),
        Some(state)
    );
    reopened.purge(&keys).unwrap();
    assert!(!dir.path().join("history").exists());
}

#[test]
fn history_without_its_key_fails_loud() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    spool
        .commit_history_state(&state_with_target(
            ArchiveSource::Codex,
            ArchiveHistoryChoice::AllHistory,
            "baseline-session",
        ))
        .unwrap();
    keys.delete("org_1").unwrap();
    assert!(matches!(
        ArchiveSpool::open(dir.path(), "org_1", &keys),
        Err(ArchiveSyncError::Corrupt)
    ));
}

#[tokio::test]
async fn missing_baseline_stays_in_progress() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let state = state_with_target(
        ArchiveSource::Claude,
        ArchiveHistoryChoice::AllHistory,
        "missing-session",
    );
    let plan = ArchiveHistoryPlan::new(vec![state]);
    let report = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(
        report.first_error.as_deref(),
        Some("archive_history_missing_baseline")
    );
    assert_eq!(
        report.history[0].initial_import,
        ArchiveInitialImport::InProgress
    );
    assert_eq!(report.history[0].completed_targets, 0);
}

#[tokio::test]
async fn acknowledgement_of_complete_records_finishes_a_partial_tail_target() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let complete = b"{\"sessionId\":\"partial-session\",\"uuid\":\"one\"}\n";
    let mut bytes = complete.to_vec();
    bytes.extend_from_slice(b"{\"unfinished\":");
    let mut target = snapshot(ArchiveSource::Claude, &bytes, 10);
    target.class = ArchiveWorkClass::Baseline;
    target.activity_rank_ms = Some(10);
    let state = ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source: ArchiveSource::Claude,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 10,
        },
        10,
        vec![ArchiveBaselineTarget {
            source_session_id: target.source_session_id.clone(),
            source_transcript_part_id: target.source_transcript_part_id.clone(),
            activity_rank_ms: 10,
            registered_size_bytes: bytes.len() as u64,
            registered_complete_byte_offset: complete.len() as u64,
        }],
    );
    let plan = ArchiveHistoryPlan::new(vec![state]).with_present_parts(vec![(
        ArchiveSource::Claude,
        target.source_session_id.clone(),
        target.source_transcript_part_id.clone(),
    )]);
    let report = support::capture_and_upload(
        &AckingUploader::new(),
        &mut spool,
        &keys,
        &[target],
        ArchivePolicy::Enrolled,
        &plan,
        TEST_NOW_MS,
        None,
    )
    .await;

    assert_eq!(
        report.history[0].initial_import,
        ArchiveInitialImport::Complete
    );
    assert_eq!(report.history[0].completed_targets, 1);
}
