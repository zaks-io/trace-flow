mod compressed;
mod copies;
mod identity;
mod identity_cache;
#[cfg(test)]
mod identity_cache_tests;
#[cfg(test)]
mod tests;
mod window;

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;

use collector_archive::ArchiveSource;
use collector_archive_sync::{
    ArchiveAuthorizedSource, ArchiveHistoryChoice, ArchiveHistoryGeneration, ArchiveHistoryPlan,
    ArchiveHistoryState, ArchiveScratchLease, ArchiveSnapshot, ArchiveSpool, ArchiveWorkClass,
    DeferredArchiveSnapshot, ARCHIVE_HISTORY_STATE_VERSION,
};
use collector_contracts::AgentSource;
use collector_sync::{walk_archive_files, DISCOVERY_INCOMPLETE};
use sha2::{Digest, Sha256};

use crate::sources::SourceHomes;

use self::copies::prefix_compatible;
use self::identity::{target_from, Candidate};
use self::identity_cache::identify_remembered;
use self::window::{ARCHIVE_BASELINE_PARTS_PER_CYCLE, ARCHIVE_BASELINE_READ_BUDGET_BYTES};

#[derive(Debug)]
struct DecodedSource {
    _path: tempfile::TempPath,
    _lease: ArchiveScratchLease,
}

#[derive(Debug, Default)]
pub struct PreparedArchiveHistory {
    pub plan: ArchiveHistoryPlan,
    pub snapshots: Vec<ArchiveSnapshot>,
    pub errors: Vec<String>,
    decoded_sources: Vec<std::sync::Arc<DecodedSource>>,
}

#[cfg(test)]
pub fn prepare(
    home: &Path,
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
    now_ms: i64,
) -> PreparedArchiveHistory {
    prepare_configured(&SourceHomes::standard(home), spool, authorizations, now_ms)
}

pub fn prepare_configured(
    source_homes: &SourceHomes,
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
    now_ms: i64,
) -> PreparedArchiveHistory {
    prepare_configured_with_verification(
        source_homes,
        spool,
        authorizations,
        now_ms,
        EqualLengthVerification::Verify,
    )
}

pub fn prepare_configured_incremental(
    source_homes: &SourceHomes,
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
    now_ms: i64,
    changed_paths: &HashSet<std::path::PathBuf>,
) -> PreparedArchiveHistory {
    prepare_configured_with_verification(
        source_homes,
        spool,
        authorizations,
        now_ms,
        EqualLengthVerification::ChangedPaths(changed_paths),
    )
}

#[derive(Clone, Copy)]
enum EqualLengthVerification<'a> {
    Verify,
    ChangedPaths(&'a HashSet<std::path::PathBuf>),
}

impl EqualLengthVerification<'_> {
    fn includes(self, path: &Path) -> bool {
        match self {
            Self::Verify => true,
            Self::ChangedPaths(paths) => paths.iter().any(|changed| path.starts_with(changed)),
        }
    }
}

