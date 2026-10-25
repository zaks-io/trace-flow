// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: browser device-flow login.

//! `trace-flow login`: the browser sign-in that mints a Collector Credential.
//!
//! The CLI opens the Convex `/collector/authorize` route with a `127.0.0.1` `redirect_uri`, a
//! one-time `state` nonce, and a PKCE challenge (RFC 7636, S256). After sign-in the browser is
//! redirected to that loopback address with a one-time code, and the CLI redeems the code at
//! `/collector/token` with the verifier, which never leaves this process. The credential arrives
//! only in that response body and goes straight into the credential store ([`crate::keychain`]);
//! only the non-secret connection metadata is written to disk ([`crate::connection::Connection`]).
//!
//! Nothing reserves the redirect's port on the browser's machine, so whatever answers there may be
//! another process. It learns only the code, which is useless without the verifier. That is what
//! makes [`Callback::Pasted`] safe: on a headless host the browser runs on another machine, its
//! redirect fails to load, and the user pastes the address into a hidden terminal prompt, where it
//! passes the same `state` check as a request on the loopback listener.
//!
//! The credential is never logged, never put on a process arg, never persisted in plaintext.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tiny_http::{Header, Response, Server};

use crate::connection::{Connection, Paths};
use crate::keychain::CredentialStore;

/// What redeeming the sign-in code returns.
#[derive(Deserialize)]
struct Redeemed {
    secret: String,
    org_id: String,
    collector_id: String,
    convex_url: String,
}

#[derive(Deserialize)]
struct Rejected {
    error: String,
    error_description: Option<String>,
}

/// How the browser's final redirect reaches this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Callback {
    /// Open the local browser; its redirect lands on a loopback listener.
    Loopback,
    /// The browser runs on another machine; the user pastes the address it was redirected to.
    Pasted,
}

/// How long to wait for the user to finish the browser login before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// How long redeeming the sign-in code may take.
const REDEEM_TIMEOUT: Duration = Duration::from_secs(30);

/// Run the full login flow against `convex_site_url` (the Convex *site* origin, e.g.
/// `https://<deployment>.convex.site`). Stores the credential in `credentials` and the connection,
/// which records that store, under `paths` on success, and returns the bound [`Connection`] for the
/// caller to report.
pub async fn run(
    convex_site_url: &str,
    ingest_url: &str,
    paths: &Paths,
    credentials: &CredentialStore,
    callback: Callback,
) -> Result<Connection> {
    // One-time state nonce: anyone on the box can hit our loopback listener, so the callback is only
    // trusted if it carries the exact nonce we just generated and sent through the signed OAuth state.
    let state = random_hex(16);
    let pkce = Pkce::generate();
    let code = match callback {
        Callback::Loopback => {
            let server =
                Server::http("127.0.0.1:0").map_err(|e| anyhow!("bind loopback listener: {e}"))?;
            let port = server
                .server_addr()
                .to_ip()
                .context("listener has no IP address")?
                .port();
            let authorize_url = authorize_url(convex_site_url, port, &state, &pkce.challenge);
            println!("Opening your browser to sign in...");
            println!("If it doesn't open, visit:\n  {authorize_url}\n");
            // A failed auto-open is not fatal — the URL is printed above for manual use.
            let _ = webbrowser::open(&authorize_url);
            tokio::task::spawn_blocking(move || wait_for_callback(&server, &state))
                .await
                .context("wait for the browser")??
        }
        Callback::Pasted => {
            let port = free_loopback_port()?;
            let authorize_url = authorize_url(convex_site_url, port, &state, &pkce.challenge);
            println!(
                "Open this address in a browser on any device and sign in:\n  {authorize_url}\n"
            );
            println!(
                "The browser then fails to load a 127.0.0.1 page. Copy that page's full address"
            );
            println!(
                "from the address bar and paste it below. It holds a one-time code that only this"
            );
            println!("terminal can redeem. Input is hidden.\n");
            tokio::task::spawn_blocking(move || read_pasted_callback(port, &state))
                .await
                .context("read the pasted address")??
        }
    };
    let redeemed = redeem(convex_site_url, &code, &pkce.verifier).await?;

    paths.ensure()?;
    credentials.store(&redeemed.org_id, &redeemed.secret)?;
    let conn = Connection {
        org_id: redeemed.org_id,
        collector_id: redeemed.collector_id,
        convex_url: redeemed.convex_url,
        ingest_url: ingest_url.to_string(),
        expires_at: None,
        credential_store: credentials.kind(),
    };
    paths.save_connection(&conn)?;
    Ok(conn)
}

/// RFC 7636 S256: a 256-bit random verifier and the challenge the server checks it against.
struct Pkce {
    verifier: String,
    challenge: String,
}

