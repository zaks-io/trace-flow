// SPDX-License-Identifier: Apache-2.0
// Asserts the Collector parser's redaction against the shared canary corpus the TS ingest Worker
// (apps/agent-ingest/src/__tests__/redaction.test.ts) also asserts against, so the primary and
// backstop redaction layers cannot drift on a planted secret.

use std::fs;
use std::path::PathBuf;

use collector_parser::redaction::redact_field;
use serde_json::Value;

fn corpus() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/redaction-canary.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read canary: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse canary: {e}"))
}

#[test]
fn canary_corpus_is_present_and_sized() {
    let corpus = corpus();
    assert_eq!(corpus["version"], Value::from(1));
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 12, "expected at least 12 canary cases");
}

#[test]
fn every_planted_secret_is_dropped_or_masked() {
    let corpus = corpus();
    for case in corpus["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("name");
        let input = case["input"].as_str().expect("input");
        let secret = case["secret"].as_str().expect("secret");
        let expect = case["expect"].as_str().expect("expect");

        let result = redact_field(input);

        assert!(
            !result.value.contains(secret),
            "{name}: planted secret survived in {:?}",
            result.value
        );
        assert!(
            result.dropped >= 1,
            "{name}: expected at least one redaction"
        );

        match expect {
            "drop" => assert_eq!(result.value, "", "{name}: expected a whole-field drop"),
            "mask" => assert!(
                !result.value.is_empty(),
                "{name}: expected a mask to keep surrounding structure"
            ),
            other => panic!("{name}: unknown expect value {other:?}"),
        }
    }
}