fn prepare_configured_with_verification(
    source_homes: &SourceHomes,
    spool: &ArchiveSpool,
    authorizations: &[ArchiveAuthorizedSource],
    now_ms: i64,
    verification: EqualLengthVerification<'_>,
) -> PreparedArchiveHistory {
    let mut prepared = PreparedArchiveHistory::default();
    let mut states = Vec::new();
    let mut live_sessions = Vec::new();
    let mut present_parts = Vec::new();
    let mut failed_sources = Vec::new();
    let mut ambiguous_excluded = Vec::new();
    let mut discovery_errors = Vec::new();
    for authorization in authorizations {
        let prior_errors = prepared.errors.len();
        let candidates = discover(
            source_homes,
            spool,
            authorization.source,
            &mut prepared.errors,
            verification,
        );
        discovery_errors.push((
            authorization.source,
            (prepared.errors.len() - prior_errors) as u32,
        ));
        if authorization.history_choice == ArchiveHistoryChoice::NewOnly {
            let ambiguous_sessions: HashSet<_> = candidates
                .iter()
                .filter(|candidate| candidate.started_at.is_none())
                .map(|candidate| candidate.session.as_str())
                .collect();
            if !ambiguous_sessions.is_empty() {
                ambiguous_excluded.push((authorization.source, ambiguous_sessions.len() as u32));
            }
        }
        let generation = ArchiveHistoryGeneration {
            source: authorization.source,
            history_choice: authorization.history_choice,
            authorized_at: authorization.authorized_at,
        };
        let loaded = match spool.history_state(authorization.source) {
            Ok(state) => state,
            Err(_) => {
                prepared.errors.push("archive_history_corrupt".to_string());
                failed_sources.push(authorization.source);
                continue;
            }
        };
        if loaded
            .as_ref()
            .is_some_and(|state| state.version != ARCHIVE_HISTORY_STATE_VERSION)
        {
            prepared
                .errors
                .push("archive_history_unsupported_version".to_string());
            failed_sources.push(authorization.source);
            continue;
        }
        let reset = loaded
            .as_ref()
            .is_none_or(|state| state.generation != generation);
        let mut state = if reset {
            let targets = candidates
                .iter()
                .filter(|candidate| {
                    authorization.history_choice == ArchiveHistoryChoice::AllHistory
                        || candidate
                            .started_at
                            .is_none_or(|started| started <= authorization.authorized_at)
                })
                .map(target_from)
                .collect();
            ArchiveHistoryState::new(generation, now_ms, targets)
        } else {
            loaded.expect("checked present generation")
        };
        let mut state_changed = reset;
        if !reset && authorization.history_choice == ArchiveHistoryChoice::AllHistory {
            for candidate in &candidates {
                state_changed |= state.register(target_from(candidate));
            }
        }
        if !reset && authorization.history_choice == ArchiveHistoryChoice::NewOnly {
            for candidate in &candidates {
                if candidate
                    .started_at
                    .is_some_and(|started| started <= authorization.authorized_at)
                {
                    state_changed |= state.register(target_from(candidate));
                }
            }
        }
        if state_changed && spool.commit_history_state(&state).is_err() {
            prepared
                .errors
                .push("archive_history_uncommitted".to_string());
            failed_sources.push(authorization.source);
            continue;
        }

        let mut scheduled = Vec::new();
        for candidate in candidates {
            present_parts.push((
                candidate.source,
                candidate.session.clone(),
                candidate.part.clone(),
                candidate.complete_extent,
            ));
            let is_live = candidate
                .started_at
                .is_some_and(|started| started > authorization.authorized_at);
            let permitted = match authorization.history_choice {
                ArchiveHistoryChoice::AllHistory => true,
                ArchiveHistoryChoice::NewOnly => {
                    !state.excludes_session(&candidate.session) && is_live
                }
            };
            if !permitted {
                continue;
            }
            if is_live {
                live_sessions.push((
                    candidate.source,
                    candidate.session.clone(),
                    candidate.activity_rank_ms,
                ));
            }
            scheduled.push(candidate);
        }
        append_snapshots(
            spool,
            &state,
            scheduled,
            &mut prepared,
            &live_sessions,
            verification,
        );
        states.push(state);
    }
    prepared.plan = ArchiveHistoryPlan::new(states)
        .with_live_sessions(live_sessions)
        .with_present_part_extents(present_parts)
        .with_failed_sources(failed_sources)
        .with_ambiguous_excluded(ambiguous_excluded)
        .with_discovery_errors(discovery_errors);
    prepared
}

