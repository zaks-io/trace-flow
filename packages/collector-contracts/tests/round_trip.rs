//! Contract round-trip tests. These bind the Rust mirror to the shared JSON fixtures, so a serde
//! rename here (or a TS rename, caught by the matching test in `packages/types`) fails loudly.

use std::fs;
use std::path::PathBuf;

use collector_contracts::{sample_envelope, AgentIngestEnvelope};
use serde_json::Value;

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn read_json(rel: &str) -> Value {
    let raw = fs::read_to_string(repo_path(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {rel}: {e}"))
}

#[test]
fn fixture_is_field_equal_to_sample() {
    let fixture = read_json("fixtures/agent-envelope.sample.json");
    let serialized: Value = serde_json::to_value(sample_envelope()).expect("serialize sample");
    assert_eq!(
        fixture, serialized,
        "fixtures/agent-envelope.sample.json drifted from sample_envelope(); \
         regenerate with `cargo run -p collector-contracts --example dump_sample`"
    );
}

#[test]
fn fixture_deserializes_and_round_trips_without_field_loss() {
    let fixture = read_json("fixtures/agent-envelope.sample.json");
    let envelope: AgentIngestEnvelope =
        serde_json::from_value(fixture.clone()).expect("fixture deserializes into the contract");
    let reserialized: Value = serde_json::to_value(&envelope).expect("re-serialize");
    assert_eq!(
        fixture, reserialized,
        "a field was lost or renamed on the Rust round-trip"
    );
    assert_eq!(envelope, sample_envelope());
}

#[test]
fn serialized_envelopes_cannot_carry_legacy_raw_slots() {
    let json = serde_json::to_string(&sample_envelope()).expect("serialize sample");
    assert!(
        !json.contains("raw_upload_requested"),
        "fact envelopes must not request raw upload"
    );
    assert!(
        !json.contains("raw_session_bundles"),
        "fact envelopes must not carry raw transcript slots"
    );
}

#[test]
fn legacy_raw_fields_are_dropped_without_being_copied() {
    let mut legacy = serde_json::to_value(sample_envelope()).expect("serialize sample");
    legacy["batch"]["raw_upload_requested"] = serde_json::json!(true);
    legacy["raw_session_bundles"] = serde_json::json!([{
        "manifest": {
            "source": "claude",
            "vendor_session_id": "legacy-raw",
            "parser_version": "0.1.0",
            "part_ids": ["main"],
            "content_hash": "sha256:deadbeef",
            "byte_count": 12
        },
        "gzip_base64": "legacy-raw-transcript-bytes"
    }]);

    let envelope: AgentIngestEnvelope =
        serde_json::from_value(legacy).expect("legacy extra fields deserialize by ignoring them");
    let reserialized = serde_json::to_string(&envelope).expect("re-serialize");
    assert!(!reserialized.contains("raw_upload_requested"));
    assert!(!reserialized.contains("raw_session_bundles"));
    assert!(!reserialized.contains("legacy-raw-transcript-bytes"));
}

#[test]
fn redaction_canary_corpus_parses() {
    // The shared corpus 3a (this crate's parser) and 2b (the TS server re-redact) both assert
    // against. Here we only prove it is present and well-formed with planted secrets to drop.
    let corpus = read_json("fixtures/redaction-canary.json");
    let cases = corpus
        .get("cases")
        .and_then(Value::as_array)
        .expect("redaction-canary.json has a `cases` array");
    assert!(
        !cases.is_empty(),
        "redaction canary corpus must carry cases"
    );
    for case in cases {
        assert!(case.get("name").and_then(Value::as_str).is_some());
        assert!(case.get("category").and_then(Value::as_str).is_some());
        assert!(case.get("input").and_then(Value::as_str).is_some());
        assert!(case.get("expect").and_then(Value::as_str).is_some());
    }
}
