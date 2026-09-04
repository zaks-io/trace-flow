// SPDX-License-Identifier: MIT
// Original Trace Flow code: otto-sync assembled its upload payload inline against otto's own wire
// types (engine.rs, ~/src/otto); the `AgentIngestEnvelope` contract is Trace Flow's own. Trace Flow
// owns the contract, IDs, pricing, redaction, and storage around this code.

//! Wrap one session's assembled facts into the POST [`AgentIngestEnvelope`].
//!
//! [`BatchMeta`] is the part of the batch header that is constant across a sync cycle — the client
//! identity. The `collector_batch_id` is *not* in it: the drive loop (next 3b leaf) mints a fresh
//! id per POST and passes it to [`build_envelope`], so this stays a pure function with nothing to
//! generate.

use collector_contracts::{AgentIngestBatch, AgentIngestEnvelope, AgentIngestFacts, AgentSource};

/// The batch-header fields fixed for a sync cycle. Cloned into every envelope the cycle POSTs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchMeta {
    pub source: AgentSource,
    pub desktop_version: String,
    pub parser_version: String,
}

/// Build the POST envelope for one session's `facts` under `meta`, stamped with `collector_batch_id`.
pub fn build_envelope(
    meta: &BatchMeta,
    collector_batch_id: impl Into<String>,
    facts: AgentIngestFacts,
) -> AgentIngestEnvelope {
    AgentIngestEnvelope {
        batch: AgentIngestBatch {
            source: meta.source,
            collector_batch_id: collector_batch_id.into(),
            desktop_version: meta.desktop_version.clone(),
            parser_version: meta.parser_version.clone(),
        },
        facts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use collector_contracts::sample_envelope;

    fn meta() -> BatchMeta {
        BatchMeta {
            source: AgentSource::Claude,
            desktop_version: "1.2.3".to_string(),
            parser_version: "0.4.0".to_string(),
        }
    }

    #[test]
    fn build_envelope_stamps_the_batch_and_passes_facts_through() {
        let facts = sample_envelope().facts;
        let env = build_envelope(&meta(), "batch-abc", facts.clone());
        assert_eq!(env.batch.source, AgentSource::Claude);
        assert_eq!(env.batch.collector_batch_id, "batch-abc");
        assert_eq!(env.batch.desktop_version, "1.2.3");
        assert_eq!(env.batch.parser_version, "0.4.0");
        assert_eq!(env.facts, facts);
    }

    #[test]
    fn serialized_envelopes_cannot_carry_legacy_raw_slots() {
        let env = build_envelope(&meta(), "b", sample_envelope().facts);
        let json = serde_json::to_string(&env).unwrap();
        assert!(!json.contains("raw_upload_requested"));
        assert!(!json.contains("raw_session_bundles"));
    }
}