fn discover(
    source_homes: &SourceHomes,
    spool: &ArchiveSpool,
    source: ArchiveSource,
    errors: &mut Vec<String>,
    verification: EqualLengthVerification<'_>,
) -> Vec<Candidate> {
    let agent_source = match source {
        ArchiveSource::Claude => AgentSource::Claude,
        ArchiveSource::Codex => AgentSource::Codex,
    };
    let known_targets = match spool.history_state(source) {
        Ok(state) => state.into_iter().flat_map(|state| state.entries).fold(
            HashMap::<String, HashSet<String>>::new(),
            |mut targets, target| {
                targets
                    .entry(target.source_session_id)
                    .or_default()
                    .insert(target.source_transcript_part_id);
                targets
            },
        ),
        Err(_) => {
            errors.push("archive_history_corrupt".to_string());
            return Vec::new();
        }
    };
    let mut groups: HashMap<(String, String), Vec<Candidate>> = HashMap::new();
    let mut remembered_provenances = HashSet::new();
    let mut skipped_errors = 0usize;
    for root in source_homes.roots(agent_source) {
        let walk = walk_archive_files(&root, agent_source);
        skipped_errors += walk.skipped_errors;
        let namespace = source_home_namespace(&root);
        for file in walk.files {
            let original_path = Path::new(&file.path);
            let compressed = source == ArchiveSource::Codex && file.path.ends_with(".jsonl.zst");
            let logical_path = if compressed {
                original_path.with_extension("")
            } else {
                original_path.to_path_buf()
            };
            if compressed {
                match logical_path.try_exists() {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(_) => {
                        errors.push("archive_io".to_string());
                        continue;
                    }
                }
            }
            let relative = logical_path
                .strip_prefix(&root)
                .unwrap_or_else(|_| Path::new(&file.path))
                .to_string_lossy()
                .into_owned();
            let provenance = format!("{namespace}/{relative}");
            let was_remembered = spool
                .source_identity(source, &provenance)
                .is_ok_and(|identity| identity.is_some());
            let identified = if compressed {
                compressed::identify_compressed(spool, original_path, provenance)
            } else {
                identify_remembered(
                    spool,
                    source,
                    &file.path,
                    provenance,
                    verification.includes(original_path),
                )
            };
            match identified {
                Ok(candidate) => {
                    if was_remembered {
                        remembered_provenances.insert(candidate.provenance.clone());
                    }
                    groups
                        .entry((candidate.session.clone(), candidate.part.clone()))
                        .or_default()
                        .push(candidate);
                }
                Err(class) => errors.push(class.to_string()),
            }
        }
    }
    if skipped_errors > 0 {
        errors.push(DISCOVERY_INCOMPLETE.to_string());
    }
    let mut candidates = Vec::new();
    for mut copies in groups.into_values() {
        copies.sort_by(|left, right| left.path.cmp(&right.path));
        let mut lineages: Vec<Candidate> = Vec::new();
        for candidate in copies {
            let compatible = lineages.iter().position(|lineage| {
                let (shorter, longer) = if candidate.size <= lineage.size {
                    (&candidate.path, &lineage.path)
                } else {
                    (&lineage.path, &candidate.path)
                };
                match prefix_compatible(shorter, longer) {
                    Ok(matches) => matches,
                    Err(_) => {
                        errors.push("archive_io".to_string());
                        false
                    }
                }
            });
            match compatible {
                Some(index) if candidate.size > lineages[index].size => {
                    let mut longer = candidate;
                    longer.provenance = lineages[index].provenance.clone();
                    longer.copies = std::mem::take(&mut lineages[index].copies);
                    longer.copies.push(lineages[index].path.clone());
                    lineages[index] = longer;
                }
                Some(index) => lineages[index].copies.push(candidate.path),
                None => lineages.push(candidate),
            }
        }
        if !assign_lineage_parts(
            spool,
            source,
            &mut lineages,
            &remembered_provenances,
            &known_targets,
            errors,
        ) {
            continue;
        }
        candidates.extend(lineages);
    }
    candidates
}

