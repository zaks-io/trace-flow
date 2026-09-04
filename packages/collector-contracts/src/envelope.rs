//! Batch + envelope. Mirrors `AgentIngestBatch`, `AgentIngestFacts`, and
//! `AgentIngestEnvelope` in `packages/types/src/agent-ingest.ts`.

use serde::{Deserialize, Serialize};

use crate::enums::AgentSource;
use crate::facts::{
    AgentCapabilitySnapshotFact, AgentFileEventFact, AgentMessageFact, AgentPullRequestLinkFact,
    AgentToolEventFact,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentIngestBatch {
    pub source: AgentSource,
    pub collector_batch_id: String,
    pub desktop_version: String,
    pub parser_version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentIngestFacts {
    pub messages: Vec<AgentMessageFact>,
    pub tool_events: Vec<AgentToolEventFact>,
    pub file_events: Vec<AgentFileEventFact>,
    pub capability_snapshots: Vec<AgentCapabilitySnapshotFact>,
    pub pull_request_links: Vec<AgentPullRequestLinkFact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentIngestEnvelope {
    pub batch: AgentIngestBatch,
    pub facts: AgentIngestFacts,
}
