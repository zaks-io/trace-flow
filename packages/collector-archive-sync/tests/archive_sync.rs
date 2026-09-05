use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs;
use std::sync::{Arc, Mutex};

use collector_archive::{
    claude_transcript_part_id, default_transcript_part_id, scan_claude_jsonl, ArchiveSource,
};
use collector_archive_sync::{
    acknowledgement_matches, run_archive_cycle, ArchiveAcknowledgement, ArchiveClient,
    ArchiveClientConfig, ArchiveClientError, ArchiveEnrollmentRecord, ArchiveKeyStore,
    ArchivePolicy, ArchiveSnapshot, ArchiveSpool, ArchiveSpoolKey, ArchiveSyncError,
    ArchiveUploader, MemoryKeyStore, PendingArchiveRequest, PendingLoad, ARCHIVE_SPOOL_CAP_BYTES,
    ARCHIVE_SPOOL_KEYRING_SERVICE, MAX_ARCHIVE_UPLOAD_BYTES, MAX_UPLOAD_OBSERVATIONS,
};
use collector_contracts::AgentSource;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const CLAUDE: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/claude.jsonl");
const CODEX: &[u8] = include_bytes!("../../collector-archive/tests/fixtures/codex.jsonl");

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
        self.scripted
            .borrow_mut()
            .pop_front()
            .expect("scripted archive upload")
    }
}

fn ack_for(pending: &PendingArchiveRequest) -> ArchiveAcknowledgement {
    ArchiveAcknowledgement {
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
        chain_head: "sha256:00".to_string(),
        manifest_key: "manifest".to_string(),
        chunk_keys: vec![],
    }
}

fn snapshot(source: ArchiveSource, bytes: &[u8], observed_at: i64) -> ArchiveSnapshot {
    let source_session_id =
        collector_archive_sync::archive_source_session_id(source, bytes).unwrap();
    ArchiveSnapshot {
        source,
        source_session_id,
        source_transcript_part_id: default_transcript_part_id(source),
        transcript_part_identity: None,
        bytes: bytes.to_vec(),
        observed_at,
    }
}

fn pending_from_bytes(
    source: ArchiveSource,
    bytes: &[u8],
    observed_at: i64,
) -> PendingArchiveRequest {
    let session = collector_archive_sync::archive_source_session_id(source, bytes).unwrap();
    let scan =
        collector_archive_sync::scan_snapshot(source, &session, None, bytes, observed_at, None)
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
    let uploader = ScriptedUploader::new([Ok(ack_for(&pending))]);
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let uploader =
        ScriptedUploader::new([Err(ArchiveClientError::InvalidUpload), Ok(ack_for(&codex))]);
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    let uploader = ScriptedUploader::new([Ok(ack_for(&pending))]);
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[claude],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    assert_eq!(
        uploader.sources.borrow().as_slice(),
        &[ArchiveSource::Claude]
    );
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert!(report.purged);
    assert!(keys.load("org_1").unwrap().is_none());
    assert!(!dir.path().join("pending").exists());
}

#[tokio::test]
async fn local_revoked_policy_purges_without_uploading() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let pending = pending_from_bytes(ArchiveSource::Claude, CLAUDE, 10);
    spool.persist_pending(&pending).unwrap();
    let uploader = ScriptedUploader::new([]);
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Revoked,
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert!(report.frozen);
    assert!(!report.purged);
    assert_eq!(report.captured, 0);
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[claude, codex],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert!(report.frozen);
    assert!(!report.purged);
    assert_eq!(uploader.calls.get(), 1);
    assert_eq!(report.captured, 1);
    assert!(spool
        .pending(ArchiveSource::Claude, &claude_session)
        .unwrap()
        .is_some());
    assert!(spool
        .pending(ArchiveSource::Codex, &codex_session)
        .unwrap()
        .is_none());
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
        let report = run_archive_cycle(
            &uploader,
            &mut spool,
            &keys,
            &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
            policy,
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

struct AckingUploader {
    bodies: RefCell<Vec<Vec<u8>>>,
    session_record_count: Cell<u64>,
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
        Ok(ArchiveAcknowledgement {
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
            chain_head: "sha256:00".to_string(),
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

#[tokio::test]
async fn oversized_session_splits_at_byte_limit() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(12, 400_000, "big-session");
    let full = collector_archive_sync::scan_snapshot(
        ArchiveSource::Claude,
        "big-session",
        None,
        &bytes,
        10,
        None,
    )
    .unwrap()
    .into_upload_request(&bytes)
    .unwrap();
    assert!(serde_json::to_vec(&full).unwrap().len() > MAX_ARCHIVE_UPLOAD_BYTES);

    let uploader = AckingUploader::new();
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, &bytes, 10)],
        ArchivePolicy::Enrolled,
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
    let progress = spool
        .progress(ArchiveSource::Claude, "big-session")
        .unwrap()
        .expect("progress advanced through remaining bytes");
    assert_eq!(progress.record_count, 12);
    let first: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    let second: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[1]).unwrap();
    assert_eq!(
        second["prior_checkpoint"]["record_count"],
        first["checkpoint"]["record_count"]
    );
    assert_eq!(
        second["prior_checkpoint"]["prefix_chain_sha256"],
        first["checkpoint"]["prefix_chain_sha256"]
    );
}

