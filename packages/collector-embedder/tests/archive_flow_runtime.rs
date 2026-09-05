use collector_archive_sync::{ArchiveEnrollmentRecord, ArchivePolicy, MemoryKeyStore};
use collector_embedder::archive_control::{ArchiveFlowRuntime, FakeArchiveControlPlane};
use collector_embedder::archive_flow::{ArchiveHistoryChoice, ArchiveIntent};
use collector_embedder::archive_local::{
    local_archive_status, persist_enrollment, persist_unenrolled_cleanup, source_consents,
};
use collector_embedder::connection::Paths;
use tempfile::TempDir;

#[test]
fn guided_owner_flow_persists_consent_and_unenroll_purges_without_upload() {
    let state = TempDir::new().unwrap();
    let paths = Paths::at(state.path().to_path_buf());
    paths.ensure().unwrap();

    let mut runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::owner_pro());
    runtime.start(ArchiveIntent::EnableOrganization).unwrap();
    assert_eq!(runtime.view().history, ArchiveHistoryChoice::NewOnly);
    let view = runtime.confirm().unwrap();
    assert_eq!(view.step, "enrolled");
    assert_ne!(view.activation_id.as_deref(), view.enrollment_id.as_deref());

    let result = match &runtime.state {
        collector_embedder::archive_flow::ArchiveFlowState::Enrolled { result, .. } => {
            result.clone()
        }
        other => panic!("{other:?}"),
    };
    persist_enrollment(
        &paths,
        "org_1",
        &result,
        &source_consents(ArchiveHistoryChoice::NewOnly),
    )
    .unwrap();
    let local = local_archive_status(&paths, "org_1");
    assert_eq!(local.policy, ArchivePolicy::Enrolled);
    assert_eq!(local.authorized_sources.len(), 2);
    assert!(local
        .authorized_sources
        .iter()
        .all(|row| row.history_choice == "new_only"));
    assert!(
        !std::fs::read_to_string(paths.archive_enrollment_file("org_1"))
            .unwrap()
            .contains("tfc_")
    );

    runtime.start(ArchiveIntent::UnenrollThisComputer).unwrap();
    let left = runtime.confirm().unwrap();
    assert_eq!(left.step, "left");
    assert!(left.acknowledged_content_remains);
    persist_unenrolled_cleanup(&paths, "org_1", Some(&MemoryKeyStore::new())).unwrap();
    assert_eq!(
        ArchiveEnrollmentRecord::load(&paths.archive_enrollment_file("org_1")).unwrap(),
        ArchivePolicy::Revoked
    );
    assert_eq!(runtime.control.enroll_calls, 1);
}

#[test]
fn start_syncing_equivalent_never_touches_the_control_plane() {
    let runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::owner_pro());
    assert_eq!(runtime.view().step, "idle");
    assert_eq!(runtime.control.auth_calls, 0);
    assert_eq!(runtime.control.activate_calls, 0);
    assert_eq!(runtime.control.enroll_calls, 0);
}
