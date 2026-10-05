// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Codex continuation pages.
//!
//! Codex can continue a long session in a new rollout file (`rollout-…-<session>_<page>.jsonl`). Its
//! `session_meta` reuses the parent session id and adds `history_base`
//! (`thread_id`, `end_ordinal_exclusive`, `end_byte_offset`) naming where in the parent's history the
//! page begins. A page does not replay parent records, but its positional counters (turn index, file
//! block index, snapshot and link ordinals) restart at zero, so without a scope its identities collide
//! with the parent's different turns. [`continuation_scope`] gives every positional identity on a page
//! a prefix derived from `history_base`, which is stable across re-parse and distinct per page.
//!
//! Token counts are the other trap: the page's `token_count` cumulative continues from the parent's
//! cumulative at the fork, so diffing its first snapshot from zero would charge the whole parent total
//! to the page's first turn. [`is_continuation_meta`] lets turn segmentation take that first snapshot's
//! own `last_token_usage` instead.

use serde_json::Value;

fn history_base(record: &Value) -> Option<&Value> {
    if record.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    record
        .get("payload")?
        .get("history_base")
        .filter(|base| base.is_object())
}

/// True when `record` is a `session_meta` that opens a continuation page.
pub fn is_continuation_meta(record: &Value) -> bool {
    history_base(record).is_some()
}

/// The identity scope of a continuation page (`history:<parent ordinal>`), or `None` for a session's
/// first file. Falls back to the parent byte offset when a build omits the ordinal.
pub fn continuation_scope(records: &[Value]) -> Option<String> {
    let base = records.iter().find_map(history_base)?;
    if let Some(ordinal) = base.get("end_ordinal_exclusive").and_then(Value::as_i64) {
        return Some(format!("history:{ordinal}"));
    }
    base.get("end_byte_offset")
        .and_then(Value::as_i64)
        .map(|offset| format!("history-bytes:{offset}"))
}

/// A positional identity (`turn:N`, matching the ingest Worker's fallback shape) scoped to the page.
pub(crate) fn scoped_turn_id(scope: Option<&str>, index: i64) -> Option<String> {
    scope.map(|scope| format!("{scope}:turn:{index}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(history_base: Value) -> Value {
        json!({ "type": "session_meta", "payload": { "id": "s", "history_base": history_base } })
    }

    #[test]
    fn a_first_file_has_no_scope() {
        let records = [json!({ "type": "session_meta", "payload": { "id": "s" } })];
        assert!(!is_continuation_meta(&records[0]));
        assert_eq!(continuation_scope(&records), None);
    }

    #[test]
    fn a_page_is_scoped_by_its_parent_ordinal_then_byte_offset() {
        let by_ordinal = [meta(
            json!({ "thread_id": "s", "end_ordinal_exclusive": 628, "end_byte_offset": 9 }),
        )];
        assert!(is_continuation_meta(&by_ordinal[0]));
        assert_eq!(
            continuation_scope(&by_ordinal).as_deref(),
            Some("history:628")
        );
        let by_offset = [meta(json!({ "thread_id": "s", "end_byte_offset": 9 }))];
        assert_eq!(
            continuation_scope(&by_offset).as_deref(),
            Some("history-bytes:9")
        );
        assert_eq!(
            scoped_turn_id(Some("history:628"), 3).as_deref(),
            Some("history:628:turn:3")
        );
    }
}
