//! Read-only archive coverage audit. Compares every local Claude and Codex transcript with the
//! desktop spool's acknowledged progress checkpoint and prints one JSON line per transcript part.
//! Run against a copy of the spool root so recovery on open never races the live desktop app.
//!
//! Usage: archive_coverage <spool-root-copy> <org-id> [home]
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use collector_archive::{complete_record_end_offsets, CompletedScanCheckpoint};
use collector_archive_sync::{
    archive_source_session_id_from_records, parse_jsonl_records, transcript_part_for_records,
    ArchiveSource, ArchiveSpool, OsKeyStore,
};
use serde_json::{json, Value};

const HEAD_BYTES: usize = 256 * 1024;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let spool_root = PathBuf::from(args.get(1).expect("spool root copy"));
    let org_id = args.get(2).expect("org id").clone();
    let home = args
        .get(3)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").expect("HOME")));
    let spool = ArchiveSpool::open_existing(&spool_root, org_id, &OsKeyStore)?
        .ok_or_else(|| anyhow::anyhow!("archive spool key is unavailable"))?;

    let mut seen: BTreeSet<(&'static str, String, String)> = BTreeSet::new();
    let mut generations: BTreeSet<(&'static str, String)> = BTreeSet::new();
    let roots = [
        (ArchiveSource::Claude, home.join(".claude/projects")),
        (ArchiveSource::Codex, home.join(".codex/sessions")),
        (ArchiveSource::Codex, home.join(".codex/archived_sessions")),
    ];
    for (source, root) in roots {
        let mut files = Vec::new();
        collect_jsonl(&root, &mut files);
        for path in files {
            let row = local_row(&spool, source, &path, &mut seen, &mut generations);
            println!("{row}");
        }
    }

    for source in [ArchiveSource::Claude, ArchiveSource::Codex] {
        let dir = spool_root.join("progress").join(source.as_str());
        let Ok(sessions) = fs::read_dir(&dir) else {
            continue;
        };
        for session in sessions.flatten() {
            let session_id = session.file_name().to_string_lossy().to_string();
            let Ok(parts) = fs::read_dir(session.path()) else {
                continue;
            };
            for part in parts.flatten() {
                let name = part.file_name().to_string_lossy().to_string();
                let Some(stem) = name.strip_suffix(".bin") else {
                    continue;
                };
                let Some(part_id) = part_id_from_stem(stem) else {
                    continue;
                };
                if seen.contains(&(source.as_str(), session_id.clone(), part_id.clone())) {
                    continue;
                }
                let progress = spool.progress_part(source, &session_id, &part_id);
                println!(
                    "{}",
                    json!({
                        "kind": "archive_only",
                        "source": source.as_str(),
                        "session": session_id,
                        "base_part": Value::Null,
                        "part": part_id,
                        "progress": progress_json(progress),
                    })
                );
            }
        }
    }
    println!(
        "{}",
        json!({"kind": "summary", "generations": generations.len()})
    );
    Ok(())
}

fn local_row(
    spool: &ArchiveSpool,
    source: ArchiveSource,
    path: &Path,
    seen: &mut BTreeSet<(&'static str, String, String)>,
    generations: &mut BTreeSet<(&'static str, String)>,
) -> Value {
    let path_str = path.to_string_lossy().to_string();
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return json!({"kind": "unreadable", "path": path_str, "error": error.to_string()})
        }
    };
    let head_end = complete_line_end(&bytes, HEAD_BYTES);
    let mut records = parse_jsonl_records(&bytes[..head_end]);
    let mut session = archive_source_session_id_from_records(source, &records);
    let mut part = transcript_part_for_records(source, Some(&path_str), &records);
    if (session.is_err() || part.is_err()) && head_end < bytes.len() {
        records = parse_jsonl_records(&bytes);
        session = archive_source_session_id_from_records(source, &records);
        part = transcript_part_for_records(source, Some(&path_str), &records);
    }
    let (complete_end, record_count) = match complete_record_end_offsets(&bytes) {
        Ok(ends) => (ends.last().copied().unwrap_or(0), ends.len()),
        Err(_) => (0, 0),
    };
    let (Ok(session_id), Ok((base_part_id, _))) = (session, part) else {
        return json!({
            "kind": "unidentified",
            "source": source.as_str(),
            "path": path_str,
            "size": bytes.len(),
            "records": record_count,
        });
    };
    let part_id = match spool.current_part(source, &session_id, &base_part_id) {
        Ok(part) => part,
        Err(error) => {
            return json!({
                "kind": "generation_error",
                "source": source.as_str(),
                "session": session_id,
                "base_part": base_part_id,
                "path": path_str,
                "error": error.to_string(),
            })
        }
    };
    if part_id != base_part_id {
        generations.insert((source.as_str(), session_id.clone()));
    }
    seen.insert((source.as_str(), session_id.clone(), part_id.clone()));
    let progress = spool.progress_part(source, &session_id, &part_id);
    json!({
        "kind": "local",
        "source": source.as_str(),
        "session": session_id,
        "base_part": base_part_id,
        "part": part_id,
        "path": path_str,
        "size": bytes.len(),
        "complete_end": complete_end,
        "records": record_count,
        "progress": progress_json(progress),
    })
}

fn progress_json(
    progress: collector_archive_sync::ArchiveSyncResult<Option<CompletedScanCheckpoint>>,
) -> Value {
    match progress {
        Ok(Some(checkpoint)) => json!({
            "records": checkpoint.record_count,
            "offset": checkpoint.last_complete_byte_offset,
            "observed_size": checkpoint.observed_file_size,
            "first_observed_at": checkpoint.first_observed_at,
        }),
        Ok(None) => Value::Null,
        Err(error) => json!({"error": error.to_string()}),
    }
}

fn complete_line_end(bytes: &[u8], limit: usize) -> usize {
    if bytes.len() <= limit {
        return bytes.len();
    }
    bytes[..limit]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0)
}

fn collect_jsonl(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

fn part_id_from_stem(stem: &str) -> Option<String> {
    match stem {
        "claude_part_parent" => Some("claude:part:parent".to_string()),
        "codex_part_primary" => Some("codex:part:primary".to_string()),
        _ => stem
            .strip_prefix("claude_part_sha256_")
            .map(|hex| ("claude", hex))
            .or_else(|| {
                stem.strip_prefix("codex_part_sha256_")
                    .map(|hex| ("codex", hex))
            })
            .filter(|(_, hex)| {
                hex.len() == 64
                    && hex
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            })
            .map(|(source, hex)| format!("{source}:part:sha256:{hex}")),
    }
}
