// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: Conversation Archive control-plane client (TRA-222).

//! Control-plane seam for Archive Activation and Collector Enrollment.
//!
//! Desktop never displays the short-lived session token. The fake is the runtime verification
//! target; the HTTP client talks to Convex site routes after interactive owner/member auth.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};

use crate::archive_flow::{
    consent_sources, ArchiveActivationPresence, ArchiveActorRole, ArchiveCollectorPresence,
    ArchiveEligibility, ArchiveFlowEvent, ArchiveFlowState, ArchiveFlowView, ArchiveHistoryChoice,
    ArchiveIntent, ArchivePlanKind, ArchivePlanStatus, ArchiveSubmitResult,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveSourceConsent {
    pub source: String,
    pub history_choice: ArchiveHistoryChoice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveActivationRecord {
    pub activation_id: String,
    pub org_id: String,
    pub activated_by_user_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEnrollmentRecordRemote {
    pub enrollment_id: String,
    pub contribution_id: String,
    pub org_id: String,
    pub user_id: String,
    pub collector_id: String,
    pub authorized_sources: Vec<ArchiveSourceConsent>,
    pub status: String,
}

pub trait ArchiveControlPlane {
    fn authenticate(&mut self, intent: ArchiveIntent) -> Result<ArchiveEligibility>;
    fn snapshot(&self, collector_id: &str) -> Result<ArchiveEligibility>;
    fn activate(&mut self) -> Result<(String, bool)>;
    fn enroll(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        idempotency_key: &str,
    ) -> Result<(ArchiveEnrollmentRecordRemote, bool)>;
    fn unenroll(&mut self, enrollment_id: &str) -> Result<()>;
    fn revoke(&mut self, enrollment_id: &str) -> Result<()>;
}

#[derive(Debug, Clone)]
pub struct FakeUser {
    pub user_id: String,
    pub org_id: String,
    pub role: ArchiveActorRole,
    pub plan: ArchivePlanKind,
    pub plan_status: ArchivePlanStatus,
    pub collector_id: String,
}

#[derive(Debug)]
pub struct FakeArchiveControlPlane {
    pub server_enabled: bool,
    pub current_user: FakeUser,
    pub activation: Option<ArchiveActivationRecord>,
    pub enrollments: HashMap<String, ArchiveEnrollmentRecordRemote>,
    pub next_activation: u32,
    pub next_enrollment: u32,
    pub next_contribution: u32,
    pub fail_auth: Option<String>,
    pub fail_submit: Option<String>,
    pub auth_calls: u32,
    pub activate_calls: u32,
    pub enroll_calls: u32,
    pub unenroll_calls: u32,
    pub revoke_calls: u32,
}

impl FakeArchiveControlPlane {
    pub fn owner_pro() -> Self {
        Self::new(FakeUser {
            user_id: "user_owner".into(),
            org_id: "org_1".into(),
            role: ArchiveActorRole::Owner,
            plan: ArchivePlanKind::Pro,
            plan_status: ArchivePlanStatus::Active,
            collector_id: "collector-owner".into(),
        })
    }

    pub fn member_pro() -> Self {
        Self::new(FakeUser {
            user_id: "user_member".into(),
            org_id: "org_1".into(),
            role: ArchiveActorRole::Member,
            plan: ArchivePlanKind::Pro,
            plan_status: ArchivePlanStatus::Active,
            collector_id: "collector-member".into(),
        })
    }

    pub fn new(current_user: FakeUser) -> Self {
        Self {
            server_enabled: true,
            current_user,
            activation: None,
            enrollments: HashMap::new(),
            next_activation: 1,
            next_enrollment: 1,
            next_contribution: 1,
            fail_auth: None,
            fail_submit: None,
            auth_calls: 0,
            activate_calls: 0,
            enroll_calls: 0,
            unenroll_calls: 0,
            revoke_calls: 0,
        }
    }

    fn eligibility_for(&self, collector_id: &str) -> ArchiveEligibility {
        let enrollment = self
            .enrollments
            .values()
            .find(|row| row.collector_id == collector_id && row.status == "active");
        ArchiveEligibility {
            user_id: self.current_user.user_id.clone(),
            org_id: self.current_user.org_id.clone(),
            role: self.current_user.role,
            plan: self.current_user.plan,
            plan_status: self.current_user.plan_status,
            server_enabled: self.server_enabled,
            activation: if self.activation.is_some() {
                ArchiveActivationPresence::Active
            } else {
                ArchiveActivationPresence::NotEnabled
            },
            activation_id: self
                .activation
                .as_ref()
                .map(|row| row.activation_id.clone()),
            this_collector: ArchiveCollectorPresence {
                collector_id: collector_id.to_string(),
                user_id: self.current_user.user_id.clone(),
                enrollment_id: enrollment.map(|row| row.enrollment_id.clone()),
                enrollment_status: enrollment.map(|row| row.status.clone()),
            },
        }
    }
}

impl ArchiveControlPlane for FakeArchiveControlPlane {
    fn authenticate(&mut self, _intent: ArchiveIntent) -> Result<ArchiveEligibility> {
        self.auth_calls += 1;
        if let Some(message) = &self.fail_auth {
            return Err(anyhow!("{message}"));
        }
        Ok(self.eligibility_for(&self.current_user.collector_id))
    }

    fn snapshot(&self, collector_id: &str) -> Result<ArchiveEligibility> {
        Ok(self.eligibility_for(collector_id))
    }

    fn activate(&mut self) -> Result<(String, bool)> {
        self.activate_calls += 1;
        if let Some(message) = &self.fail_submit {
            return Err(anyhow!("{message}"));
        }
        if self.current_user.role != ArchiveActorRole::Owner {
            return Err(anyhow!(
                "Only the organization owner can activate Conversation Archive"
            ));
        }
        if let Some(existing) = &self.activation {
            return Ok((existing.activation_id.clone(), false));
        }
        let activation_id = format!("act_{}", self.next_activation);
        self.next_activation += 1;
        self.activation = Some(ArchiveActivationRecord {
            activation_id: activation_id.clone(),
            org_id: self.current_user.org_id.clone(),
            activated_by_user_id: self.current_user.user_id.clone(),
        });
        Ok((activation_id, true))
    }

    fn enroll(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        _idempotency_key: &str,
    ) -> Result<(ArchiveEnrollmentRecordRemote, bool)> {
        self.enroll_calls += 1;
        if let Some(message) = &self.fail_submit {
            return Err(anyhow!("{message}"));
        }
        if self.activation.is_none() {
            return Err(anyhow!("Conversation Archive is not activated"));
        }
        if collector_id != self.current_user.collector_id {
            return Err(anyhow!("Collector Credential not found"));
        }
        if self
            .enrollments
            .values()
            .any(|row| row.collector_id == collector_id && row.status == "active")
        {
            return Err(anyhow!("Collector is already enrolled"));
        }
        let enrollment_id = format!("enr_{}", self.next_enrollment);
        self.next_enrollment += 1;
        let contribution_id = format!("con_{}", self.next_contribution);
        self.next_contribution += 1;
        let record = ArchiveEnrollmentRecordRemote {
            enrollment_id: enrollment_id.clone(),
            contribution_id,
            org_id: self.current_user.org_id.clone(),
            user_id: self.current_user.user_id.clone(),
            collector_id: collector_id.to_string(),
            authorized_sources: sources.to_vec(),
            status: "active".into(),
        };
        self.enrollments.insert(enrollment_id, record.clone());
        Ok((record, true))
    }

    fn unenroll(&mut self, enrollment_id: &str) -> Result<()> {
        self.unenroll_calls += 1;
        let Some(row) = self.enrollments.get_mut(enrollment_id) else {
            return Err(anyhow!("Enrollment not found"));
        };
        if row.user_id != self.current_user.user_id {
            return Err(anyhow!("Enrollment not found"));
        }
        row.status = "unenrolled".into();
        Ok(())
    }

    fn revoke(&mut self, enrollment_id: &str) -> Result<()> {
        self.revoke_calls += 1;
        if self.current_user.role != ArchiveActorRole::Owner {
            return Err(anyhow!(
                "Only the organization owner can revoke enrollments"
            ));
        }
        let Some(row) = self.enrollments.get_mut(enrollment_id) else {
            return Err(anyhow!("Enrollment not found"));
        };
        row.status = "revoked".into();
        Ok(())
    }
}

/// In-memory guided flow. Side effects go through [`ArchiveControlPlane`]; the machine stays pure.
pub struct ArchiveFlowRuntime<C> {
    pub state: ArchiveFlowState,
    pub control: C,
    pub last_key: Option<String>,
}

impl<C: ArchiveControlPlane> ArchiveFlowRuntime<C> {
    pub fn new(control: C) -> Self {
        Self {
            state: ArchiveFlowState::Idle,
            control,
            last_key: None,
        }
    }

    pub fn view(&self) -> ArchiveFlowView {
        self.state.view()
    }

    pub fn start(&mut self, intent: ArchiveIntent) -> Result<ArchiveFlowView> {
        self.state = self.state.apply(ArchiveFlowEvent::Start { intent });
        match self.control.authenticate(intent) {
            Ok(eligibility) => {
                self.state = self
                    .state
                    .apply(ArchiveFlowEvent::Authenticated { eligibility });
            }
            Err(err) => {
                self.state = self.state.apply(ArchiveFlowEvent::AuthFailed {
                    message: err.to_string(),
                });
            }
        }
        Ok(self.view())
    }

    pub fn choose_history(&mut self, choice: ArchiveHistoryChoice) -> ArchiveFlowView {
        self.state = self.state.apply(ArchiveFlowEvent::ChooseHistory { choice });
        self.view()
    }

    pub fn decline_history(&mut self) -> ArchiveFlowView {
        self.state = self.state.apply(ArchiveFlowEvent::DeclineHistory);
        self.view()
    }

    pub fn cancel(&mut self) -> ArchiveFlowView {
        self.state = self.state.apply(ArchiveFlowEvent::Cancel);
        self.view()
    }

    pub fn confirm(&mut self) -> Result<ArchiveFlowView> {
        self.state = self.state.apply(ArchiveFlowEvent::ConfirmConsent);
        self.submit_current()
    }

    pub fn retry(&mut self) -> Result<ArchiveFlowView> {
        self.state = self.state.apply(ArchiveFlowEvent::Retry);
        match &self.state {
            ArchiveFlowState::Authenticating { intent } => {
                let intent = *intent;
                self.start(intent)
            }
            ArchiveFlowState::Submitting { .. } => self.submit_current(),
            _ => Ok(self.view()),
        }
    }

    fn submit_current(&mut self) -> Result<ArchiveFlowView> {
        let ArchiveFlowState::Submitting {
            intent,
            eligibility,
            history,
        } = &self.state
        else {
            return Ok(self.view());
        };
        let intent = *intent;
        let eligibility = eligibility.clone();
        let history = *history;
        let collector_id = eligibility.this_collector.collector_id.clone();
        let enrollment_id = eligibility.this_collector.enrollment_id.clone();
        let activation_id = eligibility.activation_id.clone();

        let outcome = match intent {
            ArchiveIntent::EnableOrganization => {
                let history = history.unwrap_or_default();
                let sources = source_consents(history);
                let key = self.fresh_key(&collector_id, history);
                self.submit_enable(&collector_id, &sources, &key)
            }
            ArchiveIntent::ContributeThisComputer => {
                let history = history.unwrap_or_default();
                let sources = source_consents(history);
                let key = self.fresh_key(&collector_id, history);
                self.control
                    .enroll(&collector_id, &sources, &key)
                    .map(|(enrolled, created)| ArchiveSubmitResult {
                        activation_id,
                        activation_created: false,
                        enrollment_id: enrolled.enrollment_id,
                        contribution_id: enrolled.contribution_id,
                        enrollment_created: created,
                    })
            }
            ArchiveIntent::UnenrollThisComputer => {
                let Some(enrollment_id) = enrollment_id else {
                    return Ok(self.fail_submit("Enrollment not found"));
                };
                self.control
                    .unenroll(&enrollment_id)
                    .map(|_| ArchiveSubmitResult {
                        activation_id,
                        activation_created: false,
                        enrollment_id,
                        contribution_id: String::new(),
                        enrollment_created: false,
                    })
            }
            ArchiveIntent::RevokeThisCollector => {
                let Some(enrollment_id) = enrollment_id else {
                    return Ok(self.fail_submit("Enrollment not found"));
                };
                self.control
                    .revoke(&enrollment_id)
                    .map(|_| ArchiveSubmitResult {
                        activation_id,
                        activation_created: false,
                        enrollment_id,
                        contribution_id: String::new(),
                        enrollment_created: false,
                    })
            }
        };
        match outcome {
            Ok(result) => {
                self.state = self
                    .state
                    .apply(ArchiveFlowEvent::SubmitSucceeded { result });
            }
            Err(err) => {
                self.state = self.state.apply(ArchiveFlowEvent::SubmitFailed {
                    message: err.to_string(),
                });
            }
        }
        Ok(self.view())
    }

    fn submit_enable(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        key: &str,
    ) -> Result<ArchiveSubmitResult> {
        let (activation_id, activation_created) = self.control.activate()?;
        let (enrolled, enrollment_created) = self.control.enroll(collector_id, sources, key)?;
        Ok(ArchiveSubmitResult {
            activation_id: Some(activation_id),
            activation_created,
            enrollment_id: enrolled.enrollment_id,
            contribution_id: enrolled.contribution_id,
            enrollment_created,
        })
    }

    fn fail_submit(&mut self, message: &str) -> ArchiveFlowView {
        self.state = self.state.apply(ArchiveFlowEvent::SubmitFailed {
            message: message.to_string(),
        });
        self.view()
    }

    fn fresh_key(&mut self, collector_id: &str, history: ArchiveHistoryChoice) -> String {
        let key = format!(
            "consent:{collector_id}:{}:{}",
            history.as_str(),
            unique_suffix()
        );
        self.last_key = Some(key.clone());
        key
    }
}

fn source_consents(history: ArchiveHistoryChoice) -> Vec<ArchiveSourceConsent> {
    consent_sources(history)
        .into_iter()
        .map(|(source, history_choice)| ArchiveSourceConsent {
            source,
            history_choice,
        })
        .collect()
}

fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

impl ArchiveControlPlane for Box<dyn ArchiveControlPlane + Send> {
    fn authenticate(&mut self, intent: ArchiveIntent) -> Result<ArchiveEligibility> {
        (**self).authenticate(intent)
    }
    fn snapshot(&self, collector_id: &str) -> Result<ArchiveEligibility> {
        (**self).snapshot(collector_id)
    }
    fn activate(&mut self) -> Result<(String, bool)> {
        (**self).activate()
    }
    fn enroll(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        idempotency_key: &str,
    ) -> Result<(ArchiveEnrollmentRecordRemote, bool)> {
        (**self).enroll(collector_id, sources, idempotency_key)
    }
    fn unenroll(&mut self, enrollment_id: &str) -> Result<()> {
        (**self).unenroll(enrollment_id)
    }
    fn revoke(&mut self, enrollment_id: &str) -> Result<()> {
        (**self).revoke(enrollment_id)
    }
}

pub type SharedFakePlane = Arc<Mutex<FakeArchiveControlPlane>>;

impl ArchiveControlPlane for SharedFakePlane {
    fn authenticate(&mut self, intent: ArchiveIntent) -> Result<ArchiveEligibility> {
        self.lock()
            .expect("fake control plane")
            .authenticate(intent)
    }
    fn snapshot(&self, collector_id: &str) -> Result<ArchiveEligibility> {
        self.lock()
            .expect("fake control plane")
            .snapshot(collector_id)
    }
    fn activate(&mut self) -> Result<(String, bool)> {
        self.lock().expect("fake control plane").activate()
    }
    fn enroll(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        idempotency_key: &str,
    ) -> Result<(ArchiveEnrollmentRecordRemote, bool)> {
        self.lock()
            .expect("fake control plane")
            .enroll(collector_id, sources, idempotency_key)
    }
    fn unenroll(&mut self, enrollment_id: &str) -> Result<()> {
        self.lock()
            .expect("fake control plane")
            .unenroll(enrollment_id)
    }
    fn revoke(&mut self, enrollment_id: &str) -> Result<()> {
        self.lock()
            .expect("fake control plane")
            .revoke(enrollment_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_enable_creates_distinct_activation_and_enrollment() {
        let mut runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::owner_pro());
        runtime.start(ArchiveIntent::EnableOrganization).unwrap();
        let view = runtime.confirm().unwrap();
        assert_eq!(view.step, "enrolled");
        assert_eq!(runtime.control.activate_calls, 1);
        assert_eq!(runtime.control.enroll_calls, 1);
        let activation = runtime.control.activation.as_ref().unwrap();
        let enrollment = runtime.control.enrollments.values().next().unwrap();
        assert_ne!(activation.activation_id, enrollment.enrollment_id);
        assert_eq!(enrollment.user_id, "user_owner");
        assert_eq!(
            enrollment.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::NewOnly
        );
        assert!(enrollment
            .authorized_sources
            .iter()
            .all(|source| source.source == "claude" || source.source == "codex"));
    }

    #[test]
    fn login_path_never_calls_enroll() {
        let plane = FakeArchiveControlPlane::owner_pro();
        assert_eq!(plane.enroll_calls, 0);
        assert_eq!(plane.activate_calls, 0);
        let runtime = ArchiveFlowRuntime::new(plane);
        assert_eq!(runtime.view().step, "idle");
        assert_eq!(runtime.control.enroll_calls, 0);
    }

    #[test]
    fn member_cannot_activate_even_when_starting_enable() {
        let mut runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::member_pro());
        let view = runtime.start(ArchiveIntent::EnableOrganization).unwrap();
        assert_eq!(view.step, "ineligible");
        assert_eq!(runtime.control.activate_calls, 0);
        assert_eq!(runtime.control.enroll_calls, 0);
    }

    #[test]
    fn member_contribute_requires_activation_then_enrolls_only_own_collector() {
        let mut member = FakeArchiveControlPlane::member_pro();
        member.activation = Some(ArchiveActivationRecord {
            activation_id: "act_shared".into(),
            org_id: "org_1".into(),
            activated_by_user_id: "user_owner".into(),
        });
        let mut runtime = ArchiveFlowRuntime::new(member);
        runtime
            .start(ArchiveIntent::ContributeThisComputer)
            .unwrap();
        runtime.choose_history(ArchiveHistoryChoice::AllHistory);
        let view = runtime.confirm().unwrap();
        assert_eq!(view.step, "enrolled");
        assert_eq!(runtime.control.activate_calls, 0);
        let enrollment = runtime.control.enrollments.values().next().unwrap();
        assert_eq!(enrollment.user_id, "user_member");
        assert_eq!(enrollment.collector_id, "collector-member");
        assert_eq!(
            enrollment.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::AllHistory
        );
    }

    #[test]
    fn hobby_and_canceled_paths_do_not_write_server_records() {
        for (plan, status) in [
            (ArchivePlanKind::Hobby, ArchivePlanStatus::Active),
            (ArchivePlanKind::Pro, ArchivePlanStatus::Canceled),
            (ArchivePlanKind::Pro, ArchivePlanStatus::Inactive),
        ] {
            let mut plane = FakeArchiveControlPlane::owner_pro();
            plane.current_user.plan = plan;
            plane.current_user.plan_status = status;
            let mut runtime = ArchiveFlowRuntime::new(plane);
            let view = runtime.start(ArchiveIntent::EnableOrganization).unwrap();
            assert_eq!(view.step, "ineligible", "{plan:?} {status:?}");
            assert!(runtime.control.activation.is_none());
            assert!(runtime.control.enrollments.is_empty());
        }
    }

    #[test]
    fn declined_history_writes_nothing() {
        let mut runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::owner_pro());
        runtime.start(ArchiveIntent::EnableOrganization).unwrap();
        let view = runtime.decline_history();
        assert_eq!(view.step, "declined_history");
        assert_eq!(runtime.control.activate_calls, 0);
        assert_eq!(runtime.control.enroll_calls, 0);
    }

    #[test]
    fn retry_replays_submit_after_transient_failure() {
        let mut plane = FakeArchiveControlPlane::owner_pro();
        plane.fail_submit = Some("offline".into());
        let mut runtime = ArchiveFlowRuntime::new(plane);
        runtime.start(ArchiveIntent::EnableOrganization).unwrap();
        let failed = runtime.confirm().unwrap();
        assert_eq!(failed.step, "failed");
        runtime.control.fail_submit = None;
        let view = runtime.retry().unwrap();
        assert_eq!(view.step, "enrolled");
        assert_eq!(runtime.control.activate_calls, 2);
        assert_eq!(runtime.control.enroll_calls, 1);
    }

    #[test]
    fn unenroll_and_revoke_permit_no_final_upload_and_require_fresh_consent() {
        let mut runtime = ArchiveFlowRuntime::new(FakeArchiveControlPlane::owner_pro());
        runtime.start(ArchiveIntent::EnableOrganization).unwrap();
        runtime.confirm().unwrap();
        let enrollment_id = runtime
            .control
            .enrollments
            .values()
            .next()
            .unwrap()
            .enrollment_id
            .clone();
        runtime.start(ArchiveIntent::UnenrollThisComputer).unwrap();
        let left = runtime.confirm().unwrap();
        assert_eq!(left.step, "left");
        assert!(left.acknowledged_content_remains);
        assert_eq!(
            runtime.control.enrollments[&enrollment_id].status,
            "unenrolled"
        );
        runtime
            .start(ArchiveIntent::ContributeThisComputer)
            .unwrap();
        assert_eq!(runtime.view().step, "consent");
        assert_eq!(runtime.view().history, ArchiveHistoryChoice::NewOnly);
    }
}
