// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: Conversation Archive consent commands (TRA-222).

use collector_embedder::archive_control::{ArchiveControlPlane, ArchiveFlowRuntime};
use collector_embedder::archive_flow::{
    ArchiveFlowView, ArchiveHistoryChoice, ArchiveIntent, ArchiveSubmitResult,
};
use collector_embedder::archive_http::HttpArchiveControl;
use collector_embedder::archive_local::{
    local_archive_status, persist_enrollment, persist_unenrolled_cleanup, source_consents,
    LocalArchiveStatus,
};
use collector_embedder::connection::Paths;
use collector_embedder::defaults;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;

use crate::state::AppStateBus;

#[derive(Clone)]
pub struct ArchiveSession {
    inner: Arc<Mutex<Option<ArchiveFlowRuntime<Box<dyn ArchiveControlPlane + Send>>>>>,
}

impl Default for ArchiveSession {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ArchiveWindowDto {
    pub flow: ArchiveFlowView,
    pub local: LocalArchiveWindowDto,
}

#[derive(Debug, Serialize)]
pub struct LocalArchiveWindowDto {
    pub policy: String,
    pub enrollment_id: Option<String>,
    pub activation_id: Option<String>,
    pub spool_bytes: u64,
    pub spool_cap_bytes: u64,
    pub load_error: Option<String>,
    pub archive_error: Option<String>,
    pub authorized_sources: Vec<String>,
    pub acknowledged_content_remains: bool,
}

impl From<&LocalArchiveStatus> for LocalArchiveWindowDto {
    fn from(status: &LocalArchiveStatus) -> Self {
        Self {
            policy: status.policy.as_str().to_string(),
            enrollment_id: status.enrollment_id.clone(),
            activation_id: status.activation_id.clone(),
            spool_bytes: status.spool_bytes,
            spool_cap_bytes: status.spool_cap_bytes,
            load_error: status.load_error.clone(),
            archive_error: None,
            authorized_sources: status
                .authorized_sources
                .iter()
                .map(|source| format!("{}:{}", source.source, source.history_choice))
                .collect(),
            acknowledged_content_remains: matches!(
                status.policy.as_str(),
                "enrolled" | "revoked" | "frozen" | "grace"
            ),
        }
    }
}

fn current_connection() -> Result<(Paths, String, String), String> {
    let paths = Paths::resolve().map_err(|err| format!("{err:#}"))?;
    let conn = paths
        .load_connection()
        .map_err(|err| format!("{err:#}"))?
        .ok_or_else(|| "Connect before Conversation Archive enrollment".to_string())?;
    Ok((paths, conn.org_id, conn.collector_id))
}

fn control_plane(collector_id: &str) -> Result<Box<dyn ArchiveControlPlane + Send>, String> {
    let convex = defaults::convex_site_url();
    Ok(Box::new(
        HttpArchiveControl::new(convex, collector_id).map_err(|err| format!("{err:#}"))?,
    ))
}

fn window_dto(
    flow: ArchiveFlowView,
    bus: &AppStateBus,
    paths: &Paths,
    org_id: &str,
) -> ArchiveWindowDto {
    let mut local = LocalArchiveWindowDto::from(&local_archive_status(paths, org_id));
    local.archive_error = bus.snapshot().archive_error;
    if flow.acknowledged_content_remains {
        local.acknowledged_content_remains = true;
    }
    ArchiveWindowDto { flow, local }
}

fn persist_success(
    paths: &Paths,
    org_id: &str,
    result: &ArchiveSubmitResult,
    history: ArchiveHistoryChoice,
) -> Result<(), String> {
    persist_enrollment(paths, org_id, result, &source_consents(history))
        .map_err(|err| format!("{err:#}"))
}

impl ArchiveSession {
    pub fn view(&self, bus: &AppStateBus) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let flow = self
            .inner
            .lock()
            .as_ref()
            .map(|runtime| runtime.view())
            .unwrap_or_else(|| collector_embedder::archive_flow::ArchiveFlowState::Idle.view());
        Ok(window_dto(flow, bus, &paths, &org_id))
    }

    pub fn start(
        &self,
        bus: &AppStateBus,
        intent: ArchiveIntent,
    ) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, collector_id) = current_connection()?;
        let control = control_plane(&collector_id)?;
        let mut runtime = ArchiveFlowRuntime::new(control);
        let flow = runtime.start(intent).map_err(|err| format!("{err:#}"))?;
        let dto = window_dto(flow, bus, &paths, &org_id);
        *self.inner.lock() = Some(runtime);
        Ok(dto)
    }

    pub fn choose_history(
        &self,
        bus: &AppStateBus,
        choice: ArchiveHistoryChoice,
    ) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let mut guard = self.inner.lock();
        let runtime = guard
            .as_mut()
            .ok_or_else(|| "Archive flow is not running".to_string())?;
        Ok(window_dto(
            runtime.choose_history(choice),
            bus,
            &paths,
            &org_id,
        ))
    }

    pub fn decline(&self, bus: &AppStateBus) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let mut guard = self.inner.lock();
        let runtime = guard
            .as_mut()
            .ok_or_else(|| "Archive flow is not running".to_string())?;
        Ok(window_dto(runtime.decline_history(), bus, &paths, &org_id))
    }

    pub fn cancel(&self, bus: &AppStateBus) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let mut guard = self.inner.lock();
        if let Some(runtime) = guard.as_mut() {
            let flow = runtime.cancel();
            return Ok(window_dto(flow, bus, &paths, &org_id));
        }
        Ok(window_dto(
            collector_embedder::archive_flow::ArchiveFlowState::Idle.view(),
            bus,
            &paths,
            &org_id,
        ))
    }

    pub fn confirm(&self, bus: &AppStateBus) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let mut guard = self.inner.lock();
        let runtime = guard
            .as_mut()
            .ok_or_else(|| "Archive flow is not running".to_string())?;
        let flow = runtime.confirm().map_err(|err| format!("{err:#}"))?;
        if flow.step == "enrolled" {
            if let Some(enrollment_id) = &flow.enrollment_id {
                let result = ArchiveSubmitResult {
                    activation_id: flow.activation_id.clone(),
                    activation_created: false,
                    enrollment_id: enrollment_id.clone(),
                    contribution_id: flow.contribution_id.clone().unwrap_or_default(),
                    enrollment_created: true,
                };
                persist_success(&paths, &org_id, &result, flow.history)?;
            }
        }
        if flow.step == "left" {
            persist_unenrolled_cleanup(&paths, &org_id, None).map_err(|err| format!("{err:#}"))?;
        }
        Ok(window_dto(flow, bus, &paths, &org_id))
    }

    pub fn retry(&self, bus: &AppStateBus) -> Result<ArchiveWindowDto, String> {
        let (paths, org_id, _) = current_connection()?;
        let mut guard = self.inner.lock();
        let runtime = guard
            .as_mut()
            .ok_or_else(|| "Archive flow is not running".to_string())?;
        let flow = runtime.retry().map_err(|err| format!("{err:#}"))?;
        if flow.step == "enrolled" {
            if let Some(enrollment_id) = &flow.enrollment_id {
                let result = ArchiveSubmitResult {
                    activation_id: flow.activation_id.clone(),
                    activation_created: false,
                    enrollment_id: enrollment_id.clone(),
                    contribution_id: flow.contribution_id.clone().unwrap_or_default(),
                    enrollment_created: true,
                };
                persist_success(&paths, &org_id, &result, flow.history)?;
            }
        }
        Ok(window_dto(flow, bus, &paths, &org_id))
    }
}
