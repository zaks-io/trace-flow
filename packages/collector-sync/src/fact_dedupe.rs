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

use std::collections::HashSet;

use collector_contracts::{AgentIngestFacts, AgentSource};

use crate::cursor::{
    capability_snapshot_cursor, file_event_cursor, message_cursor, pull_request_link_cursor,
    tool_event_cursor, CursorStoreError, FactCursor,
};

/// The identities already placed in one envelope, shared across every unit merged into it.
#[derive(Default)]
pub(crate) struct EnvelopeIdentities {
    facts: HashSet<(&'static str, String)>,
    cursors: HashSet<(&'static str, String)>,
}

impl EnvelopeIdentities {
    /// Drop every fact (and its pending send-state cursor) whose identity is already in the envelope.
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
        // Commit send state only for the copy that was actually sent.
        fact_cursors.retain(|cursor| {
            self.cursors
                .insert((cursor.category, cursor.fact_identity.clone()))
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
            if self
                .facts
                .insert((identity.category, identity.fact_identity))
            {
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

    #[test]
    fn keeps_the_first_fact_and_cursor_per_identity_across_units() {
        let base = sample_envelope().facts;
        let mut first = base.clone();
        let mut repeat = base.clone();
        repeat.messages[0].turn_index += 40;
        repeat.tool_events[0].source_block_index += 5;
        let mut first_cursors =
            vec![message_cursor(AgentSource::Claude, &first.messages[0]).unwrap()];
        let mut repeat_cursors =
            vec![message_cursor(AgentSource::Claude, &repeat.messages[0]).unwrap()];

        let mut seen = EnvelopeIdentities::default();
        seen.dedupe(AgentSource::Claude, &mut first, &mut first_cursors)
            .unwrap();
        seen.dedupe(AgentSource::Claude, &mut repeat, &mut repeat_cursors)
            .unwrap();

        assert_eq!(first, base);
        assert!(repeat.messages.is_empty());
        assert!(repeat.tool_events.is_empty());
        assert_eq!(first_cursors.len(), 1);
        assert!(repeat_cursors.is_empty());
    }
}
