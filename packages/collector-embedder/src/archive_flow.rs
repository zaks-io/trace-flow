// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: Conversation Archive consent state machine (TRA-222).

//! Pure Archive Activation / Enrollment consent flow.
//!
//! Login and ordinary **Start syncing** are not events this machine accepts as enrollment. The
//! Desktop commands that own those paths never construct [`ArchiveFlowEvent::Start`]. Full
//! transcript content still leaves the machine only after a successful enroll side-effect.

use serde::{Deserialize, Serialize};

/// First-release Sources named during consent. Cursor stays off until a later explicit add.
pub const ARCHIVE_CONSENT_SOURCES: [&str; 2] = ["claude", "codex"];
pub const ARCHIVE_UNSUPPORTED_SOURCES: [&str; 1] = ["cursor"];

/// Required disclosures. Tests lock the product claims, not CSS.
pub const ARCHIVE_DISCLOSURES: [&str; 4] = [
    "Claude and Codex conversations from this computer are covered by this consent. Cursor and any later Source stay off until you add them with their own history choice.",
    "Organization owners can access and export the archive.",
    "Acknowledged archive content remains after you delete local files or unenroll this computer, until the owner deletes it.",
    "Archive content is stored and processed in the United States through Cloudflare R2.",
];

pub const HISTORY_NEW_ONLY_LABEL: &str = "Start with new conversations";
pub const HISTORY_ALL_LABEL: &str = "Include all currently available history";
pub const HISTORY_NEW_ONLY_DETAIL: &str =
    "Conversations already on this computer stay out of the archive, even if they receive later records. This is not a continuation of an existing conversation.";
pub const HISTORY_ALL_DETAIL: &str =
    "Include every conversation currently available from the covered Sources, then keep capturing new ones.";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveHistoryChoice {
    #[default]
    NewOnly,
    AllHistory,
}