impl Pkce {
    fn generate() -> Self {
        let mut bytes = [0u8; 32];
        // A failure here is unrecoverable for a security token, so panic rather than fall back.
        getrandom::fill(&mut bytes).expect("OS RNG for the PKCE verifier");
        let verifier = URL_SAFE_NO_PAD.encode(bytes);
        let challenge = s256_challenge(&verifier);
        Self {
            verifier,
            challenge,
        }
    }
}

fn s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(convex_site_url: &str, port: u16, state: &str, challenge: &str) -> String {
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    format!(
        "{}/collector/authorize?redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        convex_site_url.trim_end_matches('/'),
        urlencode(&redirect_uri),
        urlencode(state),
        urlencode(challenge),
    )
}

/// Exchange the one-time code and the verifier for the newly minted credential.
async fn redeem(convex_site_url: &str, code: &str, verifier: &str) -> Result<Redeemed> {
    let url = format!("{}/collector/token", convex_site_url.trim_end_matches('/'));
    let response = reqwest::Client::builder()
        .timeout(REDEEM_TIMEOUT)
        .build()
        .context("build the HTTP client")?
        .post(&url)
        .form(&[("code", code), ("code_verifier", verifier)])
        .send()
        .await
        .with_context(|| format!("redeem the sign-in code at {url}"))?;
    let status = response.status();
    if !status.is_success() {
        let reason = match response.json::<Rejected>().await {
            Ok(rejected) => rejected.error_description.unwrap_or(rejected.error),
            Err(_) => status.to_string(),
        };
        bail!("sign-in failed: {reason}; run `login` again");
    }
    // The body holds the credential, so a decode error must not quote it; reqwest's does not.
    response
        .json()
        .await
        .context("read the minted Collector Credential")
}

/// A currently free loopback port for the pasted flow's `redirect_uri`. Nothing listens on it, so a
/// browser on this machine also lands on an unreachable page whose address the user can paste.
fn free_loopback_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").context("pick a loopback port")?;
    Ok(listener.local_addr().context("loopback port")?.port())
}

/// Prompt (input hidden) until the user pastes this login's callback address. Addresses for another
/// port or nonce are rejected with a hint and the prompt repeats; an error redirect ends the login.
fn read_pasted_callback(port: u16, expected_state: &str) -> Result<String> {
    loop {
        let pasted = rpassword::prompt_password("Paste the address: ")
            .context("read the pasted address (run this in an interactive terminal)")?;
        match parse_pasted_callback(&pasted, port, expected_state) {
            Ok(CallbackOutcome::Result(result)) => return result.map_err(|e| anyhow!(e)),
            Ok(CallbackOutcome::Ignore) | Err(_) => println!(
                "That is not this sign-in's address. Copy the full address from the browser's \
                 address bar; it starts with http://127.0.0.1:{port}/callback"
            ),
        }
    }
}

/// Classify a pasted address. It must be the loopback callback on this login's port; the rest of the
/// check is the same as for a request arriving on the listener.
fn parse_pasted_callback(pasted: &str, port: u16, expected_state: &str) -> Result<CallbackOutcome> {
    let url = url::Url::parse(pasted.trim()).context("parse pasted address")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "http" || !loopback || url.port() != Some(port) {
        return Ok(CallbackOutcome::Ignore);
    }
    let path_and_query = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    parse_callback(&path_and_query, expected_state)
}

/// `bytes` from the OS CSPRNG, hex-encoded. The login's state nonce is 128 bits, single-use, and
/// matched against the `state` the callback echoes back so an unrelated local request can't
/// satisfy the listener.
fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // A failure here is unrecoverable for a security token, so panic rather than fall back.
    getrandom::fill(&mut buf).expect("OS RNG for login state nonce");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Block on the listener until the callback redirect for *this* login arrives, take the one-time
/// code out of its query string, and serve the browser a short page. Requests that are not the
/// `/callback` with the matching `state` nonce (a stray browser hit, a probe, a racing local
/// process) are answered 404 and ignored; the loop keeps waiting until a valid one lands or the
/// overall `LOGIN_TIMEOUT` elapses.
fn wait_for_callback(server: &Server, expected_state: &str) -> Result<String> {
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;

    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| anyhow!("login timed out after {}s", LOGIN_TIMEOUT.as_secs()))?;
        let request = server
            .recv_timeout(remaining)
            .context("wait for browser callback")?
            .ok_or_else(|| anyhow!("login timed out after {}s", LOGIN_TIMEOUT.as_secs()))?;

        // The path arrives as e.g. `/callback?code=...&state=...`; parse against a dummy base.
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
                    "<h2>Signed in.</h2><p>You can close this tab and return to Trace Flow.</p>"
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
/// callback for this login carrying its result (the one-time code or an error message).
enum CallbackOutcome {
    Ignore,
    Result(std::result::Result<String, String>),
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
    // A server from before PKCE puts the credential itself in the address, where another process
    // on the browser's machine could have caught it. Refuse it rather than store it.
    if params.contains_key("secret") {
        return Ok(CallbackOutcome::Result(Err(
            "the server sent a credential in the address instead of a one-time code; it is older \
             than this Collector, so the sign-in stopped"
                .to_string(),
        )));
    }
    match params.get("code") {
        Some(code) if !code.is_empty() => Ok(CallbackOutcome::Result(Ok(code.clone()))),
        _ => Ok(CallbackOutcome::Result(Err(
            "callback is missing the sign-in code".to_string(),
        ))),
    }
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
    fn result_of(outcome: CallbackOutcome) -> std::result::Result<String, String> {
        match outcome {
            CallbackOutcome::Result(r) => r,
            CallbackOutcome::Ignore => panic!("expected a callback result, got Ignore"),
        }
    }

