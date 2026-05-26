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