#[tokio::test]
async fn oversized_session_splits_at_observation_count() {
    let dir = TempDir::new().unwrap();
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(dir.path(), "org_1", &keys).unwrap();
    let bytes = padded_records(5, 8, "count-session");
    let pending = collector_archive_sync::build_bounded_pending_with_limits(
        ArchiveSource::Claude,
        "count-session",
        None,
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 1);
    let progress = spool
        .progress(ArchiveSource::Claude, "count-session")
        .unwrap()
        .unwrap();
    assert_eq!(progress.record_count, 2);
    let rest = collector_archive_sync::build_bounded_pending_with_limits(
        ArchiveSource::Claude,
        "count-session",
        None,
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
    let staging = spool.ack_transition_len(&pending).unwrap();
    pad_spool_leaving_room(dir.path(), ARCHIVE_SPOOL_CAP_BYTES, staging);
    assert_eq!(
        real_durable_bytes(dir.path()).saturating_add(staging),
        ARCHIVE_SPOOL_CAP_BYTES
    );
    let uploader = ScriptedUploader::new([Ok(ack_for(&pending))]);
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: parent_part.clone(),
            transcript_part_identity: None,
            bytes: parent_bytes.to_vec(),
            observed_at: 10,
        },
        ArchiveSnapshot {
            source: ArchiveSource::Claude,
            source_session_id: "session-1".to_string(),
            source_transcript_part_id: sub_part.clone(),
            transcript_part_identity: Some("agent-001".to_string()),
            bytes: subagent_bytes.to_vec(),
            observed_at: 11,
        },
    ];
    let uploader = AckingUploader::new();
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &snapshots,
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert_eq!(report.uploaded, 2);
    assert_eq!(report.failed, 0);
    assert_eq!(uploader.bodies.borrow().len(), 2);
    let first: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[0]).unwrap();
    let second: serde_json::Value = serde_json::from_slice(&uploader.bodies.borrow()[1]).unwrap();
    assert_eq!(
        first["checkpoint"]["source_transcript_part_id"].as_str(),
        Some(parent_part.as_str())
    );
    assert_eq!(
        second["checkpoint"]["source_transcript_part_id"].as_str(),
        Some(sub_part.as_str())
    );
    assert_eq!(first["checkpoint"]["record_count"], 2);
    assert_eq!(second["checkpoint"]["record_count"], 2);
    let parent_progress = spool
        .progress_part(ArchiveSource::Claude, "session-1", &parent_part)
        .unwrap()
        .unwrap();
    let sub_progress = spool
        .progress_part(ArchiveSource::Claude, "session-1", &sub_part)
        .unwrap()
        .unwrap();
    assert_eq!(parent_progress.record_count, 2);
    assert_eq!(sub_progress.record_count, 2);
    assert_ne!(
        parent_progress.source_transcript_part_id(),
        sub_progress.source_transcript_part_id()
    );
    assert_ne!(
        parent_progress.prefix_chain_sha256,
        sub_progress.prefix_chain_sha256
    );
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[snapshot(ArchiveSource::Claude, CLAUDE, 10)],
        ArchivePolicy::Revoked,
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
    let live_report = run_archive_cycle(
        &live_uploader,
        &mut live_spool,
        &live_keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let stop_report = run_archive_cycle(
        &stop_uploader,
        &mut stop_spool,
        &stop_keys,
        &[later],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert!(!stop_report.purged);
    assert!(stop_report.halted);
    assert_eq!(stop_report.captured, 0);
    assert!(stop_spool
        .pending(ArchiveSource::Codex, &later_session)
        .unwrap()
        .is_none());
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[],
        ArchivePolicy::Enrolled,
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
    let relaunch_report =
        run_archive_cycle(&unavailable, &mut relaunched, &keys, &[later], policy, None).await;
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
    let report = run_archive_cycle(
        &uploader,
        &mut spool,
        &keys,
        &[later],
        ArchivePolicy::Enrolled,
        None,
    )
    .await;
    assert!(!report.purged);
    assert!(report.halted);
    assert_eq!(report.captured, 0);
    assert!(spool.cleanup_required());
    assert!(keys.load("org_1").unwrap().is_some());
    assert!(pending_disk_path(&spool_dir, &pending).exists());
    assert!(spool
        .pending(ArchiveSource::Codex, &later_session)
        .unwrap()
        .is_none());

    let mut relaunched = ArchiveSpool::open_existing(&spool_dir, "org_1", &keys)
        .unwrap()
        .expect("retained spool after failed purge");
    relaunched.set_enrollment_path(&enroll);
    let relaunch_later = snapshot(ArchiveSource::Codex, CODEX, 12);
    let relaunch_session = relaunch_later.source_session_id.clone();
    let unavailable = ScriptedUploader::new([Err(ArchiveClientError::Unavailable {
        reason: "archive unavailable".to_string(),
    })]);
    let relaunch_report = run_archive_cycle(
        &unavailable,
        &mut relaunched,
        &keys,
        &[relaunch_later],
        ArchivePolicy::Enrolled,
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
