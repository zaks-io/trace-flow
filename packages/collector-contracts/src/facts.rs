//! Typed fact shapes the Collector emits. Mirrors the `Agent*Fact` interfaces in
//! `packages/types/src/agent-ingest.ts`. Timestamps are epoch milliseconds; `Option` marks
//! genuinely-absent vendor data (the consumer maps that to `0` + coverage columns at rest).

use serde::{Deserialize, Serialize};

use crate::enums::{
    AgentCapabilityKind, AgentEventStatus, AgentFileOperation, AgentMessageRole, CacheCoverage,
    PullRequestLinkConfidence, PullRequestLinkEvidence, TokenCoverage,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentMessageFact {
    pub vendor_session_id: String,
    pub vendor_message_id: Option<String>,
    pub turn_index: i64,
    pub role: AgentMessageRole,
    pub event_at: i64,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    pub reasoning_tokens: i64,
    pub token_coverage: TokenCoverage,
    pub cache_coverage: CacheCoverage,
    pub agent_depth: i64,
    pub is_subagent_spawn: bool,
    pub is_sidechain: bool,
    pub agent_id: String,
    pub normalized_git_remote: String,
    pub repo_path_fallback: String,
    pub git_branch: String,
    pub git_head_sha: String,
    pub vendor_started_at: Option<i64>,
    pub dropped_sensitive: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentToolEventFact {
    pub vendor_session_id: String,
    pub vendor_message_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub source_block_index: i64,
    pub event_at: i64,
    pub tool_name: String,
    pub command_family: String,
    pub command_program: String,
    pub command_subcommand: String,
    pub status: AgentEventStatus,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub repo_relative_paths: Vec<String>,
    pub extracted_provider: String,
    pub extracted_repo: String,
    pub extracted_pr_number: Option<i64>,
    pub command_excerpt: String,
    pub error_excerpt: String,
    pub extracted_subagent_agent_id: String,
    pub extracted_subagent_model: String,
    pub extracted_subagent_input_tokens: i64,
    pub extracted_subagent_output_tokens: i64,
    pub extracted_subagent_cache_read_tokens: i64,
    pub extracted_subagent_cache_creation_tokens: i64,
    pub dropped_sensitive: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentFileEventFact {
    pub vendor_session_id: String,
    pub vendor_message_id: Option<String>,
    pub source_block_index: i64,
    pub normalized_repo_path: String,
    pub operation: AgentFileOperation,
    pub event_at: i64,
    pub dropped_sensitive: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentCapabilitySnapshotFact {
    pub vendor_session_id: String,
    pub source_snapshot_id: Option<String>,
    pub stable_turn_index: i64,
    pub event_at: i64,
    pub capability_kind: AgentCapabilityKind,
    pub item_count: i64,
    pub total_size_bytes: i64,
    pub total_tokens_estimate: i64,
    pub content_hash: String,
    pub redacted_label: String,
    pub dropped_sensitive: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPullRequestLinkFact {
    pub vendor_session_id: String,
    pub source_event_id: Option<String>,
    pub stable_turn_index: i64,
    pub event_at: i64,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub confidence: PullRequestLinkConfidence,
    pub evidence: PullRequestLinkEvidence,
    pub dropped_sensitive: i64,
}
