// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Codex rollouts collapsed on compression.
//!
//! Codex rewrites some idle subagent and guardian-review rollouts when it compresses them. The
//! rewritten file still holds the thread's own records, but every record carries one timestamp and
//! `session_meta.subagent_history_start_ordinal` equals the record count. Token totals survive, but
//! per-turn times and some turn boundaries do not, so the file yields fewer, renumbered turns than the
//! live rollout did. Ingest replaces facts by identity and never retracts one a resend omits, so
//! sending this form over facts from the live rollout overwrites some turns, keeps the rest, and
//! inflates the session.
//!
//! Sync skips this form. A session whose live rollout was never synced loses its facts here; that is
//! the side that cannot corrupt facts already ingested.

use serde_json::Value;

/// True when `records` are a Codex rollout collapsed on compression (see the module docs).
pub(crate) fn is_collapsed_archive(records: &[Value]) -> bool {
    let start = records
        .iter()
        .find(|record| record.get("type").and_then(Value::as_str) == Some("session_meta"))
        .and_then(|meta| meta.pointer("/payload/subagent_history_start_ordinal"))
        .and_then(Value::as_u64);
    let Some(start) = start else {
        return false;
    };
    let first = records.first().and_then(|record| record.get("timestamp"));
    first.is_some()
        && start >= records.len() as u64
        && records
            .iter()
            .all(|record| record.get("timestamp") == first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rollout(start: Option<u64>, stamps: &[&str]) -> Vec<Value> {
        let mut payload = json!({ "id": "child" });
        if let Some(start) = start {
            payload["subagent_history_start_ordinal"] = json!(start);
        }
        let mut records = vec![json!({
            "type": "session_meta", "timestamp": stamps[0], "payload": payload
        })];
        records.extend(stamps[1..].iter().map(|stamp| {
            json!({ "type": "event_msg", "timestamp": stamp, "payload": { "type": "token_count" } })
        }));
        records
    }

    const AT: &str = "2026-08-24T00:28:57.681Z";
    const LATER: &str = "2026-08-24T01:06:35.408Z";

    #[test]
    fn a_rollout_marked_to_its_end_at_one_instant_is_collapsed() {
        assert!(is_collapsed_archive(&rollout(Some(3), &[AT, AT, AT])));
        assert!(is_collapsed_archive(&rollout(Some(9), &[AT, AT, AT])));
    }

    #[test]
    fn live_shapes_are_not_collapsed() {
        // Records continue past the marked ordinal.
        assert!(!is_collapsed_archive(&rollout(Some(2), &[AT, AT, AT])));
        // Marked to its end, but the records kept their real times.
        assert!(!is_collapsed_archive(&rollout(Some(3), &[AT, AT, LATER])));
        // No ordinal at all.
        assert!(!is_collapsed_archive(&rollout(None, &[AT, AT, AT])));
        assert!(!is_collapsed_archive(&[]));
    }
}
