use std::collections::HashSet;

use collector_archive::ArchiveSource;
use serde::{Deserialize, Serialize};

/// Local Archive enrollment policy. This is not a secret and does not authorize uploads by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchivePolicy {
    /// No local enrollment. Do not capture or create a spool.
    Inactive,
    /// Enrolled and allowed to capture and upload.
    Enrolled,
    /// Server archive is frozen. Retain local state; do not upload or capture.
    Frozen,
    /// Pro grace. Same local retention as frozen.
    Grace,
    /// Authoritative terminal revocation. Purge spool, key, and progress.
    Revoked,
}

impl ArchivePolicy {
    pub fn captures(self) -> bool {
        matches!(self, Self::Enrolled)
    }

    pub fn uploads(self) -> bool {
        matches!(self, Self::Enrolled)
    }

    pub fn retains(self) -> bool {
        matches!(self, Self::Enrolled | Self::Frozen | Self::Grace)
    }

    pub fn purges(self) -> bool {
        matches!(self, Self::Revoked)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inactive => "inactive",
            Self::Enrolled => "enrolled",
            Self::Frozen => "frozen",
            Self::Grace => "grace",
            Self::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchivePolicyParseError;

impl std::fmt::Display for ArchivePolicyParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unknown archive enrollment status")
    }
}

impl std::error::Error for ArchivePolicyParseError {}

impl std::str::FromStr for ArchivePolicy {
    type Err = ArchivePolicyParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "inactive" => Ok(Self::Inactive),
            "enrolled" => Ok(Self::Enrolled),
            "frozen" => Ok(Self::Frozen),
            "grace" => Ok(Self::Grace),
            "revoked" => Ok(Self::Revoked),
            _ => Err(ArchivePolicyParseError),
        }
    }
}

/// Map an Archive API denial reason onto the local policy action.
pub fn policy_from_denial_reason(reason: &str) -> Option<ArchivePolicy> {
    match reason {
        "credential_revoked" | "enrollment_invalid" | "deleting" | "expired" | "revoked" => {
            Some(ArchivePolicy::Revoked)
        }
        "frozen" => Some(ArchivePolicy::Frozen),
        "not_pro" => Some(ArchivePolicy::Grace),
        "not_enrolled" => Some(ArchivePolicy::Inactive),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveHistoryChoice {
    NewOnly,
    AllHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveAuthorizedSource {
    pub source: ArchiveSource,
    pub history_choice: ArchiveHistoryChoice,
    pub authorized_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivePolicyResponse {
    pub enrolled: bool,
    pub authorized_sources: Vec<ArchiveAuthorizedSource>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedArchivePolicy {
    pub policy: ArchivePolicy,
    pub authorized_sources: Vec<ArchiveAuthorizedSource>,
}

impl ArchivePolicyResponse {
    pub fn confirmed(self) -> Result<ConfirmedArchivePolicy, ArchivePolicyParseError> {
        if self.enrolled {
            if self.reason.is_some() || self.authorized_sources.is_empty() {
                return Err(ArchivePolicyParseError);
            }
            let unique: HashSet<_> = self
                .authorized_sources
                .iter()
                .map(|source| source.source)
                .collect();
            if unique.len() != self.authorized_sources.len()
                || self
                    .authorized_sources
                    .iter()
                    .any(|source| source.authorized_at < 0)
            {
                return Err(ArchivePolicyParseError);
            }
            return Ok(ConfirmedArchivePolicy {
                policy: ArchivePolicy::Enrolled,
                authorized_sources: self.authorized_sources,
            });
        }

        if !self.authorized_sources.is_empty() {
            return Err(ArchivePolicyParseError);
        }
        let policy = self
            .reason
            .as_deref()
            .and_then(policy_from_denial_reason)
            .ok_or(ArchivePolicyParseError)?;
        Ok(ConfirmedArchivePolicy {
            policy,
            authorized_sources: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_revocation_reasons_purge() {
        assert_eq!(
            policy_from_denial_reason("credential_revoked"),
            Some(ArchivePolicy::Revoked)
        );
        assert_eq!(
            policy_from_denial_reason("enrollment_invalid"),
            Some(ArchivePolicy::Revoked)
        );
        assert_eq!(
            policy_from_denial_reason("deleting"),
            Some(ArchivePolicy::Revoked)
        );
        assert_eq!(
            policy_from_denial_reason("revoked"),
            Some(ArchivePolicy::Revoked)
        );
        assert!(ArchivePolicy::Revoked.purges());
        assert!(!ArchivePolicy::Revoked.retains());
    }

    #[test]
    fn frozen_and_grace_retain_without_upload() {
        assert_eq!(
            policy_from_denial_reason("frozen"),
            Some(ArchivePolicy::Frozen)
        );
        assert_eq!(
            policy_from_denial_reason("not_pro"),
            Some(ArchivePolicy::Grace)
        );
        for policy in [ArchivePolicy::Frozen, ArchivePolicy::Grace] {
            assert!(policy.retains());
            assert!(!policy.uploads());
            assert!(!policy.captures());
            assert!(!policy.purges());
        }
    }

    #[test]
    fn server_policy_preserves_source_consent_metadata() {
        let confirmed = ArchivePolicyResponse {
            enrolled: true,
            authorized_sources: vec![
                ArchiveAuthorizedSource {
                    source: ArchiveSource::Claude,
                    history_choice: ArchiveHistoryChoice::AllHistory,
                    authorized_at: 1_770_000_000_001,
                },
                ArchiveAuthorizedSource {
                    source: ArchiveSource::Codex,
                    history_choice: ArchiveHistoryChoice::NewOnly,
                    authorized_at: 1_770_000_000_002,
                },
            ],
            reason: None,
        }
        .confirmed()
        .unwrap();

        assert_eq!(confirmed.policy, ArchivePolicy::Enrolled);
        assert_eq!(confirmed.authorized_sources.len(), 2);
        assert_eq!(
            confirmed.authorized_sources[0].history_choice,
            ArchiveHistoryChoice::AllHistory
        );
        assert_eq!(
            confirmed.authorized_sources[1].authorized_at,
            1_770_000_000_002
        );
    }

    #[test]
    fn malformed_or_unknown_server_policy_is_not_confirmed() {
        assert!(ArchivePolicyResponse {
            enrolled: true,
            authorized_sources: Vec::new(),
            reason: None,
        }
        .confirmed()
        .is_err());
        assert!(ArchivePolicyResponse {
            enrolled: false,
            authorized_sources: Vec::new(),
            reason: Some("policy_unavailable".to_string()),
        }
        .confirmed()
        .is_err());
    }

    #[test]
    fn from_str_accepts_inactive_and_rejects_unknown() {
        assert_eq!(
            "inactive".parse::<ArchivePolicy>().unwrap(),
            ArchivePolicy::Inactive
        );
        assert_eq!(
            "enrolled".parse::<ArchivePolicy>().unwrap(),
            ArchivePolicy::Enrolled
        );
        assert!("enrolle".parse::<ArchivePolicy>().is_err());
        assert!("".parse::<ArchivePolicy>().is_err());
        assert!("ENROLLED".parse::<ArchivePolicy>().is_err());
    }
}
