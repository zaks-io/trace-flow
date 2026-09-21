//! Synthetic offline capture proof for the Cloud-Dev smoke. Never reads user transcripts.
use std::collections::{BTreeMap, BTreeSet};

use collector_archive::{default_transcript_part_id, sha256, ArchiveObservation, EncodedPayload};
use collector_archive_sync::{
    run_archive_cycle, ArchiveAcknowledgement, ArchiveClientError, ArchiveHistoryChoice,
    ArchiveHistoryGeneration, ArchiveHistoryPlan, ArchiveHistoryState, ArchivePolicy,
    ArchiveSnapshot, ArchiveSource, ArchiveSpool, ArchiveUploader, ArchiveWorkClass,
    DeferredArchiveSnapshot, MemoryKeyStore, PendingLoad,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

struct Offline;
impl ArchiveUploader for Offline {
    async fn upload(
        &self,
        _: ArchiveSource,
        _: &[u8],
        _: Option<&CancellationToken>,
    ) -> Result<ArchiveAcknowledgement, ArchiveClientError> {
        Err(ArchiveClientError::Transport(anyhow::anyhow!(
            "synthetic offline"
        )))
    }
}

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
    let path = temp.path().join("synthetic.jsonl");
    let spool_path = temp.path().join("spool");
    let keys = MemoryKeyStore::new();
    let mut spool = ArchiveSpool::open(&spool_path, "synthetic-smoke", &keys)?;
    let plan = ArchiveHistoryPlan::new(vec![ArchiveHistoryState::new(
        ArchiveHistoryGeneration {
            source,
            history_choice: ArchiveHistoryChoice::AllHistory,
            authorized_at: 0,
        },
        0,
        vec![],
    )]);
    let base = default_transcript_part_id(source);
    let mut expected = BTreeMap::new();
    let mut first = b"\n {malformed}\n{\"partial\":\"\xf0\x9f".to_vec();
    first.extend(vec![b'x'; 600_000]);
    let second = b"\xff rewritten tail without newline".to_vec();
    for (index, bytes) in [first, second, vec![]].into_iter().enumerate() {
        std::fs::write(&path, &bytes)?;
        let snapshot = ArchiveSnapshot {
            source,
            source_session_id: session.clone(),
            base_transcript_part_id: base.clone(),
            source_transcript_part_id: base.clone(),
            bytes: vec![],
            deferred_file: Some(DeferredArchiveSnapshot {
                expected_file_identity: None,
                expected_identity_prefix: None,
                path: path.clone(),
                prior_offset: 0,
                minimum_observed_size: 0,
            }),
            observed_at: 10 + index as i64,
            class: ArchiveWorkClass::Live,
            activity_rank_ms: None,
        };
        let report = run_archive_cycle(
            &Offline,
            &mut spool,
            &keys,
            &[snapshot],
            ArchivePolicy::Enrolled,
            &plan,
            10 + index as i64,
            None,
        )
        .await;
        anyhow::ensure!(
            report.captured > 0,
            "synthetic capture did not persist bytes: {:?}",
            report.first_error
        );
        expected.insert(spool.current_part(source, session, &base)?, bytes);
    }
    std::fs::remove_file(&path)?;
    drop(spool);
    let spool = ArchiveSpool::open(&spool_path, "synthetic-smoke", &keys)?;
    let mut uploads = Vec::new();
    let mut request_bodies = Vec::new();
    let mut observed_parts = BTreeSet::new();
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
        json!({"part_id":part,"payload_encoding":payload.encoding,"payload":payload.value,"sha256":sha256(&bytes)})
    }).collect();
    drop(spool);
    temp.close()?;
    println!(
        "{}",
        json!({"uploads":uploads,"request_bodies":request_bodies,"expected_parts":expected_parts,"source_and_spool_removed":true})
    );
    Ok(())
}
