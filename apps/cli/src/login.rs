// SPDX-License-Identifier: MIT
// Trace Flow Collector CLI: browser device-flow login.

//! `trace-flow login` — the browser device flow that mints a Collector Credential.
//!
//! The CLI binds a one-shot HTTP listener on a random `127.0.0.1` port, opens the browser to the
//! Convex `/collector/authorize` route with that loopback as the `redirect_uri`, and blocks until the
//! `/collector/callback` redirect lands the minted secret + org metadata back on the listener. The
//! secret then goes straight into the OS keychain ([`crate::keychain`]); only the non-secret
//! connection metadata is written to disk ([`crate::config::Connection`]).
//!
//! The secret travels exactly once, over a loopback redirect the Convex side restricts to
//! `127.0.0.1`. It is never logged, never put on a process arg, never persisted in plaintext.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tiny_http::{Header, Response, Server};

use crate::config::{Connection, Paths};
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
pub fn run(convex_site_url: &str) -> Result<Connection> {
    let server = Server::http("127.0.0.1:0").map_err(|e| anyhow!("bind loopback listener: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("listener has no IP address")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let authorize_url = format!(
        "{}/collector/authorize?redirect_uri={}",
        convex_site_url.trim_end_matches('/'),
        urlencode(&redirect_uri),
    );

    println!("Opening your browser to sign in...");
    println!("If it doesn't open, visit:\n  {authorize_url}\n");
    // A failed auto-open is not fatal — the URL is printed above for manual use.
    let _ = webbrowser::open(&authorize_url);

    let result = wait_for_callback(&server)?;

    let paths = Paths::resolve()?;
    paths.ensure()?;
    keychain::store(&result.org_id, &result.secret)?;
    let conn = Connection {
        org_id: result.org_id,
        collector_id: result.collector_id,
        convex_url: result.convex_url,
        expires_at: result.expires_at,
    };
    paths.save_connection(&conn)?;
    Ok(conn)
}

/// Block on the listener until the callback redirect arrives (or the timeout elapses), parse the
/// minted material out of its query string, and serve the browser a short success page.
fn wait_for_callback(server: &Server) -> Result<LoginResult> {
    let request = server
        .recv_timeout(LOGIN_TIMEOUT)
        .context("wait for browser callback")?
        .ok_or_else(|| anyhow!("login timed out after {}s", LOGIN_TIMEOUT.as_secs()))?;

    // The path arrives as e.g. `/callback?secret=...&org_id=...`; parse against a dummy base.
    let parsed = parse_callback(request.url())?;

    let body = match &parsed {
        Ok(_) => "<h2>Trace Flow CLI connected.</h2><p>You can close this tab and return to your terminal.</p>",
        Err(_) => "<h2>Login failed.</h2><p>Return to your terminal for details.</p>",
    };
    let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .map_err(|_| anyhow!("build content-type header"))?;
    let _ = request.respond(
        Response::from_string(body)
            .with_header(header)
            .with_status_code(if parsed.is_ok() { 200 } else { 400 }),
    );

    parsed.map_err(|e| anyhow!(e))
}

/// Pull the minted fields out of the callback URL's query string. Returns `Ok(Err(msg))` for an
/// error redirect (so the caller can still serve the failure page) and `Err` only for a malformed URL.
fn parse_callback(raw_url: &str) -> Result<std::result::Result<LoginResult, String>> {
    let url =
        reqwest::Url::parse(&format!("http://127.0.0.1{raw_url}")).context("parse callback url")?;
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

    if let Some(err) = params.get("error") {
        return Ok(Err(format!("login rejected: {err}")));
    }

    let get = |k: &str| params.get(k).cloned();
    let (Some(secret), Some(org_id), Some(collector_id), Some(expires_at), Some(convex_url)) = (
        get("secret"),
        get("org_id"),
        get("collector_id"),
        get("expires_at"),
        get("convex_url"),
    ) else {
        return Ok(Err("callback missing required fields".to_string()));
    };

    let expires_at: i64 = expires_at
        .parse()
        .map_err(|_| anyhow!("callback expires_at not an integer"))?;

    Ok(Ok(LoginResult {
        secret,
        org_id,
        collector_id,
        expires_at,
        convex_url,
    }))
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

    #[test]
    fn parse_callback_extracts_minted_fields() {
        let inner = parse_callback(
            "/callback?secret=tfc_abc&org_id=org_1&collector_id=cli-x&expires_at=123&convex_url=https://d.convex.site",
        )
        .unwrap()
        .unwrap();
        assert_eq!(inner.secret, "tfc_abc");
        assert_eq!(inner.org_id, "org_1");
        assert_eq!(inner.collector_id, "cli-x");
        assert_eq!(inner.expires_at, 123);
        assert_eq!(inner.convex_url, "https://d.convex.site");
    }

    #[test]
    fn parse_callback_surfaces_an_error_redirect() {
        let result = parse_callback("/callback?error=access_denied").unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn parse_callback_rejects_missing_fields() {
        let result = parse_callback("/callback?secret=only").unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn urlencode_escapes_colon_and_slash() {
        assert_eq!(
            urlencode("http://127.0.0.1:5000/callback"),
            "http%3A%2F%2F127.0.0.1%3A5000%2Fcallback"
        );
    }
}
