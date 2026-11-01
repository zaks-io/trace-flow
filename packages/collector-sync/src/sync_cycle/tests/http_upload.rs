// SPDX-License-Identifier: Apache-2.0

use super::*;
use collector_api_client::CollectorApiClientConfig;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

#[tokio::test]
async fn real_http_client_resumes_a_partially_accepted_session() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        // The first cycle accepts two messages, then closes admission. The second accepts the five
        // remaining messages, each accompanied by the original attribution message.
        for status in [202, 503, 202, 202, 202, 202, 202] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(line, "POST /v1/ingest HTTP/1.1\r\n");
            let mut length = None;
            let mut gzip = false;
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap();
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(value.trim().parse::<usize>().unwrap());
                }
                if name.eq_ignore_ascii_case("content-encoding") {
                    gzip = value.trim() == "gzip";
                }
            }
            assert!(gzip);
            let mut body = vec![0; length.expect("request has a content length")];
            reader.read_exact(&mut body).unwrap();
            drop(reader);
            let body = if status == 202 {
                r#"{"sessions":1,"skipped_conflict":0}"#
            } else {
                r#"{"error":"enqueue_failed"}"#
            };
            write!(stream,
                "HTTP/1.1 {status} response\r\nContent-Type: application/json\r\nRetry-After: 60\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).unwrap();
        }
    });

    let mut config = CollectorApiClientConfig::new(format!("http://{address}"), "test-credential");
    config.retry.max_retries = 0;
    config.timeout = Duration::from_secs(5);
    let client = CollectorApiClient::new(config).unwrap();
    let store = CursorStore::open_in_memory("org").unwrap();
    let unit = multi_message_unit("/http.jsonl", 7, &"m".repeat(1_000));
    let original = session_facts(AgentSource::Claude, &unit.records, &unit.ctx);
    let mut sizing = original.clone();
    sizing.messages.truncate(2);
    let tuning = SyncTuning {
        max_batch_bytes: serialized_facts_bytes(&sizing) + 128,
        ..serial_tuning()
    };
    let mut mint = counter();

    let (first, _) = run_sync_cycle_tuned(
        &client,
        &store,
        &mut syncing_orchestrator(),
        &meta(),
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    assert_eq!(first.advanced, 0);
    assert_eq!(first.failed, 1);
    assert!(first.throttled);
    assert_eq!(first.retry_after, Some(Duration::from_secs(60)));
    assert!(store
        .get(AgentSource::Claude, "/http.jsonl")
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .filter_unsent_facts(AgentSource::Claude, original.clone())
            .unwrap()
            .0
            .messages,
        original.messages[2..]
    );

    let (second, _) = run_sync_cycle_tuned(
        &client,
        &store,
        &mut syncing_orchestrator(),
        &meta(),
        std::slice::from_ref(&unit),
        &mut mint,
        None,
        tuning,
    )
    .await
    .unwrap();
    assert_eq!(second.advanced, 1);
    assert_eq!(second.failed, 0);
    assert!(!second.throttled);
    assert!(!second.aborted_early);
    assert!(store
        .get(AgentSource::Claude, "/http.jsonl")
        .unwrap()
        .is_some());
    assert!(store
        .filter_unsent_facts(AgentSource::Claude, original)
        .unwrap()
        .0
        .messages
        .is_empty());
    server.join().unwrap();
}
