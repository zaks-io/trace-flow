use super::*;
use std::sync::Mutex;
use std::time::Instant;

fn admission_closed(delay: &str) -> String {
    raw_response(503, "Service Unavailable", r#"{"error":"enqueue_failed"}"#).replacen(
        "content-type:",
        &format!("retry-after: {delay}\r\ncontent-type:"),
        1,
    )
}

#[tokio::test]
async fn waits_for_admission_then_retries_the_same_batch() {
    let received = Arc::new(Mutex::new(Vec::new()));
    let (base_url, server) = spawn_server({
        let received = Arc::clone(&received);
        move |raw| {
            let position = find_body_start(&raw).unwrap();
            let mut requests = received.lock().unwrap();
            requests.push((Instant::now(), strip_chunked(&raw[position..])));
            if requests.len() == 1 {
                admission_closed("1")
            } else {
                raw_response(202, "Accepted", r#"{"sessions":1,"skipped_conflict":0}"#)
            }
        }
    })
    .await;

    let result = test_client(base_url, 1)
        .ingest(&minimal_envelope(), None)
        .await
        .unwrap();
    assert_eq!(result.sessions, 1);
    let requests = received.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].0.duration_since(requests[0].0) >= Duration::from_secs(1));
    assert_eq!(requests[0].1, requests[1].1);
    server.abort();
}

#[tokio::test]
async fn admission_retries_are_bounded_and_preserve_enqueue_error() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (base_url, server) = spawn_server({
        let calls = Arc::clone(&calls);
        move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            admission_closed("1")
        }
    })
    .await;

    let result = test_client(base_url, 1)
        .ingest(&minimal_envelope(), None)
        .await;
    assert!(matches!(result, Err(IngestError::EnqueueFailed)));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}

#[tokio::test]
async fn cancelling_an_admission_delay_stops_before_the_next_request() {
    let calls = Arc::new(AtomicUsize::new(0));
    let responded = Arc::new(tokio::sync::Notify::new());
    let (base_url, server) = spawn_server({
        let calls = Arc::clone(&calls);
        let responded = Arc::clone(&responded);
        move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            responded.notify_one();
            admission_closed("60")
        }
    })
    .await;
    let cancellation = CancellationToken::new();
    let request = tokio::spawn({
        let cancellation = cancellation.clone();
        async move {
            test_client(base_url, 3)
                .ingest(&minimal_envelope(), Some(&cancellation))
                .await
        }
    });
    responded.notified().await;
    tokio::time::sleep(Duration::from_millis(25)).await;
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), request)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(&result, Err(IngestError::Transport(_))));
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn invalid_or_unbounded_delays_do_not_change_enqueue_failure_behavior() {
    for delay in [
        "",
        "invalid",
        "0",
        "-1",
        "+60",
        "301",
        "18446744073709551616",
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let (base_url, server) = spawn_server({
            let calls = Arc::clone(&calls);
            move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                admission_closed(delay)
            }
        })
        .await;
        let result = test_client(base_url, 3)
            .ingest(&minimal_envelope(), None)
            .await;
        assert!(
            matches!(result, Err(IngestError::EnqueueFailed)),
            "delay: {delay}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "delay: {delay}");
        server.abort();
    }
}

#[test]
fn admission_delay_accepts_the_server_contract_and_lease_bound() {
    assert_eq!(admission_retry_delay("60"), Some(Duration::from_secs(60)));
    assert_eq!(admission_retry_delay("300"), Some(Duration::from_secs(300)));
}
