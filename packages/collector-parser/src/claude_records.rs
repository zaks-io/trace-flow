// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Claude Code record hygiene applied before any emitter runs.
//!
//! Newer Claude Code builds re-append the conversation tail after a `system/compact_boundary` record,
//! copying each record with its original `uuid` (and therefore its `message.id` and `tool_use_id`s).
//! The copy is not new activity: emitting it again produced facts that differed from the originals
//! only by `turn_index`/`source_block_index`, and file events whose positional identity made the copy
//! a second, double-counted row. [`drop_reappended_records`] keeps the first record per `uuid`, so
//! every emitter sees each record once at its original position.

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::Value;

fn record_uuid(record: &Value) -> Option<&str> {
    record.get("uuid").and_then(Value::as_str)
}

/// The records with every repeat of an already-seen `uuid` removed, keeping the first occurrence.
/// Borrows when nothing repeats, which is the common case, so a clean transcript is never copied.
/// Records without a `uuid` are always kept.
pub fn drop_reappended_records(records: &[Value]) -> Cow<'_, [Value]> {
    let mut seen = HashSet::new();
    if records
        .iter()
        .filter_map(record_uuid)
        .all(|uuid| seen.insert(uuid))
    {
        return Cow::Borrowed(records);
    }
    let mut seen = HashSet::new();
    Cow::Owned(
        records
            .iter()
            .filter(|record| record_uuid(record).is_none_or(|uuid| seen.insert(uuid)))
            .cloned()
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_transcript_without_repeats_is_borrowed_unchanged() {
        let records = [json!({ "uuid": "a" }), json!({ "uuid": "b" }), json!({})];
        assert!(matches!(
            drop_reappended_records(&records),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn keeps_the_first_record_per_uuid_and_every_uuidless_record() {
        let records = [
            json!({ "uuid": "a", "n": 1 }),
            json!({ "type": "system", "subtype": "compact_boundary" }),
            json!({ "uuid": "a", "n": 2 }),
            json!({ "uuid": "b" }),
            json!({ "type": "summary" }),
        ];
        let kept = drop_reappended_records(&records);
        assert_eq!(
            kept.as_ref(),
            [
                json!({ "uuid": "a", "n": 1 }),
                json!({ "type": "system", "subtype": "compact_boundary" }),
                json!({ "uuid": "b" }),
                json!({ "type": "summary" }),
            ]
        );
    }
}
