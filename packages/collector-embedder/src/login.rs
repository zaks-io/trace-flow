// SPDX-License-Identifier: Apache-2.0
// Trace Flow Collector CLI: browser device-flow login.

//! `trace-flow login`: the browser sign-in that mints a Collector Credential.
//!
//! The CLI opens the Convex `/collector/authorize` route with a PKCE challenge (RFC 7636, S256).
//! The user approves the connection on a Trace Flow consent page, signs in, and receives a
//! one-time code, which the CLI redeems at `/collector/token` with the verifier that never leaves
//! this process. The credential arrives only in that response body and goes straight into the
//! credential store ([`crate::keychain`]); only the non-secret connection metadata is written to
//! disk ([`crate::connection::Connection`]).
//!
//! [`Callback::Loopback`] opens a browser on this machine and receives the code on a `127.0.0.1`
//! listener it already holds, with a one-time `state` nonce. It never prints that address: opened
//! on another machine, the redirect would reach whatever listens on that port there.
//! [`Callback::OutOfBand`] is for hosts without a browser. The sign-in ends on a Trace Flow page
//! that shows the code, and the user types or pastes it into this terminal, so no request reaches
//! the browser's machine at all.
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

/// How the one-time sign-in code reaches this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Callback {
    /// Open the local browser; its redirect lands on a loopback listener.
    Loopback,
    /// The browser runs on another device and shows the code for the user to paste here.
    OutOfBand,
}

/// The redirect URN that asks the server to show the code on a page instead of redirecting.
const OUT_OF_BAND_REDIRECT: &str = "urn:ietf:wg:oauth:2.0:oob";

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
            let redirect_uri = format!("http://127.0.0.1:{port}/callback");
            let authorize_url =
                authorize_url(convex_site_url, &redirect_uri, &state, &pkce.challenge);
            webbrowser::open(&authorize_url).map_err(|err| {
                anyhow!(
                    "could not open a browser here ({err}); run `login --no-browser` to sign in \
                     from another device"
                )
            })?;
            println!("Approve the connection and sign in in the browser that just opened.");
            println!("If none did, stop this and run `login --no-browser` instead.");
            tokio::task::spawn_blocking(move || wait_for_callback(&server, &state))
                .await
                .context("wait for the browser")??
        }
        Callback::OutOfBand => {
            let authorize_url = authorize_url(
                convex_site_url,
                OUT_OF_BAND_REDIRECT,
                &state,
                &pkce.challenge,
            );
            println!(
                "Open this address in a browser on any device, approve the connection, and sign \
                 in:\n  {authorize_url}\n"
            );
            println!("Trace Flow then shows a one-time code that only this terminal can redeem.\n");
            tokio::task::spawn_blocking(|| {
                read_code(&mut std::io::stdin().lock(), &mut std::io::stdout())
            })
            .await
            .context("read the sign-in code")??
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

fn authorize_url(
    convex_site_url: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    format!(
        "{}/collector/authorize?redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        convex_site_url.trim_end_matches('/'),
        urlencode(redirect_uri),
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

/// Prompt until the user enters something shaped like a sign-in code. A pasted address or other
/// text gets a hint and the prompt repeats, so a slip does not cost the sign-in.
fn read_code(
    input: &mut impl std::io::BufRead,
    output: &mut impl std::io::Write,
) -> Result<String> {
    loop {
        write!(output, "Sign-in code: ")?;
        output.flush()?;
        let mut line = String::new();
        if input
            .read_line(&mut line)
            .context("read the sign-in code")?
            == 0
        {
            bail!(
                "no sign-in code was entered; run `login --no-browser` in an interactive terminal"
            );
        }
        let code = line.trim();
        if is_code_shaped(code) {
            return Ok(code.to_string());
        }
        if !code.is_empty() {
            writeln!(
                output,
                "That is not a sign-in code. Copy only the code the Trace Flow page shows."
            )?;
        }
    }
}

fn is_code_shaped(code: &str) -> bool {
    (1..=128).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
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
        let url = authorize_url(
            "https://d.convex.site/",
            OUT_OF_BAND_REDIRECT,
            "nonce1",
            &pkce.challenge,
        );
        assert!(url.starts_with(
            "https://d.convex.site/collector/authorize?redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&"
        ));
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
    fn the_typed_code_is_read_after_any_slips() {
        let mut input = std::io::Cursor::new(
            "\nhttp://127.0.0.1:5000/callback?code=x\n  6f1c2a4e-9b1d-4c1e-8f00-0123456789ab \n",
        );
        let mut output = Vec::new();
        let code = read_code(&mut input, &mut output).unwrap();
        assert_eq!(code, "6f1c2a4e-9b1d-4c1e-8f00-0123456789ab");
        let shown = String::from_utf8(output).unwrap();
        assert_eq!(shown.matches("Sign-in code: ").count(), 3);
        assert_eq!(shown.matches("That is not a sign-in code").count(), 1);
    }

    #[test]
    fn a_closed_input_ends_the_sign_in() {
        let err = read_code(&mut std::io::Cursor::new(""), &mut Vec::new()).unwrap_err();
        assert!(err.to_string().contains("interactive terminal"), "{err}");
    }

    #[test]
    fn urlencode_escapes_colon_and_slash() {
        assert_eq!(
            urlencode("http://127.0.0.1:5000/callback"),
            "http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"
        );
    }
}
