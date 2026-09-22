//! Synthetic offline capture proof for the Cloud-Dev smoke. Never reads user transcripts.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use collector_archive::{default_transcript_part_id, sha256, ArchiveObservation, EncodedPayload};
use collector_archive_sync::{
    ArchivePolicy, ArchiveSource, ArchiveSpool, MemoryKeyStore, PendingLoad,
};
use collector_embedder::sources::SourceHomes;
use collector_embedder::sync::{capture_archive_local, ArchiveRunConfig};
use collector_embedder::{ArchiveAuthorizedSource, ArchiveHistoryChoice};
use serde_json::json;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let source = match args.get(1).map(String::as_str) {
        Some("claude") => ArchiveSource::Claude,
        Some("codex") => ArchiveSource::Codex,
        _ => anyhow::bail!("expected claude or codex, then synthetic session id"),
    };
    let session = args
        .get(2)
        .ok_or_else(|| anyhow::anyhow!("session id required"))?;
    let temp = tempfile::TempDir::new()?;
    let homes = SourceHomes::standard(temp.path());
    let relative = match source {
        ArchiveSource::Claude => format!(".claude/projects/synthetic/{session}.jsonl"),
        ArchiveSource::Codex => format!(".codex/sessions/rollout-{session}.jsonl"),
    };
    let path = temp.path().join(relative);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let spool_path = temp.path().join("spool");
    let keys = Arc::new(MemoryKeyStore::new());
    let config = ArchiveRunConfig {
        archive_url: "http://127.0.0.1:1".to_string(),
        spool_dir: spool_path.clone(),
        enrollment_path: temp.path().join("enrollment.json"),
        key_store: keys.clone(),
        policy: ArchivePolicy::Enrolled,
        authorized_sources: vec![ArchiveAuthorizedSource {
            source,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 0,
        }],
    };
    let base = default_transcript_part_id(source);
    let mut expected = BTreeMap::new();
    let header = match source {
        ArchiveSource::Claude => json!({"sessionId":session,"timestamp":"2020-01-01T00:00:00Z"}),
        ArchiveSource::Codex => {
            json!({"type":"session_meta","payload":{"id":session,"timestamp":"2020-01-01T00:00:00Z"}})
        }
    };
    let mut first = serde_json::to_vec(&header)?;
    first.extend(b"\n {malformed}\n{\"partial\":\"\xf0\x9f");
    first.extend(vec![b'x'; 600_000]);
    let second = b"\xff rewritten tail without newline".to_vec();
    let tool_result = if source == ArchiveSource::Claude {
        let output = path.with_extension("").join("tool-results/result.txt");
        std::fs::create_dir_all(output.parent().unwrap())?;
        std::fs::write(&output, b"\xffbinary tool output\0without newline")?;
        Some(output)
    } else {
        None
    };
    let mut latest_sidecar = None;
    for (index, bytes) in [first, second, vec![]].into_iter().enumerate() {
        std::fs::write(&path, &bytes)?;
        let report = capture_archive_local(&config, "synthetic-smoke", &homes, 10 + index as i64);
        let spool = ArchiveSpool::open(&spool_path, "synthetic-smoke", keys.as_ref())?;
        anyhow::ensure!(
            report.captured > 0,
            "synthetic capture did not persist bytes: {:?}",
            report.first_error
        );
        expected.insert(spool.current_part(source, session, &base)?, bytes);
        if index < 2 {
            if let Some(output) = &tool_result {
                let base = collector_archive::claude_transcript_part_id("tool-results/result.txt")?;
                let part = spool.current_part(source, session, &base)?;
                expected.insert(part.clone(), std::fs::read(output)?);
                latest_sidecar = Some(part);
                if index == 0 {
                    std::fs::write(output, b"replacement tool output")?;
                } else {
                    std::fs::remove_file(output)?;
                }
            }
        }
    }
    std::fs::remove_file(&path)?;
    let spool = ArchiveSpool::open(&spool_path, "synthetic-smoke", keys.as_ref())?;
    let mut uploads = Vec::new();
    let mut request_bodies = Vec::new();
    let mut observed_parts = BTreeSet::new();
    let mut relative_paths = BTreeMap::new();
    let mut reconstructed: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for load in spool.all_pending()? {
        let PendingLoad::Ready(pending) = load else {
            anyhow::bail!("corrupt fixture spool")
        };
        if !observed_parts.insert(pending.source_transcript_part_id.clone()) {
            continue;
        }
        for slice in spool.slices_for_part(source, session, &pending.source_transcript_part_id)? {
            let upload: serde_json::Value = serde_json::from_slice(&slice.body)?;
            if let Some(relative) = upload["relative_path"].as_str() {
                relative_paths.insert(
                    slice.source_transcript_part_id.clone(),
                    relative.to_string(),
                );
            }
            reconstructed
                .entry(slice.source_transcript_part_id.clone())
                .or_default();
            for observation in upload["observations"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("missing observations"))?
            {
                let observation: ArchiveObservation = serde_json::from_value(observation.clone())?;
                reconstructed
                    .entry(slice.source_transcript_part_id.clone())
                    .or_default()
                    .extend(observation.payload_bytes()?);
            }
            request_bodies.push(String::from_utf8(slice.body.clone())?);
            uploads.push(upload);
        }
    }
    anyhow::ensure!(
        reconstructed == expected,
        "spool lost a captured generation after rewrite/deletion/restart"
    );
    let expected_parts: Vec<_> = expected.into_iter().map(|(part, bytes)| {
        let payload = EncodedPayload::from_bytes(&bytes);
        json!({"part_id":part,"relative_path":relative_paths.get(&part),"current_relative_path":latest_sidecar.as_ref().filter(|latest| **latest == part).and_then(|_| relative_paths.get(&part)),"payload_encoding":payload.encoding,"payload":payload.value,"sha256":sha256(&bytes)})
    }).collect();
    drop(spool);
    temp.close()?;
    println!(
        "{}",
        json!({"uploads":uploads,"request_bodies":request_bodies,"expected_parts":expected_parts,"source_and_spool_removed":true})
    );
    Ok(())
}
