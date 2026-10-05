// SPDX-License-Identifier: Apache-2.0
// Original Trace Flow code. Trace Flow owns the contract, IDs, pricing, redaction, and storage around
// this code.

//! Lazy assembly of the multi-session envelopes one sync cycle POSTs.
//!
//! [`BatchPreparer`] assembles and merges sessions only as each batch is pulled, so peak memory tracks
//! the in-flight batches, not the whole sync window, and a pre-cancelled run does no assembly. Each
//! unit's facts are assembled once and merged into the open batch; the batch closes when adding the
//! next unit would exceed `max_sessions_per_batch` or `max_batch_bytes`. A lone oversized session is
//! split into sequential envelopes that share one local commit boundary, so a partial upload never
//! advances its cursor. One `collector_batch_id` is minted per POST.
//!
//! A unit that assembles to zero facts still carries a cursor that must advance (an empty session is
//! "seen, nothing to send"), so it rides along; the Worker treats an all-empty envelope as an accepted
//! no-op. Quarantined units are skipped. Retry groups requeued after a `400` are prepared before new
//! units, so isolating a bad unit finishes inside the same cycle.
//!
//! A unit carrying a changed copy of a fact already in the open batch starts a new batch (see
//! [`EnvelopeIdentities`]). The batch that carries the deferred unit is marked
//! [`PreparedBatch::after_inflight`], so the changed copy cannot be overtaken by the copy it replaces.

use std::collections::{HashSet, VecDeque};

use collector_contracts::{AgentIngestEnvelope, AgentIngestFacts};
use collector_parser::assemble::session_facts;

use crate::cursor::{CursorStore, CursorStoreError, FactCursor};
use crate::envelope::{build_envelope, BatchMeta};
use crate::fact_batches::{serialized_facts_bytes, split_facts, SessionFactContext};
use crate::fact_dedupe::EnvelopeIdentities;
use crate::sync_cycle::{SyncTuning, SyncUnit};

/// One prepared batch: the envelopes to POST and, by index into the cycle's units, whose cursors to
/// commit iff every POST is accepted.
pub(crate) struct PreparedBatch {
    pub(crate) envelopes: Vec<AgentIngestEnvelope>,
    pub(crate) units: Vec<usize>,
    pub(crate) fact_cursors: Vec<FactCursor>,
    /// Carries a changed copy of a fact an earlier batch sent, so it must not start until every batch in
    /// flight, and every retry split from one, finishes. Arriving last makes it the Worker's latest
    /// revision.
    pub(crate) after_inflight: bool,
}

struct AssembledUnit {
    facts: AgentIngestFacts,
    fact_cursors: Vec<FactCursor>,
    bytes: usize,
}

/// The open batch being filled. Identities are tracked across every unit merged into it.
#[derive(Default)]
struct OpenBatch {
    facts: AgentIngestFacts,
    units: Vec<usize>,
    fact_cursors: Vec<FactCursor>,
    bytes: usize,
    identities: EnvelopeIdentities,
}

impl PreparedBatch {
    /// A unit belongs to one batch at a time, so this also identifies the batch.
    pub(crate) fn oldest_unit(&self) -> usize {
        *self
            .units
            .iter()
            .min()
            .expect("a prepared batch always carries a unit")
    }
}

pub(crate) struct BatchPreparer<'a, M: FnMut() -> String> {
    meta: &'a BatchMeta,
    units: &'a [SyncUnit],
    next_unit: usize,
    mint_batch_id: M,
    max_sessions: usize,
    max_bytes: usize,
    retries: VecDeque<Vec<usize>>,
    /// Units deferred for a conflict. The batch that carries one waits for in-flight batches.
    ordered_units: HashSet<usize>,
    pub(crate) skipped_quarantined: u32,
}

impl<'a, M: FnMut() -> String> BatchPreparer<'a, M> {
    pub(crate) fn new(
        meta: &'a BatchMeta,
        units: &'a [SyncUnit],
        mint_batch_id: M,
        tuning: SyncTuning,
    ) -> Self {
        Self {
            meta,
            units,
            next_unit: 0,
            mint_batch_id,
            max_sessions: tuning.max_sessions_per_batch.max(1),
            max_bytes: tuning.max_batch_bytes.max(1),
            retries: VecDeque::new(),
            ordered_units: HashSet::new(),
            skipped_quarantined: 0,
        }
    }

    /// Queue `units` to be re-sent together as one batch before any new unit is prepared.
    pub(crate) fn requeue(&mut self, units: Vec<usize>) {
        self.retries.push_back(units);
    }

    pub(crate) fn has_retries(&self) -> bool {
        !self.retries.is_empty()
    }

