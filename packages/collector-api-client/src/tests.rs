// SPDX-License-Identifier: MIT
// Vendored and refactored from otto-api-client/src/lib.rs (~/src/otto, 2026-05-25).
// Trace Flow owns the contract, IDs, pricing, redaction, and storage around this code.

use super::*;
use collector_contracts::{
    AgentIngestBatch, AgentIngestEnvelope, AgentIngestFacts, AgentSource, RawSessionBundle,
    RawSessionBundleManifest,
};
use flate2::read::GzDecoder;
use std::io::Read as _;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn minimal_envelope() -> AgentIngestEnvelope {
    AgentIngestEnvelope {
        batch: AgentIngestBatch {
            source: AgentSource::Claude,
            collector_batch_id: "batch-001".into(),
            desktop_version: "0.1.0".into(),
            parser_version: "0.1.0".into(),
            raw_upload_requested: false,
        },
        facts: AgentIngestFacts {
            messages: vec![],
            tool_events: vec![],
            file_events: vec![],
            capability_snapshots: vec![],
            pull_request_links: vec![],
        },
        raw_session_bundles: None,
    }
}

fn test_client(base_url: String, max_retries: u32) -> CollectorApiClient {
    CollectorApiClient::with_reqwest_client(
        Client::builder().gzip(true).build().unwrap(),
        CollectorApiClientConfig {
            ingest_url: base_url,
            credential: "test-secret".into(),
            timeout: Duration::from_secs(5),
            retry: RetryConfig {
                max_retries,
                base_backoff: Duration::from_millis(1),
            },
        },
    )
}

/// Spawn a pure-tokio mock HTTP/1.1 server. The handler receives raw request bytes and returns a
/// raw HTTP response string. Mirrors the `spawn_server` pattern from Otto's api-client tests.
async fn spawn_server<F>(handler: F) -> (String, tokio::task::JoinHandle<()>)
where
    F: Fn(Vec<u8>) -> String + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{addr}");
    let handler = Arc::new(handler);
    let handle = tokio::spawn(async move {
        for _ in 0..8usize {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            // Accumulate reads until the whole request (headers + body) has arrived; a single `read`
            // can return a partial buffer and truncate the body a test wants to decode.
            let mut header_buf = Vec::with_capacity(8192);
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                header_buf.extend_from_slice(&chunk[..n]);
                if request_complete(&header_buf) || header_buf.len() > (1 << 20) {
                    break;
                }
            }

            // `strip_chunked()` is defensive: it strips chunk framing if present, and is a no-op for
            // the Content-Length body reqwest actually sends here.
            let response = handler(header_buf);
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();

            // Stop after any terminal status.
            if response.contains("HTTP/1.1 202")
                || response.contains("HTTP/1.1 401")
                || response.contains("HTTP/1.1 413")
                || response.contains("HTTP/1.1 426")
                || response.contains("HTTP/1.1 429")
                || response.contains("HTTP/1.1 400")
                || response.contains("HTTP/1.1 500")
            {
                break;
            }
        }
    });
    (base_url, handle)
}

fn raw_response(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

// --- verify assertion 1: X-Trace-Flow-Collector-Secret header ---

#[tokio::test]
async fn sends_collector_secret_header() {
    let seen_header = Arc::new(std::sync::Mutex::new(String::new()));
    let (base_url, handle) = spawn_server({
        let seen_header = Arc::clone(&seen_header);
        move |raw| {
            let request_str = String::from_utf8_lossy(&raw).to_string();
            for line in request_str.lines() {
                if line
                    .to_lowercase()
                    .starts_with("x-trace-flow-collector-secret:")
                {
                    *seen_header.lock().unwrap() = line.to_string();
                }
            }
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
            )
        }
    })
    .await;

    let client = test_client(base_url, 0);
    let result = client.ingest(&minimal_envelope(), None).await.unwrap();
    assert_eq!(result.sessions, 1);

    let header = seen_header.lock().unwrap().clone();
    assert!(
        header
            .to_lowercase()
            .starts_with("x-trace-flow-collector-secret:"),
        "missing X-Trace-Flow-Collector-Secret header"
    );
    assert!(
        header.contains("test-secret"),
        "expected raw credential in header, got: {header}"
    );
    assert!(
        !header.to_lowercase().contains("bearer"),
        "credential must be sent raw, not as Bearer: {header}"
    );

    handle.abort();
}

// --- verify assertion 2: gzip round-trip ---