fn assign_lineage_parts(
    spool: &ArchiveSpool,
    source: ArchiveSource,
    lineages: &mut [Candidate],
    remembered_provenances: &HashSet<String>,
    known_targets: &HashMap<String, HashSet<String>>,
    errors: &mut Vec<String>,
) -> bool {
    lineages.sort_by(|left, right| left.provenance.cmp(&right.provenance));
    let original_part = lineages[0].part.clone();
    let session = lineages[0].session.as_str();
    let copy_parts = lineages
        .iter()
        .map(|lineage| copy_part_id(source, &original_part, &lineage.provenance))
        .collect::<Vec<_>>();
    let mut known_copies = Vec::with_capacity(copy_parts.len());
    for part in &copy_parts {
        if known_targets
            .get(session)
            .is_some_and(|parts| parts.contains(part))
        {
            known_copies.push(true);
            continue;
        }
        let current = match spool.current_part(source, session, part) {
            Ok(part) => part,
            Err(_) => {
                errors.push("archive_spool_corrupt".to_string());
                return false;
            }
        };
        match spool.latest_captured_checkpoint(source, session, &current) {
            Ok(checkpoint) => known_copies.push(checkpoint.is_some()),
            Err(_) => {
                errors.push("archive_spool_corrupt".to_string());
                return false;
            }
        }
    }
    if lineages.len() == 1 {
        if known_copies[0] {
            lineages[0].part = copy_parts[0].clone();
        }
        return true;
    }

    let current_part = match spool.current_part(source, session, &original_part) {
        Ok(part) => part,
        Err(_) => {
            errors.push("archive_spool_corrupt".to_string());
            return false;
        }
    };
    let checkpoint = match spool.latest_captured_checkpoint(source, session, &current_part) {
        Ok(checkpoint) => checkpoint,
        Err(_) => {
            errors.push("archive_spool_corrupt".to_string());
            return false;
        }
    };
    let mut matching_lineages = Vec::new();
    if let Some(checkpoint) = checkpoint.as_ref() {
        for (index, lineage) in lineages.iter().enumerate() {
            match prefix_matches_checkpoint(
                &lineage.path,
                checkpoint.last_complete_byte_offset,
                checkpoint.complete_prefix_sha256.as_bytes(),
            ) {
                Ok(true) if !known_copies[index] => matching_lineages.push(index),
                Ok(true) => {}
                Ok(false) => {}
                Err(_) => {
                    errors.push("archive_io".to_string());
                    return false;
                }
            }
        }
    }

    let remembered_originals = lineages
        .iter()
        .enumerate()
        .filter(|(index, lineage)| {
            checkpoint.is_some()
                && !known_copies[*index]
                && remembered_provenances.contains(&lineage.provenance)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let original_lineage = match remembered_originals.as_slice() {
        [index] => Some(*index),
        [_, _, ..] => {
            errors.push("archive_history_ambiguous_copy".to_string());
            None
        }
        [] => match matching_lineages.as_slice() {
            [index] => Some(*index),
            [] if checkpoint.is_none() => known_copies.iter().position(|known| !known),
            [] => None,
            _ => {
                errors.push("archive_history_ambiguous_copy".to_string());
                None
            }
        },
    };

    for (index, lineage) in lineages.iter_mut().enumerate() {
        if Some(index) != original_lineage {
            lineage.part = copy_parts[index].clone();
        }
    }
    true
}

fn source_home_namespace(root: &Path) -> String {
    let home = root.parent().unwrap_or(root);
    let canonical = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    collector_archive::hash_framed(
        b"trace-flow/archive/source-home/v1",
        &[canonical.to_string_lossy().as_bytes()],
    )
    .to_string()
}

fn copy_part_id(source: ArchiveSource, original_part: &str, provenance: &str) -> String {
    let digest = collector_archive::hash_framed(
        b"trace-flow/archive/source-copy/v1",
        &[original_part.as_bytes(), provenance.as_bytes()],
    );
    format!("{}:part:{digest}", source.as_str())
}

fn append_snapshots(
    spool: &ArchiveSpool,
    state: &ArchiveHistoryState,
    mut candidates: Vec<Candidate>,
    prepared: &mut PreparedArchiveHistory,
    live_sessions: &[(ArchiveSource, String, i64)],
    verification: EqualLengthVerification<'_>,
) {
    candidates.sort_by(|left, right| {
        let left_live = live_sessions
            .iter()
            .any(|(source, session, _)| *source == left.source && session == &left.session);
        let right_live = live_sessions
            .iter()
            .any(|(source, session, _)| *source == right.source && session == &right.session);
        right_live
            .cmp(&left_live)
            .then_with(|| right.activity_rank_ms.cmp(&left.activity_rank_ms))
            .then_with(|| left.session.cmp(&right.session))
            .then_with(|| left.part.cmp(&right.part))
    });
    let mut baseline_parts = 0usize;
    let mut baseline_bytes = 0u64;
    for mut candidate in candidates {
        let base_part = candidate.part.clone();
        candidate.part = match spool.current_part(candidate.source, &candidate.session, &base_part)
        {
            Ok(part) => part,
            Err(_) => {
                prepared.errors.push("archive_spool_corrupt".to_string());
                continue;
            }
        };
        let mut class = if live_sessions.iter().any(|(source, session, _)| {
            *source == candidate.source && session == &candidate.session
        }) {
            ArchiveWorkClass::Live
        } else {
            ArchiveWorkClass::Baseline
        };
        let captured = match spool.latest_captured_checkpoint(
            candidate.source,
            &candidate.session,
            &candidate.part,
        ) {
            Ok(checkpoint) => checkpoint,
            Err(_) => {
                prepared.errors.push("archive_spool_corrupt".to_string());
                continue;
            }
        };
        let rewrite_candidate = captured.as_ref().is_some_and(|checkpoint| {
            candidate.complete_extent < checkpoint.last_complete_byte_offset
                || candidate.size < checkpoint.observed_file_size
        });
        if let Some(checkpoint) = captured.as_ref().filter(|checkpoint| {
            candidate.complete_extent == checkpoint.last_complete_byte_offset
                && candidate.size == checkpoint.observed_file_size
        }) {
            if !verification.includes(&candidate.source_path) {
                continue;
            }
            match prefix_matches_checkpoint(
                &candidate.path,
                checkpoint.last_complete_byte_offset,
                checkpoint.complete_prefix_sha256.as_bytes(),
            ) {
                Ok(true) => continue,
                Ok(false) => class = ArchiveWorkClass::Live,
                Err(_) => {
                    prepared.errors.push("archive_io".to_string());
                    continue;
                }
            }
        }
        if rewrite_candidate {
            class = ArchiveWorkClass::Live;
        }
        if class == ArchiveWorkClass::Baseline {
            let exceeds_read_budget =
                baseline_bytes.saturating_add(candidate.size) > ARCHIVE_BASELINE_READ_BUDGET_BYTES;
            if baseline_parts >= ARCHIVE_BASELINE_PARTS_PER_CYCLE
                || (baseline_parts > 0 && exceeds_read_budget)
            {
                continue;
            }
        }
        let prior = captured
            .as_ref()
            .map(|checkpoint| checkpoint.last_complete_byte_offset)
            .unwrap_or(0);
        let minimum_observed_size = captured
            .as_ref()
            .map(|checkpoint| checkpoint.observed_file_size)
            .unwrap_or(0);
        if class == ArchiveWorkClass::Baseline {
            baseline_parts += 1;
            baseline_bytes = baseline_bytes.saturating_add(candidate.size);
        }
        let activity_rank_ms = if class == ArchiveWorkClass::Live {
            Some(candidate.activity_rank_ms)
        } else {
            state.rank_of_session(&candidate.session)
        };
        if let Some(decoded) = &candidate.decoded {
            prepared.decoded_sources.push(decoded.clone());
        }
        prepared.snapshots.push(ArchiveSnapshot {
            relative_path: candidate.relative_path,
            source: candidate.source,
            source_session_id: candidate.session,
            base_transcript_part_id: base_part,
            source_transcript_part_id: candidate.part,
            bytes: Vec::new(),
            deferred_file: Some(DeferredArchiveSnapshot {
                expected_file_identity: candidate.file_identity,
                expected_identity_prefix: candidate.identity_prefix,
                path: candidate.path,
                prior_offset: prior,
                minimum_observed_size,
            }),
            observed_at: candidate.activity_rank_ms,
            class,
            activity_rank_ms,
        });
    }
}

fn prefix_matches_checkpoint(
    path: &Path,
    extent: u64,
    expected: &[u8; 32],
) -> std::io::Result<bool> {
    let file = File::open(path)?;
    let mut reader = file.take(extent);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    let mut read_total = 0u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        read_total += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok(read_total == extent && hasher.finalize().as_slice() == expected)
}
