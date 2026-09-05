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

impl std::str::FromStr for ArchivePolicy {
    type Err = std::convert::Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value {
            "enrolled" => Self::Enrolled,
            "frozen" => Self::Frozen,
            "grace" => Self::Grace,
            "revoked" => Self::Revoked,
            _ => Self::Inactive,
        })
    }
}

/// Map an Archive API denial reason onto the local policy action.
pub fn policy_from_denial_reason(reason: &str) -> Option<ArchivePolicy> {
    match reason {
        "credential_revoked" | "enrollment_invalid" | "deleting" | "revoked" => {
            Some(ArchivePolicy::Revoked)
        }
        "frozen" => Some(ArchivePolicy::Frozen),
        _ => None,
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
        for policy in [ArchivePolicy::Frozen, ArchivePolicy::Grace] {
            assert!(policy.retains());
            assert!(!policy.uploads());
            assert!(!policy.captures());
            assert!(!policy.purges());
        }
    }
}