    pub(crate) fn next_batch(
        &mut self,
        store: &CursorStore,
    ) -> Result<Option<PreparedBatch>, CursorStoreError> {
        if let Some(group) = self.retries.pop_front() {
            return self.batch_of(store, group).map(Some);
        }

        let mut open = OpenBatch::default();
        while let Some(unit) = self.units.get(self.next_unit) {
            if store.is_quarantined(self.meta.source, &unit.next_cursor)? {
                self.skipped_quarantined += 1;
                self.next_unit += 1;
                continue;
            }
            let assembled = self.assemble(store, unit)?;

            // If adding this unit would overflow the open (non-empty) batch, or would send a changed
            // copy of a fact the batch already carries, close and return the batch now without
            // consuming `unit`, so it starts the next batch.
            let conflicts = open.identities.conflicts(&assembled.fact_cursors);
            let must_close = !open.units.is_empty()
                && (open.units.len() >= self.max_sessions
                    || open.bytes + assembled.bytes > self.max_bytes
                    || conflicts);
            if must_close {
                if conflicts {
                    self.ordered_units.insert(self.next_unit);
                }
                return Ok(Some(self.close(open)));
            }

            let index = self.next_unit;
            self.next_unit += 1;
            if open.units.is_empty() && assembled.bytes > self.max_bytes {
                return self.split(index, assembled).map(Some);
            }
            self.merge(&mut open, index, assembled)?;
        }

        if open.units.is_empty() {
            return Ok(None);
        }
        Ok(Some(self.close(open)))
    }

    /// A retry group as one batch. A group is a subset of a batch that already fit the budget, so only
    /// a lone oversized unit needs splitting. Send state may have moved since the group was first
    /// prepared, so a unit can now conflict with the group.
    fn batch_of(
        &mut self,
        store: &CursorStore,
        group: Vec<usize>,
    ) -> Result<PreparedBatch, CursorStoreError> {
        if let [index] = group[..] {
            let assembled = self.assemble(store, &self.units[index])?;
            if assembled.bytes > self.max_bytes {
                return self.split(index, assembled);
            }
        }
        let mut open = OpenBatch::default();
        let mut group = group.into_iter();
        while let Some(index) = group.next() {
            let assembled = self.assemble(store, &self.units[index])?;
            if open.identities.conflicts(&assembled.fact_cursors) {
                // Like a new batch, a retry closes at its first conflict. The rest stays in order behind
                // the deferred unit, so no later unit's newer copy overtakes one of its older copies.
                self.ordered_units.insert(index);
                self.requeue(std::iter::once(index).chain(group).collect());
                break;
            }
            self.merge(&mut open, index, assembled)?;
        }
        Ok(self.close(open))
    }

    fn assemble(
        &self,
        store: &CursorStore,
        unit: &SyncUnit,
    ) -> Result<AssembledUnit, CursorStoreError> {
        let facts = session_facts(self.meta.source, &unit.records, &unit.ctx);
        let context = SessionFactContext::capture(&facts);
        let (mut facts, fact_cursors) = store.filter_unsent_facts(self.meta.source, facts)?;
        context.retain_for(&mut facts);
        let bytes = serialized_facts_bytes(&facts);
        Ok(AssembledUnit {
            facts,
            fact_cursors,
            bytes,
        })
    }

    fn merge(
        &self,
        open: &mut OpenBatch,
        index: usize,
        mut assembled: AssembledUnit,
    ) -> Result<(), CursorStoreError> {
        open.identities.dedupe(
            self.meta.source,
            &mut assembled.facts,
            &mut assembled.fact_cursors,
        )?;
        merge_facts(&mut open.facts, assembled.facts);
        open.units.push(index);
        open.fact_cursors.extend(assembled.fact_cursors);
        open.bytes += assembled.bytes;
        Ok(())
    }

    fn split(
        &mut self,
        index: usize,
        mut assembled: AssembledUnit,
    ) -> Result<PreparedBatch, CursorStoreError> {
        EnvelopeIdentities::default().dedupe(
            self.meta.source,
            &mut assembled.facts,
            &mut assembled.fact_cursors,
        )?;
        let envelopes = split_facts(assembled.facts, self.max_bytes)
            .into_iter()
            .map(|chunk| build_envelope(self.meta, (self.mint_batch_id)(), chunk))
            .collect();
        Ok(PreparedBatch {
            envelopes,
            units: vec![index],
            fact_cursors: assembled.fact_cursors,
            after_inflight: self.ordered_units.remove(&index),
        })
    }

    fn close(&mut self, open: OpenBatch) -> PreparedBatch {
        let ordered = open
            .units
            .iter()
            .filter(|unit| self.ordered_units.remove(unit))
            .count();
        PreparedBatch {
            envelopes: vec![build_envelope(
                self.meta,
                (self.mint_batch_id)(),
                open.facts,
            )],
            units: open.units,
            fact_cursors: open.fact_cursors,
            after_inflight: ordered > 0,
        }
    }
}

/// Concatenate one session's facts onto the batch accumulator. Identity duplicates were already
/// dropped by [`EnvelopeIdentities`], so a per-array append is the whole merge.
fn merge_facts(into: &mut AgentIngestFacts, mut from: AgentIngestFacts) {
    into.messages.append(&mut from.messages);
    into.tool_events.append(&mut from.tool_events);
    into.file_events.append(&mut from.file_events);
    into.capability_snapshots
        .append(&mut from.capability_snapshots);
    into.pull_request_links.append(&mut from.pull_request_links);
}
