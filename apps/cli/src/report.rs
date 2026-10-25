// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: what sync passes and inputs print.

//! Output shared by one-shot `sync`, `sync --watch`, `status`, and `service install`. Counts, error
//! classes, reason codes, quarantined session ids, and input names; never transcript content, and
//! absolute paths only in the install preview the user confirms.

use std::path::Path;

use collector_contracts::AgentSource;
use collector_embedder::sync::SourceReport;

use crate::config::Input;

pub fn source_label(source: AgentSource) -> &'static str {
    match source {
        AgentSource::Claude => "claude",
        AgentSource::Codex => "codex",
        AgentSource::Cursor => "cursor",
    }
}

/// Print one summary row per Source plus its detail lines. Returns `(uploaded, failed)` sessions.
pub fn print_reports(reports: &[(AgentSource, SourceReport)]) -> (u32, u32) {
    let mut total_advanced = 0u32;
    let mut total_failed = 0u32;
    for (source, r) in reports {
        total_advanced += r.advanced;
        total_failed += r.failed;
        let note = if r.aborted_early {
            "  (stopped early)"
        } else {
            ""
        };
        println!(
            "  {:<8} scanned {:>4}  selected {:>4}  uploaded {:>4}  failed {:>3}{}",
            source_label(*source),
            r.source_files_scanned,
            r.selected,
            r.advanced,
            r.failed,
            note,
        );
        for line in source_detail_lines(r) {
            println!("           {line}");
        }
    }
    (total_advanced, total_failed)
}

/// The indented notes under a Source's summary row. Counts, error classes, reason codes and the
/// quarantined session ids the report already carries; never paths or transcript content.
pub fn source_detail_lines(r: &SourceReport) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(err) = &r.first_error {
        lines.push(format!("reason: {err}"));
    }
    if let Some(cause) = &r.invalid_envelope {
        lines.push(format!("ingest rejected an envelope: {cause}"));
    }
    for vendor_session_id in &r.quarantined {
        lines.push(format!(
            "quarantined session {vendor_session_id}: rejected by ingest; retried when it changes"
        ));
    }
    if r.skipped_quarantined > 0 {
        lines.push(format!(
            "skipped {} quarantined session(s)",
            r.skipped_quarantined
        ));
    }
    if r.skipped_lines > 0 {
        lines.push(format!(
            "skipped {} malformed transcript line(s)",
            r.skipped_lines
        ));
    }
    if r.throttled {
        let wait = r
            .retry_after
            .map_or_else(|| "a minute".to_string(), |d| format!("{}s", d.as_secs()));
        lines.push(format!("ingest is busy; try again in {wait}"));
    }
    lines
}

/// One row per configured input: name, source, matched homes, transcript files. An input whose
/// glob cannot be searched shows the error instead of counts.
pub fn print_inputs(inputs: &[Input], home: &Path, show_paths: bool) {
    for input in inputs {
        let path = if show_paths {
            format!("  {}", input.path)
        } else {
            String::new()
        };
        let counts = match input.homes(home) {
            Ok(homes) => {
                let files: usize = input
                    .source_homes(homes.clone())
                    .roots(input.source.agent_source())
                    .iter()
                    .map(|root| collector_sync::walk_transcripts(root).files.len())
                    .sum();
                format!("{:>3} home(s) {files:>6} file(s)", homes.len())
            }
            Err(err) => format!("error: {err:#}"),
        };
        println!(
            "  {:<16} {:<7} {counts}{path}",
            input.name,
            input.source.label(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::source_detail_lines;
    use collector_embedder::sync::{InvalidEnvelopeCause, SourceReport};

    #[test]
    fn source_details_show_skipped_lines_and_the_rejection_cause() {
        let report = SourceReport {
            quarantined: vec!["sess-1".to_string()],
            skipped_lines: 3,
            invalid_envelope: Some(InvalidEnvelopeCause {
                reason: Some("fact_identity_conflict".to_string()),
                category: Some("messages".to_string()),
            }),
            ..SourceReport::default()
        };
        assert_eq!(
            source_detail_lines(&report),
            [
                "ingest rejected an envelope: reason=fact_identity_conflict category=messages",
                "quarantined session sess-1: rejected by ingest; retried when it changes",
                "skipped 3 malformed transcript line(s)",
            ]
        );
        assert!(source_detail_lines(&SourceReport::default()).is_empty());
    }
}
