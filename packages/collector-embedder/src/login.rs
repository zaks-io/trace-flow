// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI: browser device-flow login.

//! `trace-flow login` — the browser device flow that mints a Collector Credential.
//!
//! The CLI binds a one-shot HTTP listener on a random `127.0.0.1` port, opens the browser to the
//! Convex `/collector/authorize` route with that loopback as the `redirect_uri`, and blocks until the
//! `/collector/callback` redirect lands the minted secret + org metadata back on the listener. The
//! secret then goes straight into the OS keychain ([`crate::keychain`]); only the non-secret
//! connection metadata is written to disk ([`crate::connection::Connection`]).
//!
//! The secret travels exactly once, over a loopback redirect the Convex side restricts to
//! `127.0.0.1`. It is never logged, never put on a process arg, never persisted in plaintext.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tiny_http::{Header, Response, Server};

use crate::connection::{Connection, Paths};
use crate::keychain;

/// The minted material the callback hands back over the loopback redirect.
struct LoginResult {
    secret: String,
    org_id: String,
    collector_id: String,
    expires_at: i64,
    convex_url: String,
}

/// How long to wait for the user to finish the browser login before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Run the full login flow against `convex_site_url` (the Convex *site* origin, e.g.
/// `https://<deployment>.convex.site`). Stores the credential and connection on success and returns
/// the bound [`Connection`] for the caller to report.
pub fn run(convex_site_url: &str, ingest_url: &str) -> Result<Connection> {
    let server = Server::http("127.0.0.1:0").map_err(|e| anyhow!("bind loopback listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("listener has no IP address")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    // One-time state nonce: anyone on the box can hit our loopback listener, so the callback is only
    // trusted if it carries the exact nonce we just generated and sent through the signed OAuth state.
    let state = random_state();
    let authorize_url = format!(
        "{}/collector/authorize?redirect_uri={}&state={}",
        convex_site_url.trim_end_matches('/'),
        urlencode(&redirect_uri),
        urlencode(&state),
    );

    println!("Opening your browser to sign in...");
    println!("If it doesn't open, visit:\n  {authorize_url}\n");
    // A failed auto-open is not fatal — the URL is printed above for manual use.
    let _ = webbrowser::open(&authorize_url);

    let result = wait_for_callback(&server, &state)?;

    let paths = Paths::resolve()?;
    paths.ensure()?;
    keychain::store(&result.org_id, &result.secret)?;
    let conn = Connection {
        org_id: result.org_id,
        collector_id: result.collector_id,
        convex_url: result.convex_url,
        ingest_url: ingest_url.to_string(),
        expires_at: result.expires_at,
    };
    paths.save_connection(&conn)?;
    Ok(conn)
}

/// A 128-bit random state nonce, hex-encoded. Single-use per login; matched against the `state` the
/// callback echoes back so an unrelated local request can't satisfy the listener.
fn random_state() -> String {
    let mut bytes = [0u8; 16];
    // getrandom reads the OS CSPRNG; a failure here is unrecoverable for a security token, so panic
    // rather than fall back to a weak source.
    getrandom::fill(&mut bytes).expect("OS RNG for login state nonce");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Block on the listener until the callback redirect for *this* login arrives, parse the minted
/// material out of its query string, and serve the browser a short success page. Requests that are not
/// the `/callback` with the matching `state` nonce (a stray browser hit, a probe, a racing local
/// process) are answered 404 and ignored; the loop keeps waiting until a valid one lands or the overall
/// `LOGIN_TIMEOUT` elapses.
fn wait_for_callback(server: &Server, expected_state: &str) -> Result<LoginResult> {
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;

    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| anyhow!("login timed out after {}s", LOGIN_TIMEOUT.as_secs()))?;
        let request = server
            .recv_timeout(remaining)
            .context("wait for browser callback")?
            .ok_or_else(|| anyhow!("login timed out after {}s", LOGIN_TIMEOUT.as_secs()))?;

        // The path arrives as e.g. `/callback?secret=...&state=...`; parse against a dummy base.
        let parsed = parse_callback(request.url(), expected_state)?;

        match parsed {
            // Not our callback (wrong path / missing or mismatched state): ignore and keep waiting so
            // a stray request can't end the login. 404 keeps the browser quiet without signaling success.
            CallbackOutcome::Ignore => {
                let _ = request.respond(Response::from_string("").with_status_code(404));
                continue;
            }
            CallbackOutcome::Result(result) => {
                let ok = result.is_ok();
                let body = if ok {
                    "<h2>Trace Flow connected.</h2><p>You can close this tab and return to Trace Flow.</p>"
                } else {
                    "<h2>Login failed.</h2><p>Return to Trace Flow for details.</p>"
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

/// What a received loopback request is: either not our callback (ignore and keep waiting) or the
/// callback for this login carrying its result (a `LoginResult` or an error-redirect message).
enum CallbackOutcome {
    Ignore,
    Result(std::result::Result<LoginResult, String>),
}

/// Classify a loopback request by its raw URL. A request is only the login callback if its path is
/// `/callback` AND its `state` matches the nonce this login generated; anything else is `Ignore` so a
/// stray or hostile local request cannot end (or hijack) the wait. `Err` only for a malformed URL.
fn parse_callback(raw_url: &str, expected_state: &str) -> Result<CallbackOutcome> {
    let url =
        url::Url::parse(&format!("http://127.0.0.1{raw_url}")).context("parse callback url")?;

    if url.path() != "/callback" {
        return Ok(CallbackOutcome::Ignore);
    }

    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    // The state nonce gates everything: without a match this is not the request we initiated. Use a
    // length-checked constant-time-ish compare (the nonce is not secret, but matching it is the gate).
    match params.get("state") {
        Some(state) if state.as_bytes().ct_eq(expected_state.as_bytes()) => {}
        _ => return Ok(CallbackOutcome::Ignore),
    }

    if let Some(err) = params.get("error") {
        return Ok(CallbackOutcome::Result(Err(format!(
            "login rejected: {err}"
        ))));
    }

    let get = |k: &str| params.get(k).cloned();
    let (Some(secret), Some(org_id), Some(collector_id), Some(expires_at), Some(convex_url)) = (
        get("secret"),
        get("org_id"),
        get("collector_id"),
        get("expires_at"),
        get("convex_url"),
    ) else {
        return Ok(CallbackOutcome::Result(Err(
            "callback missing required fields".to_string(),
        )));
    };

    let expires_at: i64 = expires_at
        .parse()
        .map_err(|_| anyhow!("callback expires_at not an integer"))?;

    Ok(CallbackOutcome::Result(Ok(LoginResult {
        secret,
        org_id,
        collector_id,
        expires_at,
        convex_url,
    })))
}

/// Minimal length-checked byte equality for the state nonce. Avoids a new crate dep; the nonce isn't
/// secret, so this is about correctness of the gate, not timing-attack resistance.
trait CtEq {
    fn ct_eq(&self, other: &Self) -> bool;
}
impl CtEq for [u8] {
    fn ct_eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().zip(other).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
    }
}

/// Minimal percent-encoding for the one redirect_uri we build (only `:` and `/` need escaping for a
/// loopback http URL used as a query value; encode the full unreserved-safe set to be safe).
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

    /// Unwrap a `CallbackOutcome::Result`, panicking on `Ignore` (used by tests that expect a match).
    fn result_of(outcome: CallbackOutcome) -> std::result::Result<LoginResult, String> {
        match outcome {
            CallbackOutcome::Result(r) => r,
            CallbackOutcome::Ignore => panic!("expected a callback result, got Ignore"),
        }
    }

    #[test]
    fn parse_callback_extracts_minted_fields() {
        let inner = result_of(
            parse_callback(
                "/callback?state=nonce1&secret=tfc_abc&org_id=org_1&collector_id=cli-x&expires_at=123&convex_url=https://d.convex.site",
                "nonce1",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(inner.secret, "tfc_abc");
        assert_eq!(inner.org_id, "org_1");
        assert_eq!(inner.collector_id, "cli-x");
        assert_eq!(inner.expires_at, 123);
        assert_eq!(inner.convex_url, "https://d.convex.site");
    }

    #[test]
    fn parse_callback_surfaces_an_error_redirect() {
        let result = result_of(
            parse_callback("/callback?state=nonce1&error=access_denied", "nonce1").unwrap(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_callback_rejects_missing_fields() {
        let result =
            result_of(parse_callback("/callback?state=nonce1&secret=only", "nonce1").unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn parse_callback_ignores_a_mismatched_state_nonce() {
        // A request that doesn't carry our exact nonce is not our callback — ignore it, don't fail.
        let outcome = parse_callback(
            "/callback?state=attacker&secret=tfc_evil&org_id=o&collector_id=c&expires_at=1&convex_url=https://x",
            "nonce1",
        )
        .unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn parse_callback_ignores_a_missing_state_nonce() {
        let outcome = parse_callback("/callback?secret=tfc_x&org_id=o", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn parse_callback_ignores_a_non_callback_path() {
        // A stray probe to e.g. `/` on our loopback port must not be treated as the callback.
        let outcome = parse_callback("/favicon.ico?state=nonce1", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn urlencode_escapes_colon_and_slash() {
        assert_eq!(
            urlencode("http://127.0.0.1:5000/callback"),
            "http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"
        );
    }
}
