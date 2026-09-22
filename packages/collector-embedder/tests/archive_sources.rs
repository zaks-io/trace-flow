use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use collector_archive::{sha256, ArchiveObservation};
use collector_archive_sync::{ArchiveAcknowledgement, ArchiveCycleReport, ArchiveInitialImport};
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{self, ArchiveRunConfig, MemoryKeyStore};
use collector_embedder::{
    ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveSource, UploadOutcome,
};
use serde_json::{json, Value};

struct Runtime {
    _dir: tempfile::TempDir,
    home: PathBuf,
    config: ArchiveRunConfig,
}

impl Runtime {
    fn new(source: ArchiveSource) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let config = ArchiveRunConfig {
            archive_url: "http://127.0.0.1:1".to_string(),
            spool_dir: dir.path().join("spool"),
            enrollment_path: dir.path().join("enrollment.json"),
            key_store: Arc::new(MemoryKeyStore::new()),
            policy: sync::ArchivePolicy::Enrolled,
            authorized_sources: vec![ArchiveAuthorizedSource {
                source,
                history_choice: ArchiveHistoryChoice::AllHistory,
                authorized_at: 0,
            }],
        };
        Self {
            _dir: dir,
            home,
            config,
        }
    }

    fn capture(&self) -> ArchiveCycleReport {
        sync::capture_archive_local(&self.config, "org", &SourceHomes::standard(&self.home), 100)
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.home.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn drain(&self) -> Vec<Value> {
        let mut bodies = Vec::new();
        while let Some(upload) =
            sync::prepare_archive_upload(&self.config, "org", &HashSet::new()).unwrap()
        {
            let body: Value = serde_json::from_slice(upload.body()).unwrap();
            let receipt = receipt(upload.body());
            assert_eq!(
                sync::apply_archive_upload(&self.config, "org", &upload, Ok(receipt)).unwrap(),
                UploadOutcome::Advanced
            );
            bodies.push(body);
        }
        bodies
    }
}

fn receipt(bytes: &[u8]) -> ArchiveAcknowledgement {
    let body: Value = serde_json::from_slice(bytes).unwrap();
    let checkpoint = &body["checkpoint"];
    serde_json::from_value(json!({
        "status": "acknowledged", "source": checkpoint["source"],
        "source_session_id": body["source_session_id"],
        "source_transcript_part_id": checkpoint["source_transcript_part_id"],
        "relative_path": body["relative_path"],
        "request_sha256": sha256(bytes),
        "captured_byte_offset": checkpoint["last_complete_byte_offset"],
        "captured_prefix_sha256": checkpoint["complete_prefix_sha256"],
        "record_count": checkpoint["record_count"], "generation": 1,
        "chain_head": sha256(b"fixture chain"), "manifest_key": "fixture-manifest"
    }))
    .unwrap()
}

fn part(body: &Value) -> &str {
    body["checkpoint"]["source_transcript_part_id"]
        .as_str()
        .unwrap()
}

fn payload(body: &Value) -> Vec<u8> {
    body["observations"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|value| {
            serde_json::from_value::<ArchiveObservation>(value.clone())
                .unwrap()
                .payload_bytes()
                .unwrap()
        })
        .collect()
}

fn codex(text: &str) -> Vec<u8> {
    format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"session\",\"timestamp\":\"2020-01-01T00:00:00Z\"}}}}\n{{\"text\":\"{text}\"}}\n").into_bytes()
}

fn compress(path: &Path, bytes: &[u8]) -> PathBuf {
    let compressed = path.with_extension("jsonl.zst");
    fs::write(&compressed, zstd::stream::encode_all(bytes, 1).unwrap()).unwrap();
    fs::remove_file(path).unwrap();
    compressed
}

#[test]
fn compressed_rollout_moves_resumes_and_rewrites_through_production_capture() {
    let runtime = Runtime::new(ArchiveSource::Codex);
    let bytes = codex("before");
    let live = runtime.write(".codex/sessions/rollout-session.jsonl", &bytes);
    assert_eq!(runtime.capture().captured, 1);
    let first = runtime.drain();
    assert_eq!(payload(&first[0]), bytes);
    let original_part = part(&first[0]).to_string();
    let archived = runtime
        .home
        .join(".codex/archived_sessions/rollout-session.jsonl");
    fs::create_dir_all(archived.parent().unwrap()).unwrap();
    fs::rename(live, &archived).unwrap();
    let compressed = compress(&archived, &bytes);
    let unchanged = runtime.capture();
    assert_eq!(
        (unchanged.captured, unchanged.forked, unchanged.failed),
        (0, 0, 0)
    );
    assert!(runtime.drain().is_empty());
    let scratch = runtime.config.spool_dir.with_extension("scratch");
    assert!(!scratch.exists() || fs::read_dir(scratch).unwrap().next().is_none());
    let mut appended = bytes.clone();
    appended.extend(b"{\"text\":\"append\"}\n");
    fs::write(&archived, &appended).unwrap();
    fs::remove_file(compressed).unwrap();
    let resumed = runtime.capture();
    assert_eq!(
        (resumed.captured, resumed.forked, resumed.failed),
        (1, 0, 0)
    );
    let next = runtime.drain();
    assert_eq!(part(&next[0]), original_part);
    assert_eq!(payload(&next[0]), &appended[bytes.len()..]);
    let mut rewritten = codex("after!");
    rewritten.extend(b"{\"text\":\"append\"}\n");
    fs::write(&archived, &rewritten).unwrap();
    assert_eq!(runtime.capture().forked, 1);
    let rewrite = runtime.drain();
    assert_ne!(part(&rewrite[0]), original_part);
    assert_eq!(payload(&rewrite[0]), rewritten);
    fs::write(&archived, &bytes).unwrap();
    assert_eq!(runtime.capture().forked, 1);
    assert_eq!(payload(&runtime.drain()[0]), bytes);
}