#[tokio::test]
async fn sends_gzip_encoded_body() {
    let captured_body = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let saw_content_encoding = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let (base_url, handle) = spawn_server({
        let captured_body = Arc::clone(&captured_body);
        let saw_ce = Arc::clone(&saw_content_encoding);
        move |raw| {
            let request_str = String::from_utf8_lossy(&raw).to_string();
            for line in request_str.lines() {
                if line.to_lowercase().starts_with("content-encoding:") {
                    saw_ce.store(true, Ordering::SeqCst);
                }
            }
            if let Some(pos) = find_body_start(&raw) {
                let raw_body = raw[pos..].to_vec();
                let body_bytes = strip_chunked(&raw_body);
                *captured_body.lock().unwrap() = body_bytes;
            }
            raw_response(
                202,
                "Accepted",
                r#"{"accepted":true,"sessions":0,"skipped_conflict":0}"#,
            )
        }
    })
    .await;

    let envelope = minimal_envelope();
    let client = test_client(base_url, 0);
    client.ingest(&envelope, None).await.unwrap();

    assert!(
        saw_content_encoding.load(Ordering::SeqCst),
        "Content-Encoding header not sent"
    );

    let compressed = captured_body.lock().unwrap().clone();
    let mut gz = GzDecoder::new(&compressed[..]);
    let mut decompressed = String::new();
    gz.read_to_string(&mut decompressed)
        .expect("body is not valid gzip");

    let expected = serde_json::to_string(&envelope).unwrap();
    assert_eq!(
        decompressed, expected,
        "gzip body did not round-trip to the envelope JSON"
    );

    handle.abort();
}

#[tokio::test]
async fn rejects_oversized_envelope_before_network() {
    let mut envelope = minimal_envelope();
    envelope.raw_session_bundles = Some(vec![RawSessionBundle {
        manifest: RawSessionBundleManifest {
            source: AgentSource::Claude,
            vendor_session_id: "session-1".to_string(),
            parser_version: "0.1.0".to_string(),
            part_ids: vec![],
            content_hash: "sha256:1".to_string(),
            byte_count: 0,
        },
        gzip_base64: "x".repeat(MAX_INGEST_BYTES),
    }]);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let connection_count = Arc::new(AtomicUsize::new(0));
    let server = tokio::spawn({
        let connection_count = Arc::clone(&connection_count);
        async move {
            loop {
                let Ok((_stream, _)) = listener.accept().await else {
                    break;
                };
                connection_count.fetch_add(1, Ordering::SeqCst);
            }
        }
    });

    let client = test_client(format!("http://{addr}"), 0);
    let err = client.ingest(&envelope, None).await.unwrap_err();
    assert!(
        matches!(err, IngestError::PayloadTooLarge),
        "expected PayloadTooLarge, got: {err}"
    );
    assert_eq!(
        connection_count.load(Ordering::SeqCst),
        0,
        "oversized payload attempted a network connection"
    );
    server.abort();
}

// --- verify assertion 3a: retry transient failures, then 202 succeeds ---

#[tokio::test]
async fn retries_policy_unavailable_then_succeeds() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let (base_url, handle) = spawn_server({
        let call_count = Arc::clone(&call_count);
        move |_raw| {
            let n = call_count.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                raw_response(
                    503,
                    "Service Unavailable",
                    r#"{"error":"policy_unavailable"}"#,
                )
            } else {
                raw_response(
                    202,
                    "Accepted",
                    r#"{"accepted":true,"sessions":2,"skipped_conflict":0}"#,
                )
            }
        }
    })
    .await;

    let client = test_client(base_url, 3);
    let result = client.ingest(&minimal_envelope(), None).await.unwrap();
    assert_eq!(result.sessions, 2);
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        2,
        "expected exactly 2 requests (1 retry)"
    );

    handle.abort();
}

#[tokio::test]
async fn retries_transport_send_failure_then_succeeds() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{addr}");
    let server = tokio::spawn({
        let call_count = Arc::clone(&call_count);
        async move {
            for _ in 0..2usize {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let n = call_count.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    drop(stream);
                    continue;
                }

                let mut request = Vec::with_capacity(8192);
                let mut chunk = [0u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    if request_complete(&request) {
                        break;
                    }
                }
                stream
                    .write_all(
                        raw_response(
                            202,
                            "Accepted",
                            r#"{"accepted":true,"sessions":1,"skipped_conflict":0}"#,
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.shutdown().await.unwrap();
                break;
            }
        }
    });

    let client = test_client(base_url, 1);
    let result = client.ingest(&minimal_envelope(), None).await.unwrap();
    assert_eq!(result.sessions, 1);
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        2,
        "expected dropped first send to be retried"
    );

    server.abort();
}

// --- verify assertion 3b: 503 enqueue_failed is terminal (no retry) ---

