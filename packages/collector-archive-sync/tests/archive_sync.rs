use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::fs;
use std::sync::{Arc, Mutex};

use collector_archive::{scan_claude_jsonl, ArchiveSource};
use collector_archive_sync::{
    acknowledgement_matches, run_archive_cycle, ArchiveAcknowledgement, ArchiveClient,
    ArchiveClientConfig, ArchiveClientError, ArchiveEnrollmentRecord, ArchiveKeyStore,
    ArchivePolicy, ArchiveSnapshot, ArchiveSpool, ArchiveSpoolKey, ArchiveUploader, MemoryKeyStore,
    PendingArchiveRequest, ARCHIVE_SPOOL_CAP_BYTES, ARCHIVE_SPOOL_KEYRING_SERVICE,
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
        contribution_id: "con_1".to_string(),
        appended_records: pending.expected_record_count,
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
        collector_archive_sync::scan_snapshot(source, &session, bytes, observed_at, None).unwrap();
    let request = scan.into_upload_request(bytes).unwrap();
    PendingArchiveRequest {
        source,
        source_session_id: session,
        expected_record_count: request.checkpoint.record_count,
        body: serde_json::to_vec(&request).unwrap(),
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
        expected_record_count: 1,
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
    let path = dir
        .path()
        .join("pending")
        .join("claude")
        .join(format!("{}.bin", pending.source_session_id));
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