#[test]
fn claude_orphaned_and_superseded_copies_preserve_divergence() {
    let runtime = Runtime::new(ArchiveSource::Claude);
    let parent =
        b"{\"sessionId\":\"session\",\"timestamp\":\"2020-01-01T00:00:00Z\",\"text\":\"parent\"}\n";
    let other =
        b"{\"sessionId\":\"session\",\"timestamp\":\"2020-01-01T00:00:00Z\",\"text\":\"branch\"}\n";
    runtime.write(".claude/projects/project/session.jsonl", parent);
    runtime.write(
        ".claude/projects/project/session.orphaned-identical.jsonl",
        parent,
    );
    runtime.write(".claude/projects/project/session.jsonl.superseded-1", other);
    let captured = runtime.capture();
    assert_eq!(captured.captured, 2);
    let bodies = runtime.drain();
    assert_eq!(bodies.iter().map(part).collect::<HashSet<_>>().len(), 2);
    assert!(bodies.iter().any(|body| payload(body) == parent));
    assert!(bodies.iter().any(|body| payload(body) == other));
}

#[test]
fn tool_results_require_matching_receipts_and_survive_overwrite_and_deletion() {
    let runtime = Runtime::new(ArchiveSource::Claude);
    runtime.write(
        ".claude/projects/project/session.jsonl",
        b"{\"sessionId\":\"session\",\"timestamp\":\"2020-01-01T00:00:00Z\"}\n",
    );
    let original = b"\xffbinary\0tool output without newline";
    let sidecar = runtime.write(
        ".claude/projects/project/session/tool-results/result.txt",
        original,
    );
    runtime.write(
        ".claude/projects/project/unrelated.json",
        b"not a conversation",
    );
    assert_eq!(runtime.capture().captured, 2);
    let bodies = runtime.drain();
    let body = bodies
        .iter()
        .find(|body| body["relative_path"] == "tool-results/result.txt")
        .unwrap();
    assert_eq!(payload(body), original);
    fs::write(&sidecar, b"replacement").unwrap();
    assert_eq!(runtime.capture().forked, 1);
    fs::remove_file(sidecar).unwrap();
    let upload = sync::prepare_archive_upload(&runtime.config, "org", &HashSet::new())
        .unwrap()
        .unwrap();
    let mut wrong = receipt(upload.body());
    wrong.relative_path = None;
    assert_eq!(
        sync::apply_archive_upload(&runtime.config, "org", &upload, Ok(wrong)).unwrap_err(),
        "archive_ack_mismatch"
    );
    let retained = runtime.drain();
    assert_eq!(retained.len(), 1);
    assert_eq!(payload(&retained[0]), b"replacement");
    assert_ne!(part(&retained[0]), part(body));
}

#[test]
fn invalid_compressed_source_is_visible_and_never_reports_complete() {
    let runtime = Runtime::new(ArchiveSource::Codex);
    runtime.write(
        ".codex/archived_sessions/rollout-bad.jsonl.zst",
        b"invalid zstd",
    );
    let report = runtime.capture();
    assert_eq!(report.captured, 0);
    assert!(report.failed > 0);
    assert_eq!(
        report.history[0].initial_import,
        ArchiveInitialImport::InProgress
    );
    let scratch = runtime.config.spool_dir.with_extension("scratch");
    assert!(!scratch.exists() || fs::read_dir(scratch).unwrap().next().is_none());
}

#[test]
fn larger_prefix_rewrites_and_divergent_codex_copies_are_preserved() {
    for suffix in ["first", "second"] {
        let runtime = Runtime::new(ArchiveSource::Codex);
        let original = codex("before");
        let path = runtime.write(
            &format!(".codex/sessions/rollout-{suffix}.jsonl"),
            &original,
        );
        assert_eq!(runtime.capture().captured, 1);
        let captured = runtime.drain();
        let mut rewritten = codex("after!");
        rewritten.extend([b'x'; 74]);
        assert_eq!(rewritten.len(), original.len() + 74);
        fs::write(path, &rewritten).unwrap();
        assert_eq!(runtime.capture().forked, 1);
        let changed = runtime.drain();
        assert_ne!(part(&captured[0]), part(&changed[0]));
        assert_eq!(payload(&changed[0]), rewritten);
    }
    let runtime = Runtime::new(ArchiveSource::Codex);
    runtime.write(
        ".codex/sessions/rollout-session.jsonl",
        &codex("original longer conversation"),
    );
    runtime.write(
        ".codex/sessions/rollout-session_copy.jsonl",
        &codex("other copy"),
    );
    assert_eq!(runtime.capture().captured, 2);
    let captures = runtime.drain();
    assert_eq!(captures.iter().map(part).collect::<HashSet<_>>().len(), 2);
    assert!(captures
        .iter()
        .any(|body| payload(body) == codex("original longer conversation")));
    assert!(captures
        .iter()
        .any(|body| payload(body) == codex("other copy")));
    let complete = runtime.capture();
    assert_eq!(complete.failed, 0);
    assert_eq!(
        complete.history[0].initial_import,
        ArchiveInitialImport::Complete
    );
}
