use collector_archive_sync::*;
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;

#[allow(clippy::too_many_arguments)]
pub async fn capture_and_upload<U: ArchiveUploader>(
    uploader: &U,
    spool: &mut ArchiveSpool,
    key_store: &dyn ArchiveKeyStore,
    snapshots: &[ArchiveSnapshot],
    policy: ArchivePolicy,
    plan: &ArchiveHistoryPlan,
    now_ms: i64,
    cancel: Option<&CancellationToken>,
) -> ArchiveCycleReport {
    let mut report =
        capture_archive_snapshots(spool, key_store, snapshots, policy, plan, now_ms, cancel);
    if report.purged || report.halted || !policy.uploads() {
        return report;
    }

    let mut attempted = HashSet::new();
    loop {
        if cancel.is_some_and(CancellationToken::is_cancelled) {
            break;
        }
        let prepared = match prepare_next_archive_upload_excluding(spool, plan, policy, &attempted)
        {
            Ok(Some(prepared)) => prepared,
            Ok(None) => break,
            Err(class) => {
                if report.first_error.as_deref() != Some(class) {
                    report.failed += 1;
                    record_error(&mut report, class);
                }
                break;
            }
        };
        let prepared_id = prepared.id();
        let response = send_prepared_archive_upload(uploader, &prepared, cancel).await;
        match apply_archive_upload_response(spool, key_store, &prepared, response) {
            Ok(UploadOutcome::Advanced) => report.uploaded += 1,
            Ok(UploadOutcome::Blocked) => {
                report.blocked += 1;
                attempted.insert(prepared_id);
            }
            Ok(UploadOutcome::Frozen) => {
                report.frozen = true;
                break;
            }
            Ok(UploadOutcome::Purged) => {
                report.purged = true;
                break;
            }
            Ok(UploadOutcome::Halt(class)) => {
                report.failed += 1;
                record_error(&mut report, class);
                report.halted = true;
                break;
            }
            Err(class) => {
                report.failed += 1;
                if class == "archive_record_too_large" {
                    report.blocked += 1;
                }
                record_error(&mut report, class);
                attempted.insert(prepared_id);
            }
        }
    }
    let refreshed = capture_archive_snapshots(
        spool,
        key_store,
        &[],
        ArchivePolicy::Frozen,
        plan,
        now_ms,
        cancel,
    );
    report.history = refreshed.history;
    report
}

fn record_error(report: &mut ArchiveCycleReport, class: &str) {
    if report.first_error.is_none() {
        report.first_error = Some(class.to_string());
    }
}
