// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Pre-send dedupe of facts that share an identity inside one ingest envelope.
//!
//! The ingest Worker hashes the same identity parts into each `*_pk` (`apps/agent-ingest/src/ids.ts`)
//! and rejects a whole envelope with a `400` when two rows share a pk but differ beyond position. The
//! keys here are the ones [`crate::cursor`] already mirrors for local send state, so a duplicate is
//! dropped before it can poison a batch. The first occurrence wins, matching the parser's
//! first-position rule.
//!
//! Send state must describe what the Worker actually received. A pending cursor is committed only when
//! its content hash matches the copy placed in the envelope; a unit whose pending copy differs from an
//! already placed one [`conflicts`](EnvelopeIdentities::conflicts) with the envelope and belongs in a
//! later one, so its update is sent rather than silently replaced by the earlier copy.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};

use collector_contracts::{AgentIngestFacts, AgentSource};

use crate::cursor::{
    capability_snapshot_cursor, file_event_cursor, message_cursor, pull_request_link_cursor,
    tool_event_cursor, CursorStoreError, FactCursor,
};

type IdentityKey = (&'static str, String);

/// The identities already placed in one envelope, shared across every unit merged into it.
#[derive(Default)]
pub(crate) struct EnvelopeIdentities {
    /// The content hash of the copy placed in the envelope, per identity.
    placed: HashMap<IdentityKey, String>,
    committed: HashSet<IdentityKey>,
}

impl EnvelopeIdentities {
    /// True when a pending cursor would record content other than the copy already placed for its
    /// identity. Context copies carry no cursor, so they never conflict.
    pub(crate) fn conflicts(&self, fact_cursors: &[FactCursor]) -> bool {
        fact_cursors.iter().any(|cursor| {
            self.placed
                .get(&(cursor.category, cursor.fact_identity.clone()))
                .is_some_and(|placed| *placed != cursor.content_hash)
        })
    }

    /// Drop every fact whose identity is already in the envelope, and every pending cursor except the
    /// one recording the placed copy.
    pub(crate) fn dedupe(
        &mut self,
        source: AgentSource,
        facts: &mut AgentIngestFacts,
        fact_cursors: &mut Vec<FactCursor>,
    ) -> Result<(), CursorStoreError> {
        self.keep_first(source, &mut facts.messages, message_cursor)?;
        self.keep_first(source, &mut facts.tool_events, tool_event_cursor)?;
        self.keep_first(source, &mut facts.file_events, file_event_cursor)?;
        self.keep_first(
            source,
            &mut facts.capability_snapshots,
            capability_snapshot_cursor,
        )?;
        self.keep_first(
            source,
            &mut facts.pull_request_links,
            pull_request_link_cursor,
        )?;
        fact_cursors.retain(|cursor| {
            let key = (cursor.category, cursor.fact_identity.clone());
            self.placed.get(&key) == Some(&cursor.content_hash) && self.committed.insert(key)
        });
        Ok(())
    }

    fn keep_first<T>(
        &mut self,
        source: AgentSource,
        rows: &mut Vec<T>,
        cursor: fn(AgentSource, &T) -> Result<FactCursor, CursorStoreError>,
    ) -> Result<(), CursorStoreError> {
        let mut kept = Vec::with_capacity(rows.len());
        for row in rows.drain(..) {
            let identity = cursor(source, &row)?;
            let key = (identity.category, identity.fact_identity);
            if let Entry::Vacant(slot) = self.placed.entry(key) {
                slot.insert(identity.content_hash);
                kept.push(row);
            }
        }
        *rows = kept;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_contracts::sample_envelope;

    fn cursors(facts: &AgentIngestFacts) -> Vec<FactCursor> {
        vec![message_cursor(AgentSource::Claude, &facts.messages[0]).unwrap()]
    }

    #[test]
    fn keeps_the_first_fact_and_cursor_per_identity_across_units() {
        let base = sample_envelope().facts;
        let mut first = base.clone();
        let mut repeat = base.clone();
        let mut first_cursors = cursors(&first);
        let mut repeat_cursors = cursors(&repeat);

        let mut seen = EnvelopeIdentities::default();
        seen.dedupe(AgentSource::Claude, &mut first, &mut first_cursors)
            .unwrap();
        assert!(!seen.conflicts(&repeat_cursors));
        seen.dedupe(AgentSource::Claude, &mut repeat, &mut repeat_cursors)
            .unwrap();

        assert_eq!(first, base);
        assert!(repeat.messages.is_empty());
        assert!(repeat.tool_events.is_empty());
        assert_eq!(first_cursors.len(), 1);
        assert!(repeat_cursors.is_empty());
    }

    #[test]
    fn a_changed_copy_conflicts_and_a_dropped_one_never_commits() {
        let base = sample_envelope().facts;
        let mut context = base.clone();
        let mut changed = base.clone();
        changed.messages[0].turn_index += 40;
        let changed_cursors = cursors(&changed);

        // The first unit sends its copy as context, with no pending cursor of its own.
        let mut seen = EnvelopeIdentities::default();
        seen.dedupe(AgentSource::Claude, &mut context, &mut Vec::new())
            .unwrap();
        assert!(seen.conflicts(&changed_cursors));

        // Forced through anyway, the dropped copy's cursor is not committed as sent.
        let mut dropped_cursors = changed_cursors.clone();
        seen.dedupe(AgentSource::Claude, &mut changed, &mut dropped_cursors)
            .unwrap();
        assert!(changed.messages.is_empty());
        assert!(dropped_cursors.is_empty());
    }
}
