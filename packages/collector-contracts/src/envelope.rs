//! Batch + envelope + Raw Session Bundle. Mirrors `AgentIngestBatch`, `AgentIngestFacts`,
//! `RawSessionBundle*`, and `AgentIngestEnvelope` in `packages/types/src/agent-ingest.ts`.

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
    pub raw_upload_requested: bool,
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
pub struct RawSessionBundleManifest {
    pub source: AgentSource,
    pub vendor_session_id: String,
    pub parser_version: String,
    pub part_ids: Vec<String>,
    pub content_hash: String,
    pub byte_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawSessionBundle {
    pub manifest: RawSessionBundleManifest,
    /// base64-encoded gzip JSONL container.
    pub gzip_base64: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentIngestEnvelope {
    pub batch: AgentIngestBatch,
    pub facts: AgentIngestFacts,
    /// Present only when raw upload is opted in (deferred). Omitted on the wire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_session_bundles: Option<Vec<RawSessionBundle>>,
}