impl ArchiveHistoryChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewOnly => "new_only",
            Self::AllHistory => "all_history",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::NewOnly => HISTORY_NEW_ONLY_LABEL,
            Self::AllHistory => HISTORY_ALL_LABEL,
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            Self::NewOnly => HISTORY_NEW_ONLY_DETAIL,
            Self::AllHistory => HISTORY_ALL_DETAIL,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveIntent {
    EnableOrganization,
    ContributeThisComputer,
    UnenrollThisComputer,
    RevokeThisCollector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveActorRole {
    Owner,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchivePlanKind {
    Hobby,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchivePlanStatus {
    Active,
    Inactive,
    Canceled,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveActivationPresence {
    NotEnabled,
    Active,
    Frozen,
    Deleting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveCollectorPresence {
    pub collector_id: String,
    pub user_id: String,
    pub enrollment_id: Option<String>,
    pub enrollment_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveEligibility {
    pub user_id: String,
    pub org_id: String,
    pub role: ArchiveActorRole,
    pub plan: ArchivePlanKind,
    pub plan_status: ArchivePlanStatus,
    pub server_enabled: bool,
    pub activation: ArchiveActivationPresence,
    pub activation_id: Option<String>,
    pub this_collector: ArchiveCollectorPresence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveIneligibleReason {
    Hobby,
    InactivePro,
    CanceledPro,
    ArchiveDisabled,
    NotOwner,
    NotActivated,
    AlreadyEnrolled,
    Frozen,
    Deleting,
    OtherUsersCollector,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveRetryKind {
    Authenticate,
    Submit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveFlowEvent {
    Start { intent: ArchiveIntent },
    Authenticated { eligibility: ArchiveEligibility },
    AuthFailed { message: String },
    ChooseHistory { choice: ArchiveHistoryChoice },
    ConfirmConsent,
    DeclineHistory,
    SubmitSucceeded { result: ArchiveSubmitResult },
    SubmitFailed { message: String },
    Retry,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveSubmitResult {
    pub activation_id: Option<String>,
    pub activation_created: bool,
    pub enrollment_id: String,
    pub contribution_id: String,
    pub enrollment_created: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ArchiveFlowState {
    #[default]
    Idle,
    Authenticating {
        intent: ArchiveIntent,
    },
    Ineligible {
        intent: ArchiveIntent,
        reason: ArchiveIneligibleReason,
        eligibility: ArchiveEligibility,
    },
    Consent {
        intent: ArchiveIntent,
        eligibility: ArchiveEligibility,
        history: ArchiveHistoryChoice,
    },
    ConfirmLeave {
        intent: ArchiveIntent,
        eligibility: ArchiveEligibility,
    },
    Submitting {
        intent: ArchiveIntent,
        eligibility: ArchiveEligibility,
        history: Option<ArchiveHistoryChoice>,
    },
    Enrolled {
        eligibility: ArchiveEligibility,
        result: ArchiveSubmitResult,
        history: ArchiveHistoryChoice,
    },
    Left {
        intent: ArchiveIntent,
        eligibility: ArchiveEligibility,
    },
    Failed {
        intent: ArchiveIntent,
        eligibility: Option<ArchiveEligibility>,
        history: Option<ArchiveHistoryChoice>,
        retry: ArchiveRetryKind,
        message: String,
    },
    DeclinedHistory {
        intent: ArchiveIntent,
        eligibility: ArchiveEligibility,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveFlowView {
    pub step: String,
    pub intent: Option<ArchiveIntent>,
    pub history: ArchiveHistoryChoice,
    pub history_choices: [&'static str; 2],
    pub ineligible_reason: Option<ArchiveIneligibleReason>,
    pub error: Option<String>,
    pub retryable: bool,
    pub covered_sources: [&'static str; 2],
    pub unsupported_sources: [&'static str; 1],
    pub disclosures: [&'static str; 4],
    pub history_new_only_label: &'static str,
    pub history_all_label: &'static str,
    pub history_new_only_detail: &'static str,
    pub history_all_detail: &'static str,
    pub activation_id: Option<String>,
    pub enrollment_id: Option<String>,
    pub contribution_id: Option<String>,
    pub acknowledged_content_remains: bool,
}

impl ArchiveFlowState {
    pub fn apply(&self, event: ArchiveFlowEvent) -> Self {
        match (self, event) {
            (
                Self::Idle | Self::DeclinedHistory { .. } | Self::Left { .. },
                ArchiveFlowEvent::Start { intent },
            ) => Self::Authenticating { intent },
            (Self::Enrolled { eligibility, .. }, ArchiveFlowEvent::Start { intent })
                if matches!(
                    intent,
                    ArchiveIntent::UnenrollThisComputer | ArchiveIntent::RevokeThisCollector
                ) =>
            {
                Self::Authenticating { intent }
            }
            (
                Self::Enrolled {
                    eligibility,
                    result,
                    history,
                },
                ArchiveFlowEvent::Start { intent },
            ) => {
                let mut next_eligibility = eligibility.clone();
                if next_eligibility.this_collector.enrollment_status.as_deref() != Some("active") {
                    next_eligibility.this_collector.enrollment_id = None;
                    next_eligibility.this_collector.enrollment_status = None;
                    return Self::Authenticating { intent };
                }
                let _ = (result, history);
                Self::Ineligible {
                    intent,
                    reason: ArchiveIneligibleReason::AlreadyEnrolled,
                    eligibility: next_eligibility,
                }
            }
            (Self::Authenticating { intent }, ArchiveFlowEvent::Authenticated { eligibility }) => {
                decide_after_auth(*intent, eligibility)
            }
            (Self::Authenticating { intent }, ArchiveFlowEvent::AuthFailed { message }) => {
                Self::Failed {
                    intent: *intent,
                    eligibility: None,
                    history: None,
                    retry: ArchiveRetryKind::Authenticate,
                    message,
                }
            }
            (Self::Authenticating { .. }, ArchiveFlowEvent::Cancel) => Self::Idle,
            (
                Self::Consent {
                    intent,
                    eligibility,
                    ..
                },
                ArchiveFlowEvent::ChooseHistory { choice },
            ) => Self::Consent {
                intent: *intent,
                eligibility: eligibility.clone(),
                history: choice,
            },
            (
                Self::Consent {
                    intent,
                    eligibility,
                    history,
                },
                ArchiveFlowEvent::ConfirmConsent,
            ) => Self::Submitting {
                intent: *intent,
                eligibility: eligibility.clone(),
                history: Some(*history),
            },
            (
                Self::Consent {
                    intent,
                    eligibility,
                    ..
                },
                ArchiveFlowEvent::DeclineHistory,
            ) => Self::DeclinedHistory {
                intent: *intent,
                eligibility: eligibility.clone(),
            },
            (Self::Consent { .. }, ArchiveFlowEvent::Cancel) => Self::Idle,
            (
                Self::ConfirmLeave {
                    intent,
                    eligibility,
                },
                ArchiveFlowEvent::ConfirmConsent,
            ) => Self::Submitting {
                intent: *intent,
                eligibility: eligibility.clone(),
                history: None,
            },
            (Self::ConfirmLeave { .. }, ArchiveFlowEvent::Cancel) => Self::Idle,
            (
                Self::Submitting {
                    intent,
                    eligibility,
                    history,
                },
                ArchiveFlowEvent::SubmitSucceeded { result },
            ) => match intent {
                ArchiveIntent::UnenrollThisComputer | ArchiveIntent::RevokeThisCollector => {
                    Self::Left {
                        intent: *intent,
                        eligibility: eligibility.clone(),
                    }
                }
                _ => Self::Enrolled {
                    eligibility: eligibility.clone(),
                    result,
                    history: history.unwrap_or_default(),
                },
            },
            (
                Self::Submitting {
                    intent,
                    eligibility,
                    history,
                },
                ArchiveFlowEvent::SubmitFailed { message },
            ) => Self::Failed {
                intent: *intent,
                eligibility: Some(eligibility.clone()),
                history: *history,
                retry: ArchiveRetryKind::Submit,
                message,
            },
            (
                Self::Failed {
                    intent,
                    retry: ArchiveRetryKind::Authenticate,
                    ..
                },
                ArchiveFlowEvent::Retry,
            ) => Self::Authenticating { intent: *intent },
            (
                Self::Failed {
                    intent,
                    eligibility: Some(eligibility),
                    history,
                    retry: ArchiveRetryKind::Submit,
                    ..
                },
                ArchiveFlowEvent::Retry,
            ) => Self::Submitting {
                intent: *intent,
                eligibility: eligibility.clone(),
                history: *history,
            },
            (Self::Failed { .. }, ArchiveFlowEvent::Cancel) => Self::Idle,
            (Self::Ineligible { .. }, ArchiveFlowEvent::Cancel) => Self::Idle,
            (state, _) => state.clone(),
        }
    }

    pub fn view(&self) -> ArchiveFlowView {
        let acknowledged = matches!(
            self,
            Self::Left { .. }
                | Self::Enrolled { .. }
                | Self::ConfirmLeave { .. }
                | Self::DeclinedHistory { .. }
        );
        ArchiveFlowView {
            step: self.step_name().to_string(),
            intent: self.intent(),
            history: self.history(),
            history_choices: [HISTORY_NEW_ONLY_LABEL, HISTORY_ALL_LABEL],
            ineligible_reason: self.ineligible_reason(),
            error: self.error_message(),
            retryable: matches!(self, Self::Failed { .. }),
            covered_sources: ARCHIVE_CONSENT_SOURCES,
            unsupported_sources: ARCHIVE_UNSUPPORTED_SOURCES,
            disclosures: ARCHIVE_DISCLOSURES,
            history_new_only_label: HISTORY_NEW_ONLY_LABEL,
            history_all_label: HISTORY_ALL_LABEL,
            history_new_only_detail: HISTORY_NEW_ONLY_DETAIL,
            history_all_detail: HISTORY_ALL_DETAIL,
            activation_id: self.activation_id(),
            enrollment_id: self.enrollment_id(),
            contribution_id: self.contribution_id(),
            acknowledged_content_remains: acknowledged,
        }
    }

    pub fn step_name(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Authenticating { .. } => "authenticating",
            Self::Ineligible { .. } => "ineligible",
            Self::Consent { .. } => "consent",
            Self::ConfirmLeave { .. } => "confirm_leave",
            Self::Submitting { .. } => "submitting",
            Self::Enrolled { .. } => "enrolled",
            Self::Left { .. } => "left",
            Self::Failed { .. } => "failed",
            Self::DeclinedHistory { .. } => "declined_history",
        }
    }

    pub fn intent(&self) -> Option<ArchiveIntent> {
        match self {
            Self::Idle => None,
            Self::Authenticating { intent }
            | Self::Ineligible { intent, .. }
            | Self::Consent { intent, .. }
            | Self::ConfirmLeave { intent, .. }
            | Self::Submitting { intent, .. }
            | Self::Failed { intent, .. }
            | Self::DeclinedHistory { intent, .. }
            | Self::Left { intent, .. } => Some(*intent),
            Self::Enrolled { .. } => None,
        }
    }

    pub fn history(&self) -> ArchiveHistoryChoice {
        match self {
            Self::Consent { history, .. } | Self::Enrolled { history, .. } => *history,
            Self::Submitting { history, .. } | Self::Failed { history, .. } => {
                history.unwrap_or_default()
            }
            _ => ArchiveHistoryChoice::NewOnly,
        }
    }

    fn ineligible_reason(&self) -> Option<ArchiveIneligibleReason> {
        match self {
            Self::Ineligible { reason, .. } => Some(*reason),
            _ => None,
        }
    }

    fn error_message(&self) -> Option<String> {
        match self {
            Self::Failed { message, .. } => Some(message.clone()),
            _ => None,
        }
    }

    fn activation_id(&self) -> Option<String> {
        match self {
            Self::Enrolled { result, .. } => result.activation_id.clone(),
            Self::Consent { eligibility, .. }
            | Self::Submitting { eligibility, .. }
            | Self::Ineligible { eligibility, .. } => eligibility.activation_id.clone(),
            _ => None,
        }
    }

    fn enrollment_id(&self) -> Option<String> {
        match self {
            Self::Enrolled { result, .. } => Some(result.enrollment_id.clone()),
            Self::Consent { eligibility, .. }
            | Self::Submitting { eligibility, .. }
            | Self::ConfirmLeave { eligibility, .. } => {
                eligibility.this_collector.enrollment_id.clone()
            }
            _ => None,
        }
    }

    fn contribution_id(&self) -> Option<String> {
        match self {
            Self::Enrolled { result, .. } if !result.contribution_id.is_empty() => {
                Some(result.contribution_id.clone())
            }
            _ => None,
        }
    }
}

pub fn classify_eligibility(
    intent: ArchiveIntent,
    eligibility: &ArchiveEligibility,
) -> Result<(), ArchiveIneligibleReason> {
    if eligibility.this_collector.user_id != eligibility.user_id {
        return Err(ArchiveIneligibleReason::OtherUsersCollector);
    }
    if !eligibility.server_enabled {
        return Err(ArchiveIneligibleReason::ArchiveDisabled);
    }
    if eligibility.activation == ArchiveActivationPresence::Deleting {
        return Err(ArchiveIneligibleReason::Deleting);
    }
    if eligibility.activation == ArchiveActivationPresence::Frozen
        && !matches!(
            intent,
            ArchiveIntent::UnenrollThisComputer | ArchiveIntent::RevokeThisCollector
        )
    {
        return Err(ArchiveIneligibleReason::Frozen);
    }
    if eligibility.plan != ArchivePlanKind::Pro {
        return Err(ArchiveIneligibleReason::Hobby);
    }
    match eligibility.plan_status {
        ArchivePlanStatus::Active => {}
        ArchivePlanStatus::Canceled => return Err(ArchiveIneligibleReason::CanceledPro),
        ArchivePlanStatus::Inactive | ArchivePlanStatus::None => {
            return Err(ArchiveIneligibleReason::InactivePro)
        }
    }

    match intent {
        ArchiveIntent::EnableOrganization => {
            if eligibility.role != ArchiveActorRole::Owner {
                return Err(ArchiveIneligibleReason::NotOwner);
            }
            if eligibility.this_collector.enrollment_status.as_deref() == Some("active") {
                return Err(ArchiveIneligibleReason::AlreadyEnrolled);
            }
            Ok(())
        }
        ArchiveIntent::ContributeThisComputer => {
            if eligibility.activation != ArchiveActivationPresence::Active {
                return Err(ArchiveIneligibleReason::NotActivated);
            }
            if eligibility.this_collector.enrollment_status.as_deref() == Some("active") {
                return Err(ArchiveIneligibleReason::AlreadyEnrolled);
            }
            Ok(())
        }
        ArchiveIntent::UnenrollThisComputer => {
            if eligibility.this_collector.enrollment_status.as_deref() != Some("active") {
                return Err(ArchiveIneligibleReason::NotActivated);
            }
            Ok(())
        }
        ArchiveIntent::RevokeThisCollector => {
            if eligibility.role != ArchiveActorRole::Owner {
                return Err(ArchiveIneligibleReason::NotOwner);
            }
            if eligibility.this_collector.enrollment_id.is_none() {
                return Err(ArchiveIneligibleReason::NotActivated);
            }
            Ok(())
        }
    }
}

fn decide_after_auth(intent: ArchiveIntent, eligibility: ArchiveEligibility) -> ArchiveFlowState {
    match classify_eligibility(intent, &eligibility) {
        Err(reason) => ArchiveFlowState::Ineligible {
            intent,
            reason,
            eligibility,
        },
        Ok(()) => match intent {
            ArchiveIntent::EnableOrganization | ArchiveIntent::ContributeThisComputer => {
                ArchiveFlowState::Consent {
                    intent,
                    eligibility,
                    history: ArchiveHistoryChoice::NewOnly,
                }
            }
            ArchiveIntent::UnenrollThisComputer | ArchiveIntent::RevokeThisCollector => {
                ArchiveFlowState::ConfirmLeave {
                    intent,
                    eligibility,
                }
            }
        },
    }
}

pub fn consent_sources(history: ArchiveHistoryChoice) -> Vec<(String, ArchiveHistoryChoice)> {
    ARCHIVE_CONSENT_SOURCES
        .iter()
        .map(|source| ((*source).to_string(), history))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eligibility(
        role: ArchiveActorRole,
        plan: ArchivePlanKind,
        status: ArchivePlanStatus,
    ) -> ArchiveEligibility {
        ArchiveEligibility {
            user_id: "user_1".into(),
            org_id: "org_1".into(),
            role,
            plan,
            plan_status: status,
            server_enabled: true,
            activation: ArchiveActivationPresence::NotEnabled,
            activation_id: None,
            this_collector: ArchiveCollectorPresence {
                collector_id: "collector-1".into(),
                user_id: "user_1".into(),
                enrollment_id: None,
                enrollment_status: None,
            },
        }
    }

    fn activated(mut row: ArchiveEligibility) -> ArchiveEligibility {
        row.activation = ArchiveActivationPresence::Active;
        row.activation_id = Some("act_1".into());
        row
    }

    fn enrolled(mut row: ArchiveEligibility) -> ArchiveEligibility {
        row = activated(row);
        row.this_collector.enrollment_id = Some("enr_1".into());
        row.this_collector.enrollment_status = Some("active".into());
        row
    }

    fn drive(events: &[ArchiveFlowEvent]) -> ArchiveFlowState {
        events.iter().fold(ArchiveFlowState::Idle, |state, event| {
            state.apply(event.clone())
        })
    }

    fn owner_enable_auth() -> ArchiveFlowEvent {
        ArchiveFlowEvent::Authenticated {
            eligibility: eligibility(
                ArchiveActorRole::Owner,
                ArchivePlanKind::Pro,
                ArchivePlanStatus::Active,
            ),
        }
    }

    #[test]
    fn idle_ignores_consent_events_so_login_and_sync_cannot_enroll() {
        let idle = ArchiveFlowState::Idle;
        assert_eq!(
            idle.apply(ArchiveFlowEvent::ConfirmConsent),
            ArchiveFlowState::Idle
        );
        assert_eq!(
            idle.apply(ArchiveFlowEvent::ChooseHistory {
                choice: ArchiveHistoryChoice::AllHistory
            }),
            ArchiveFlowState::Idle
        );
        assert_eq!(
            idle.apply(ArchiveFlowEvent::SubmitSucceeded {
                result: ArchiveSubmitResult {
                    activation_id: Some("act".into()),
                    activation_created: true,
                    enrollment_id: "enr".into(),
                    contribution_id: "con".into(),
                    enrollment_created: true,
                }
            }),
            ArchiveFlowState::Idle
        );
    }

    #[test]
    fn owner_enable_defaults_to_new_only_and_has_exactly_two_choices() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::EnableOrganization,
            },
            owner_enable_auth(),
        ]);
        let ArchiveFlowState::Consent { history, .. } = state else {
            panic!("{state:?}");
        };
        assert_eq!(history, ArchiveHistoryChoice::NewOnly);
        let view = state.view();
        assert_eq!(
            view.history_choices,
            [HISTORY_NEW_ONLY_LABEL, HISTORY_ALL_LABEL]
        );
        assert_eq!(view.history_new_only_label, HISTORY_NEW_ONLY_LABEL);
        assert!(view
            .history_new_only_detail
            .contains("stay out of the archive"));
        assert!(view
            .history_new_only_detail
            .to_lowercase()
            .contains("not a continuation"));
        assert!(view
            .disclosures
            .iter()
            .any(|d| d.contains("Claude") && d.contains("Codex")));
        assert!(view
            .disclosures
            .iter()
            .any(|d| d.contains("owners can access and export")));
        assert!(view
            .disclosures
            .iter()
            .any(|d| d.contains("Acknowledged archive content remains")));
        assert!(view.disclosures.iter().any(|d| d.contains("United States")));
        assert_eq!(view.covered_sources, ["claude", "codex"]);
        assert_eq!(view.unsupported_sources, ["cursor"]);
    }

    #[test]
    fn owner_enable_creates_consent_then_enrolled() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::EnableOrganization,
            },
            owner_enable_auth(),
            ArchiveFlowEvent::ConfirmConsent,
            ArchiveFlowEvent::SubmitSucceeded {
                result: ArchiveSubmitResult {
                    activation_id: Some("act_1".into()),
                    activation_created: true,
                    enrollment_id: "enr_1".into(),
                    contribution_id: "con_1".into(),
                    enrollment_created: true,
                },
            },
        ]);
        let ArchiveFlowState::Enrolled {
            result, history, ..
        } = state
        else {
            panic!("{state:?}");
        };
        assert_eq!(history, ArchiveHistoryChoice::NewOnly);
        assert!(result.activation_created);
        assert!(result.enrollment_created);
        assert_ne!(
            result.activation_id.as_deref(),
            Some(result.enrollment_id.as_str())
        );
    }

    #[test]
    fn member_cannot_activate_organization() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::EnableOrganization,
            },
            ArchiveFlowEvent::Authenticated {
                eligibility: activated(eligibility(
                    ArchiveActorRole::Member,
                    ArchivePlanKind::Pro,
                    ArchivePlanStatus::Active,
                )),
            },
        ]);
        assert!(matches!(
            state,
            ArchiveFlowState::Ineligible {
                reason: ArchiveIneligibleReason::NotOwner,
                ..
            }
        ));
    }

    #[test]
    fn member_can_contribute_own_computer_after_activation() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::ContributeThisComputer,
            },
            ArchiveFlowEvent::Authenticated {
                eligibility: activated(eligibility(
                    ArchiveActorRole::Member,
                    ArchivePlanKind::Pro,
                    ArchivePlanStatus::Active,
                )),
            },
        ]);
        assert!(matches!(
            state,
            ArchiveFlowState::Consent {
                intent: ArchiveIntent::ContributeThisComputer,
                ..
            }
        ));
    }

    #[test]
    fn member_cannot_enroll_another_users_collector() {
        let mut row = activated(eligibility(
            ArchiveActorRole::Member,
            ArchivePlanKind::Pro,
            ArchivePlanStatus::Active,
        ));
        row.this_collector.user_id = "user_other".into();
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::ContributeThisComputer,
            },
            ArchiveFlowEvent::Authenticated { eligibility: row },
        ]);
        assert!(matches!(
            state,
            ArchiveFlowState::Ineligible {
                reason: ArchiveIneligibleReason::OtherUsersCollector,
                ..
            }
        ));
    }

    #[test]
    fn hobby_inactive_and_canceled_pro_are_ineligible() {
        for (plan, status, reason) in [
            (
                ArchivePlanKind::Hobby,
                ArchivePlanStatus::Active,
                ArchiveIneligibleReason::Hobby,
            ),
            (
                ArchivePlanKind::Pro,
                ArchivePlanStatus::Inactive,
                ArchiveIneligibleReason::InactivePro,
            ),
            (
                ArchivePlanKind::Pro,
                ArchivePlanStatus::Canceled,
                ArchiveIneligibleReason::CanceledPro,
            ),
        ] {
            let state = drive(&[
                ArchiveFlowEvent::Start {
                    intent: ArchiveIntent::EnableOrganization,
                },
                ArchiveFlowEvent::Authenticated {
                    eligibility: eligibility(ArchiveActorRole::Owner, plan, status),
                },
            ]);
            assert_eq!(
                state.ineligible_reason(),
                Some(reason),
                "{plan:?} {status:?}"
            );
        }
    }

    #[test]
    fn declined_history_does_not_submit() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::EnableOrganization,
            },
            owner_enable_auth(),
            ArchiveFlowEvent::ChooseHistory {
                choice: ArchiveHistoryChoice::AllHistory,
            },
            ArchiveFlowEvent::DeclineHistory,
        ]);
        assert!(matches!(state, ArchiveFlowState::DeclinedHistory { .. }));
        assert_eq!(state.apply(ArchiveFlowEvent::ConfirmConsent), state);
    }

    #[test]
    fn retry_after_submit_failure_keeps_chosen_history() {
        let failed = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::EnableOrganization,
            },
            owner_enable_auth(),
            ArchiveFlowEvent::ChooseHistory {
                choice: ArchiveHistoryChoice::AllHistory,
            },
            ArchiveFlowEvent::ConfirmConsent,
            ArchiveFlowEvent::SubmitFailed {
                message: "network".into(),
            },
        ]);
        let retried = failed.apply(ArchiveFlowEvent::Retry);
        let ArchiveFlowState::Submitting { history, .. } = retried else {
            panic!("{retried:?}");
        };
        assert_eq!(history, Some(ArchiveHistoryChoice::AllHistory));
    }

    #[test]
    fn retry_after_auth_failure_restarts_authentication() {
        let failed = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::ContributeThisComputer,
            },
            ArchiveFlowEvent::AuthFailed {
                message: "cancelled".into(),
            },
        ]);
        assert_eq!(
            failed.apply(ArchiveFlowEvent::Retry),
            ArchiveFlowState::Authenticating {
                intent: ArchiveIntent::ContributeThisComputer
            }
        );
    }

    #[test]
    fn member_cannot_contribute_before_activation() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::ContributeThisComputer,
            },
            ArchiveFlowEvent::Authenticated {
                eligibility: eligibility(
                    ArchiveActorRole::Member,
                    ArchivePlanKind::Pro,
                    ArchivePlanStatus::Active,
                ),
            },
        ]);
        assert!(matches!(
            state,
            ArchiveFlowState::Ineligible {
                reason: ArchiveIneligibleReason::NotActivated,
                ..
            }
        ));
    }

    #[test]
    fn reenrollment_after_leave_starts_fresh_consent() {
        let left = ArchiveFlowState::Left {
            intent: ArchiveIntent::UnenrollThisComputer,
            eligibility: enrolled(eligibility(
                ArchiveActorRole::Owner,
                ArchivePlanKind::Pro,
                ArchivePlanStatus::Active,
            )),
        };
        let next = left.apply(ArchiveFlowEvent::Start {
            intent: ArchiveIntent::ContributeThisComputer,
        });
        assert!(matches!(next, ArchiveFlowState::Authenticating { .. }));
    }

    #[test]
    fn unenroll_view_says_acknowledged_content_remains() {
        let state = drive(&[
            ArchiveFlowEvent::Start {
                intent: ArchiveIntent::UnenrollThisComputer,
            },
            ArchiveFlowEvent::Authenticated {
                eligibility: enrolled(eligibility(
                    ArchiveActorRole::Owner,
                    ArchivePlanKind::Pro,
                    ArchivePlanStatus::Active,
                )),
            },
        ]);
        assert!(state.view().acknowledged_content_remains);
        assert!(matches!(state, ArchiveFlowState::ConfirmLeave { .. }));
    }

    #[test]
    fn cursor_is_named_unsupported_and_not_a_consent_source() {
        assert!(!ARCHIVE_CONSENT_SOURCES.contains(&"cursor"));
        assert!(ARCHIVE_UNSUPPORTED_SOURCES.contains(&"cursor"));
        let sources = consent_sources(ArchiveHistoryChoice::NewOnly);
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().all(|(source, _)| source != "cursor"));
    }
}