    #[test]
    fn the_challenge_matches_the_rfc_7636_example() {
        assert_eq!(
            s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let pkce = Pkce::generate();
        assert_eq!(
            pkce.verifier.len(),
            43,
            "the shortest verifier RFC 7636 allows"
        );
        assert_eq!(pkce.challenge, s256_challenge(&pkce.verifier));
    }

    #[test]
    fn the_authorize_url_carries_the_challenge_but_never_the_verifier() {
        let pkce = Pkce::generate();
        let url = authorize_url("https://d.convex.site/", 5000, "nonce1", &pkce.challenge);
        assert!(url.starts_with("https://d.convex.site/collector/authorize?"));
        assert!(url.contains(&format!("code_challenge={}", pkce.challenge)));
        assert!(url.ends_with("&code_challenge_method=S256"));
        assert!(!url.contains(&pkce.verifier));
    }

    #[test]
    fn parse_callback_extracts_the_one_time_code() {
        let code =
            result_of(parse_callback("/callback?state=nonce1&code=one-time", "nonce1").unwrap())
                .unwrap();
        assert_eq!(code, "one-time");
    }

    #[test]
    fn a_credential_in_the_address_is_refused_not_stored() {
        let result = result_of(
            parse_callback(
                "/callback?state=nonce1&secret=tfc_abc&org_id=org_1&collector_id=cli-x&convex_url=https://d.convex.site",
                "nonce1",
            )
            .unwrap(),
        );
        let err = result.unwrap_err();
        assert!(err.contains("older than this Collector"), "{err}");
        assert!(!err.contains("tfc_abc"));
    }

    #[test]
    fn parse_callback_surfaces_an_error_redirect() {
        let result = result_of(
            parse_callback("/callback?state=nonce1&error=access_denied", "nonce1").unwrap(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_callback_rejects_a_missing_code() {
        for query in ["state=nonce1", "state=nonce1&code="] {
            let result =
                result_of(parse_callback(&format!("/callback?{query}"), "nonce1").unwrap());
            assert!(result.is_err(), "{query}");
        }
    }

    #[test]
    fn parse_callback_ignores_a_mismatched_state_nonce() {
        // A request that doesn't carry our exact nonce is not our callback — ignore it, don't fail.
        let outcome = parse_callback("/callback?state=attacker&code=evil", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn parse_callback_ignores_a_missing_state_nonce() {
        let outcome = parse_callback("/callback?code=one-time", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn parse_callback_ignores_a_non_callback_path() {
        // A stray probe to e.g. `/` on our loopback port must not be treated as the callback.
        let outcome = parse_callback("/favicon.ico?state=nonce1", "nonce1").unwrap();
        assert!(matches!(outcome, CallbackOutcome::Ignore));
    }

    #[test]
    fn pasted_address_for_this_login_yields_the_code() {
        let code = result_of(
            parse_pasted_callback(
                "  http://127.0.0.1:5000/callback?state=nonce1&code=one-time\n",
                5000,
                "nonce1",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(code, "one-time");
    }

    #[test]
    fn pasted_address_for_another_port_host_or_nonce_is_ignored() {
        let query = "state=nonce1&code=one-time";
        for address in [
            format!("http://127.0.0.1:5001/callback?{query}"),
            format!("http://evil.example:5000/callback?{query}"),
            format!("https://127.0.0.1:5000/callback?{query}"),
            "http://127.0.0.1:5000/callback?state=other&code=one-time".to_string(),
        ] {
            let outcome = parse_pasted_callback(&address, 5000, "nonce1").unwrap();
            assert!(matches!(outcome, CallbackOutcome::Ignore), "{address}");
        }
        assert!(parse_pasted_callback("not a url", 5000, "nonce1").is_err());
    }

    #[test]
    fn urlencode_escapes_colon_and_slash() {
        assert_eq!(
            urlencode("http://127.0.0.1:5000/callback"),
            "http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"
        );
    }
}