#[tokio::test]
async fn does_not_retry_enqueue_failed() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let (base_url, handle) = spawn_server({
        let call_count = Arc::clone(&call_count);
        move |_raw| {
            call_count.fetch_add(1, Ordering::SeqCst);
            raw_response(503, "Service Unavailable", r#"{"error":"enqueue_failed"}"#)
        }
    })
    .await;

    let client = test_client(base_url, 3);
    let err = client.ingest(&minimal_envelope(), None).await.unwrap_err();
    assert!(
        matches!(err, IngestError::EnqueueFailed),
        "expected EnqueueFailed, got: {err}"
    );
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        1,
        "enqueue_failed must not be retried"
    );

    handle.abort();
}

// --- verify assertion 3b: 426 upgrade_required is terminal ---

#[tokio::test]
async fn does_not_retry_upgrade_required() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let body = r#"{"error":"upgrade_required","detail":"too old","min_desktop_version":"1.2.0","min_parser_version":"0.5.0"}"#;
    let (base_url, handle) = spawn_server({
        let call_count = Arc::clone(&call_count);
        let body = body.to_string();
        move |_raw| {
            call_count.fetch_add(1, Ordering::SeqCst);
            raw_response(426, "Upgrade Required", &body)
        }
    })
    .await;

    let client = test_client(base_url, 3);
    let err = client.ingest(&minimal_envelope(), None).await.unwrap_err();
    match err {
        IngestError::UpgradeRequired(detail) => {
            assert_eq!(detail.detail, "too old");
            assert_eq!(detail.min_desktop_version, "1.2.0");
            assert_eq!(detail.min_parser_version, "0.5.0");
        }
        other => panic!("expected UpgradeRequired, got: {other}"),
    }
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        1,
        "upgrade_required must not be retried"
    );

    handle.abort();
}

// --- verify assertion 3b: 429 rate_limited is terminal ---

#[tokio::test]
async fn does_not_retry_rate_limited() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let (base_url, handle) = spawn_server({
        let call_count = Arc::clone(&call_count);
        move |_raw| {
            call_count.fetch_add(1, Ordering::SeqCst);
            raw_response(429, "Too Many Requests", r#"{"error":"rate_limited"}"#)
        }
    })
    .await;

    let client = test_client(base_url, 3);
    let err = client.ingest(&minimal_envelope(), None).await.unwrap_err();
    assert!(
        matches!(err, IngestError::RateLimited),
        "expected RateLimited, got: {err}"
    );
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        1,
        "rate_limited must not be retried"
    );

    handle.abort();
}

// --- verify assertion 4: a cancelled token aborts an in-flight request ---

#[tokio::test]
async fn cancels_in_flight_request() {
    // Accept the connection but never respond, so the request stays in-flight until cancelled.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{addr}");
    let server = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(stream);
        }
    });

    let client = test_client(base_url, 0);
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let task = tokio::spawn(async move {
        let envelope = minimal_envelope();
        client.ingest(&envelope, Some(&token)).await
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.cancel();

    let result = task.await.unwrap();
    let err = result.expect_err("cancelled request must not succeed");
    assert!(
        matches!(&err, IngestError::Transport(_)),
        "expected Transport error, got: {err}"
    );
    assert!(
        err.to_string().contains("cancelled"),
        "expected cancellation message, got: {err}"
    );

    server.abort();
}

// Locate the start of the HTTP body (bytes after `\r\n\r\n`).
fn find_body_start(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

// A request is fully received once the end-of-headers marker is present and the body is complete.
// reqwest sends our fixed `Vec<u8>` body with `Content-Length`, so completion means the received body
// has reached that length; a chunked body (no Content-Length) ends with the zero-length chunk.
fn request_complete(buf: &[u8]) -> bool {
    let Some(start) = find_body_start(buf) else {
        return false;
    };
    match content_length(buf) {
        Some(len) => buf.len() - start >= len,
        None => buf[start..].ends_with(b"0\r\n\r\n"),
    }
}

// Parse the Content-Length header value from the request head, if present.
fn content_length(buf: &[u8]) -> Option<usize> {
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&buf[..head_end]).ok()?;
    head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

// Strip the chunk-size hex line if a body happens to be chunk-framed; a no-op otherwise.
fn strip_chunked(body: &[u8]) -> Vec<u8> {
    if body.is_empty() {
        return body.to_vec();
    }
    // Chunked format: "<hex-size>\r\n<data>\r\n0\r\n\r\n"
    if let Some(crlf) = body.windows(2).position(|w| w == b"\r\n") {
        let hex_candidate = &body[..crlf];
        if let Ok(s) = std::str::from_utf8(hex_candidate) {
            if s.trim().chars().all(|c| c.is_ascii_hexdigit()) {
                return body[crlf + 2..].to_vec();
            }
        }
    }
    body.to_vec()
}
