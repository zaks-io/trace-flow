// SPDX-License-Identifier: Apache-2.0
// Trace Flow Desktop: Convex Conversation Archive control-plane HTTP client.

//! Interactive Archive session + control-plane POSTs.
//!
//! The short-lived session JWT is held in memory only. It is not an Archive API key, never logged,
//! and never returned to the window.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use tiny_http::{Header, Response, Server};

use crate::archive_control::{
    ArchiveControlPlane, ArchiveEnrollmentRecordRemote, ArchiveSourceConsent,
};
use crate::archive_flow::{
    ArchiveActivationPresence, ArchiveActorRole, ArchiveCollectorPresence, ArchiveEligibility,
    ArchiveIntent, ArchivePlanKind, ArchivePlanStatus,
};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

pub struct HttpArchiveControl {
    convex_site_url: String,
    collector_id: String,
    session: Option<String>,
    client: reqwest::blocking::Client,
}

impl std::fmt::Debug for HttpArchiveControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpArchiveControl")
            .field("convex_site_url", &self.convex_site_url)
            .field("collector_id", &self.collector_id)
            .field("session", &self.session.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

impl HttpArchiveControl {
    pub fn new(
        convex_site_url: impl Into<String>,
        collector_id: impl Into<String>,
    ) -> Result<Self> {
        Ok(Self {
            convex_site_url: convex_site_url.into(),
            collector_id: collector_id.into(),
            session: None,
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .context("build archive control client")?,
        })
    }

    fn session(&self) -> Result<&str> {
        self.session
            .as_deref()
            .ok_or_else(|| anyhow!("archive session required"))
    }

    fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T> {
        let url = format!(
            "{}/{}",
            self.convex_site_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let response = self
            .client
            .post(url)
            .header("Authorization", format!("Bearer {}", self.session()?))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .context("archive control request")?;
        let status = response.status();
        let text = response.text().unwrap_or_default();
        if !status.is_success() {
            let message = serde_json::from_str::<ErrorBody>(&text)
                .ok()
                .and_then(|body| body.error)
                .unwrap_or(text);
            return Err(anyhow!("{message}"));
        }
        serde_json::from_str(&text).context("decode archive control response")
    }
}

impl ArchiveControlPlane for HttpArchiveControl {
    fn authenticate(&mut self, _intent: ArchiveIntent) -> Result<ArchiveEligibility> {
        let minted = run_archive_login(&self.convex_site_url)?;
        self.session = Some(minted.session);
        self.snapshot(&self.collector_id.clone())
    }

    fn snapshot(&self, collector_id: &str) -> Result<ArchiveEligibility> {
        let raw: SnapshotBody = self.post_json(
            "archive/desktop/snapshot",
            serde_json::json!({ "collectorId": collector_id }),
        )?;
        Ok(raw.into_eligibility())
    }

    fn activate(&mut self) -> Result<(String, bool)> {
        let raw: ActivateBody =
            self.post_json("archive/desktop/activate", serde_json::json!({}))?;
        Ok((raw.activation_id, raw.created))
    }

    fn enroll(
        &mut self,
        collector_id: &str,
        sources: &[ArchiveSourceConsent],
        idempotency_key: &str,
    ) -> Result<(ArchiveEnrollmentRecordRemote, bool)> {
        let raw: EnrollBody = self.post_json(
            "archive/desktop/enroll",
            serde_json::json!({
                "collectorId": collector_id,
                "idempotencyKey": idempotency_key,
                "authorizedSources": sources.iter().map(|source| {
                    serde_json::json!({
                        "source": source.source,
                        "historyChoice": source.history_choice.as_str(),
                    })
                }).collect::<Vec<_>>(),
            }),
        )?;
        Ok((
            ArchiveEnrollmentRecordRemote {
                enrollment_id: raw.enrollment_id.clone(),
                contribution_id: raw.contribution_id.clone(),
                org_id: String::new(),
                user_id: String::new(),
                collector_id: collector_id.to_string(),
                authorized_sources: sources.to_vec(),
                status: "active".into(),
            },
            raw.created,
        ))
    }

    fn unenroll(&mut self, enrollment_id: &str) -> Result<()> {
        let _: OkBody = self.post_json(
            "archive/desktop/unenroll",
            serde_json::json!({ "enrollmentId": enrollment_id }),
        )?;
        Ok(())
    }

    fn revoke(&mut self, enrollment_id: &str) -> Result<()> {
        let _: OkBody = self.post_json(
            "archive/desktop/revoke",
            serde_json::json!({ "enrollmentId": enrollment_id }),
        )?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OkBody {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateBody {
    activation_id: String,
    created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollBody {
    enrollment_id: String,
    contribution_id: String,
    created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotBody {
    user_id: String,
    org_id: String,
    role: String,
    plan: String,
    plan_status: String,
    server_enabled: bool,
    activation: String,
    activation_id: Option<String>,
    collector_id: String,
    collector_user_id: String,
    enrollment_id: Option<String>,
    enrollment_status: Option<String>,
}

impl SnapshotBody {
    fn into_eligibility(self) -> ArchiveEligibility {
        ArchiveEligibility {
            user_id: self.user_id,
            org_id: self.org_id,
            role: if self.role == "owner" {
                ArchiveActorRole::Owner
            } else {
                ArchiveActorRole::Member
            },
            plan: if self.plan == "pro" {
                ArchivePlanKind::Pro
            } else {
                ArchivePlanKind::Hobby
            },
            plan_status: match self.plan_status.as_str() {
                "active" => ArchivePlanStatus::Active,
                "canceled" => ArchivePlanStatus::Canceled,
                "none" => ArchivePlanStatus::None,
                _ => ArchivePlanStatus::Inactive,
            },
            server_enabled: self.server_enabled,
            activation: match self.activation.as_str() {
                "active" => ArchiveActivationPresence::Active,
                "frozen" => ArchiveActivationPresence::Frozen,
                "deleting" => ArchiveActivationPresence::Deleting,
                _ => ArchiveActivationPresence::NotEnabled,
            },
            activation_id: self.activation_id,
            this_collector: ArchiveCollectorPresence {
                collector_id: self.collector_id,
                user_id: self.collector_user_id,
                enrollment_id: self.enrollment_id,
                enrollment_status: self.enrollment_status,
            },
        }
    }
}

struct ArchiveLoginResult {
    session: String,
}

fn run_archive_login(convex_site_url: &str) -> Result<ArchiveLoginResult> {
    let server = Server::http("127.0.0.1:0").map_err(|e| anyhow!("bind loopback listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("listener has no IP address")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state = random_state();
    let authorize_url = format!(
        "{}/archive/authorize?redirect_uri={}&state={}",
        convex_site_url.trim_end_matches('/'),
        urlencode(&redirect_uri),
        urlencode(&state),
    );
    let _ = webbrowser::open(&authorize_url);
    wait_for_archive_callback(&server, &state)
}

fn random_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS RNG for archive login state nonce");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn wait_for_archive_callback(server: &Server, expected_state: &str) -> Result<ArchiveLoginResult> {
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;
    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| {
                anyhow!(
                    "archive sign-in timed out after {}s",
                    LOGIN_TIMEOUT.as_secs()
                )
            })?;
        let request = server
            .recv_timeout(remaining)
            .context("wait for archive callback")?
            .ok_or_else(|| {
                anyhow!(
                    "archive sign-in timed out after {}s",
                    LOGIN_TIMEOUT.as_secs()
                )
            })?;
        let parsed = parse_archive_callback(request.url(), expected_state)?;
        match parsed {
            CallbackOutcome::Ignore => {
                let _ = request.respond(Response::from_string("").with_status_code(404));
            }
            CallbackOutcome::Result(result) => {
                let ok = result.is_ok();
                let body = if ok {
                    "<h2>Trace Flow Archive connected.</h2><p>You can close this tab and return to Trace Flow Desktop.</p>"
                } else {
                    "<h2>Archive sign-in failed.</h2><p>Return to Trace Flow Desktop for details.</p>"
                };
                let header =
                    Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
                        .map_err(|_| anyhow!("build content-type header"))?;
                let _ = request.respond(
                    Response::from_string(body)
                        .with_header(header)
                        .with_status_code(if ok { 200 } else { 400 }),
                );
                return result.map_err(|e| anyhow!(e));
            }
        }
    }
}

enum CallbackOutcome {
    Ignore,
    Result(std::result::Result<ArchiveLoginResult, String>),
}

fn parse_archive_callback(raw_url: &str, expected_state: &str) -> Result<CallbackOutcome> {
    let url =
        url::Url::parse(&format!("http://127.0.0.1{raw_url}")).context("parse callback url")?;
    if url.path() != "/callback" {
        return Ok(CallbackOutcome::Ignore);
    }
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    match params.get("state") {
        Some(state) if state == expected_state => {}
        _ => return Ok(CallbackOutcome::Ignore),
    }
    if let Some(err) = params.get("error") {
        return Ok(CallbackOutcome::Result(Err(format!(
            "archive sign-in rejected: {err}"
        ))));
    }
    let Some(session) = params.get("session").cloned() else {
        return Ok(CallbackOutcome::Result(Err(
            "callback missing archive session".into(),
        )));
    };
    Ok(CallbackOutcome::Result(Ok(ArchiveLoginResult { session })))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive_flow::ArchiveHistoryChoice;

    fn result_of(outcome: CallbackOutcome) -> std::result::Result<ArchiveLoginResult, String> {
        match outcome {
            CallbackOutcome::Result(r) => r,
            CallbackOutcome::Ignore => panic!("expected a callback result"),
        }
    }

    #[test]
    fn parse_callback_extracts_session_without_logging_it_in_errors() {
        let inner = result_of(
            parse_archive_callback(
                "/callback?state=nonce1&session=jwt.session.token&org_id=org_1&user_id=user_1",
                "nonce1",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(inner.session, "jwt.session.token");
    }

    #[test]
    fn parse_callback_ignores_mismatched_state() {
        let outcome =
            parse_archive_callback("/callback?state=attacker&session=jwt", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn snapshot_maps_plan_and_activation() {
        let body = SnapshotBody {
            user_id: "u".into(),
            org_id: "o".into(),
            role: "owner".into(),
            plan: "pro".into(),
            plan_status: "active".into(),
            server_enabled: true,
            activation: "not_enabled".into(),
            activation_id: None,
            collector_id: "c".into(),
            collector_user_id: "u".into(),
            enrollment_id: None,
            enrollment_status: None,
        };
        let eligibility = body.into_eligibility();
        assert_eq!(eligibility.role, ArchiveActorRole::Owner);
        assert_eq!(eligibility.plan, ArchivePlanKind::Pro);
        assert_eq!(
            eligibility.activation,
            ArchiveActivationPresence::NotEnabled
        );
    }

    #[test]
    fn history_choice_serializes_as_control_plane_literals() {
        assert_eq!(ArchiveHistoryChoice::NewOnly.as_str(), "new_only");
        assert_eq!(ArchiveHistoryChoice::AllHistory.as_str(), "all_history");
    }
}
