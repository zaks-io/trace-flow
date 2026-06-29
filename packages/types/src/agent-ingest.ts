/**
 * Wire contract for agent Collector ingest (see
 * `docs/adr/0012-agent-conversation-analytics.md` → "Transport" and "Data model").
 *
 * Two boundaries live here:
 *  1. `AgentIngestEnvelope` — what the Collector POSTs to the ingest Worker. It carries
 *     source-visible vendor IDs, timestamps, tokens, model labels, redaction counters, and the
 *     normalized git remote string. It NEVER carries trusted tenancy (`OrgId`/`UserId`), cost, or
 *     final Tinybird primary keys; the Worker stamps those.
 *  2. `AgentIngestQueueMessage` — what the Worker enqueues for the consumer. It adds the assembled
 *     `*_pk` surrogates, `repo_fingerprint`, and tenancy/audit identity.
 *
 * The Rust crate `packages/collector-contracts` mirrors the envelope side with serde renames that
 * match this JSON exactly; `fixtures/agent-envelope.sample.json` is the shared contract fixture both
 * sides assert against, so a rename on either side fails its own round-trip test.
 *
 * Wire conventions:
 *  - All field names are `snake_case` so the TS and Rust shapes are byte-identical on the wire.
 *  - Timestamps are epoch **milliseconds** (UTC). DateTime64(3) at rest; no nanosecond source.
 *  - `| null` marks genuinely-absent vendor data on the wire. The single-Nullable-column rule
 *    (`cost_usd` only) is a Tinybird-storage rule the consumer enforces — wire facts use `null`
 *    where the source has no value, and the consumer maps that to `0` + coverage columns at rest.
 */

export type AgentSource = 'claude' | 'codex' | 'cursor';

/** Token coverage for the row's source data (ADR "Data model" → coverage columns). */
export type TokenCoverage = 'full' | 'partial' | 'missing';

/** Cache-token coverage for the row's source data. */
export type CacheCoverage = 'full' | 'missing';

/** Outcome of a Tool Event, mapped from `extracted_success` (None → `unknown`). */
export type AgentEventStatus = 'success' | 'failure' | 'unknown';

export type AgentToolErrorCategory =
  | 'unknown'
  | 'missing_file'
  | 'read_directory'
  | 'edit_before_read'
  | 'stale_file_before_edit'
  | 'external_schema_validation'
  | 'runtime_env_mismatch'
  | 'tool_input_validation'
  | 'human_or_policy_rejection'
  | 'wrong_tool_name'
  | 'oversized_read'
  | 'other';

export type AgentToolErrorCoverage = 'not_applicable' | 'classified' | 'unknown';

export type AgentNavigationKind =
  | 'none'
  | 'search'
  | 'file_read'
  | 'directory_list'
  | 'directory_change';

export type AgentNavigationHintCoverage = 'not_applicable' | 'structured' | 'unknown';

/** How a fact's `repo_fingerprint` was resolved (remote-backed vs path-fallback Provisional Repo). */
export type RepoSource = 'remote' | 'path';

/** Conversation-turn role. The Worker derives `StartedAt` from `user`/`assistant` turns only. */
export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'other';

/** File-touch operation. `outside_repo` paths use `operation` unchanged with a coarse path. */
export type AgentFileOperation =
  | 'read'
  | 'write'
  | 'edit'
  | 'create'
  | 'delete'
  | 'rename'
  | 'other';

/** Conversation-visible capability observation kind (Codex strongest; ADR "Capability Snapshots"). */
export type AgentCapabilityKind = 'base_instructions' | 'dynamic_tools' | 'mcp_servers' | 'other';

/** Where a hosted-review link was observed in the transcript. */
export type PullRequestLinkEvidence = 'assistant_text' | 'tool_output' | 'transcript_record';

/** Confidence in a passively-extracted hosted-review link. */
export type PullRequestLinkConfidence = 'high' | 'medium' | 'low';

export type ReviewUnitAttributionMethod = 'direct_link' | 'branch_retro' | 'manual';

export type ReviewUnitAttributionConfidence = 'high' | 'medium' | 'low';

export type ReviewUnitAttributionStatus = 'attributed' | 'ambiguous' | 'rejected';

/** Batch-level metadata. One `source` per batch; a batch may span multiple sessions. */
export interface AgentIngestBatch {
  source: AgentSource;
  collector_batch_id: string;
  desktop_version: string;
  parser_version: string;
  raw_upload_requested: boolean;
}

/**
 * One Agent Message (model-call turn). Session-grain attribution (`normalized_git_remote`,
 * `repo_path_fallback`, `git_branch`, `git_head_sha`, `vendor_started_at`) rides on the message
 * spine: it is consistent across a session's messages, and the Worker reads it once per
 * `session_pk` to hash `repo_fingerprint` and derive `StartedAt`/`VendorStartedAt`.
 */
export interface AgentMessageFact {
  vendor_session_id: string;
  /** Claude/Cursor carry one; Codex does not (Worker falls back to positional `turn_index`). */
  vendor_message_id: string | null;
  /** Positional turn index; the Codex `message_pk` fallback component and stable ordering key. */
  turn_index: number;
  role: AgentMessageRole;
  event_at: number;
  /** Raw vendor model label; the consumer normalizes before catalog lookup. `''` if unknown. */
  model: string;
  /** Uncached input tokens (maps to pricing `uncachedInputTokens`). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  reasoning_tokens: number;
  token_coverage: TokenCoverage;
  cache_coverage: CacheCoverage;
  /** 0 for top-level; > 0 for subagent transcript turns linked to the parent `session_pk`. */
  agent_depth: number;
  is_subagent_spawn: boolean;
  is_sidechain: boolean;
  /** Claude subagent agent id, joinable to the parent tool result. `''` if none. */
  agent_id: string;
  /** Normalized git remote string the Worker hashes into `repo_fingerprint`. `''` if unresolved. */
  normalized_git_remote: string;
  /** Normalized path used for the `repo_source = path` fallback when no remote resolves. `''` none. */
  repo_path_fallback: string;
  git_branch: string;
  git_head_sha: string;
  /** Source-declared session start (Codex `session_meta`); `null` when the source omits it. */
  vendor_started_at: number | null;
  /** Count of fields redaction dropped/masked on this fact. */
  dropped_sensitive: number;
}

/**
 * One Tool Event — the tool-use and tool-result blocks (same `tool_use_id`) folded into one row by
 * the Collector, so the failure-rate denominator counts each invocation once.
 */
export interface AgentToolEventFact {
  vendor_session_id: string;
  vendor_message_id: string | null;
  /** Tool-use block id; `null` falls back to (`vendor_message_id`, `source_block_index`). */
  tool_use_id: string | null;
  source_block_index: number;
  event_at: number;
  tool_name: string;
  command_family: string;
  command_program: string;
  command_subcommand: string;
  status: AgentEventStatus;
  error_category: AgentToolErrorCategory;
  error_category_coverage: AgentToolErrorCoverage;
  exit_code: number | null;
  duration_ms: number | null;
  is_navigation: boolean;
  navigation_kind: AgentNavigationKind;
  navigation_hint_coverage: AgentNavigationHintCoverage;
  /** Redacted bounded path/directory/glob hint when the command structure is understood. */
  navigation_path_hint: string;
  /** Redacted bounded search pattern/range hint when the command structure is understood. */
  navigation_pattern_hint: string;
  /** Target files, repo-relative; `outside_repo` for files outside the primary Repo. */
  repo_relative_paths: string[];
  extracted_provider: string;
  extracted_repo: string;
  extracted_pr_number: number | null;
  /** Capped redacted excerpt (≤ 1 KB). `''` when none or dropped. */
  command_excerpt: string;
  /** Capped redacted excerpt (≤ 4 KB). `''` when none or dropped. */
  error_excerpt: string;
  /** Tool-result subagent usage (fallback priced only when no matching sidechain message exists). */
  extracted_subagent_agent_id: string;
  extracted_subagent_model: string;
  extracted_subagent_input_tokens: number;
  extracted_subagent_output_tokens: number;
  extracted_subagent_cache_read_tokens: number;
  extracted_subagent_cache_creation_tokens: number;
  dropped_sensitive: number;
}

/** One file touch, repo-relative only (privacy + worktree-stability guard). */
export interface AgentFileEventFact {
  vendor_session_id: string;
  vendor_message_id: string | null;
  source_block_index: number;
  /** Repo-relative path, or the coarse `outside_repo` category. Never absolute, never `$HOME`. */
  normalized_repo_path: string;
  operation: AgentFileOperation;
  event_at: number;
  dropped_sensitive: number;
}

/** One conversation-visible capability observation. Counts/hashes/sizes only — never raw bodies. */
export interface AgentCapabilitySnapshotFact {
  vendor_session_id: string;
  /** Source snapshot id when present; otherwise identity uses `stable_turn_index`. */
  source_snapshot_id: string | null;
  stable_turn_index: number;
  event_at: number;
  capability_kind: AgentCapabilityKind;
  item_count: number;
  total_size_bytes: number;
  total_tokens_estimate: number;
  /** Stable hash of the observed surface; never the raw schema/config text. */
  content_hash: string;
  redacted_label: string;
  dropped_sensitive: number;
}

/** One canonical hosted-review link observation (passive transcript evidence). */
export interface AgentPullRequestLinkFact {
  vendor_session_id: string;
  source_event_id: string | null;
  stable_turn_index: number;
  event_at: number;
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  confidence: PullRequestLinkConfidence;
  evidence: PullRequestLinkEvidence;
  dropped_sensitive: number;
}

/** The five typed fact arrays the Collector emits. */
export interface AgentIngestFacts {
  messages: AgentMessageFact[];
  tool_events: AgentToolEventFact[];
  file_events: AgentFileEventFact[];
  capability_snapshots: AgentCapabilitySnapshotFact[];
  pull_request_links: AgentPullRequestLinkFact[];
}

/**
 * Manifest for a Raw Session Bundle (deferred; plumbed so raw replay is additive later — see
 * `docs/adr/r2-storage-caps.md`). Counts/hashes only at this layer.
 */
export interface RawSessionBundleManifest {
  source: AgentSource;
  vendor_session_id: string;
  parser_version: string;
  part_ids: string[];
  content_hash: string;
  byte_count: number;
}

/** A gzip-compressed Raw Session Bundle, sent only when raw upload is opted in (deferred). */
export interface RawSessionBundle {
  manifest: RawSessionBundleManifest;
  /** base64-encoded gzip JSONL container. */
  gzip_base64: string;
}

/** What the Collector POSTs to the ingest Worker. No tenancy, no cost, no final `*_pk`. */
export interface AgentIngestEnvelope {
  batch: AgentIngestBatch;
  facts: AgentIngestFacts;
  /** Present only when `batch.raw_upload_requested` and raw upload is enabled (deferred). */
  raw_session_bundles?: RawSessionBundle[];
}

/** Tenancy + internal audit identity the Worker stamps from the Collector Credential record. */
export interface AgentTenancy {
  org_id: string;
  user_id: string;
  collector_id: string;
  /** Not a dedupe key; may change on reconnect/rotation/Stronghold recovery. */
  collector_credential_id: string;
}

export interface AgentMessageQueueFact extends AgentMessageFact {
  session_pk: string;
  message_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
}

export interface AgentToolEventQueueFact extends AgentToolEventFact {
  session_pk: string;
  tool_use_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
}

export interface AgentFileEventQueueFact extends AgentFileEventFact {
  session_pk: string;
  file_event_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
}

export interface AgentCapabilitySnapshotQueueFact extends AgentCapabilitySnapshotFact {
  session_pk: string;
  capability_snapshot_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
}

export interface AgentPullRequestLinkQueueFact extends AgentPullRequestLinkFact {
  session_pk: string;
  pull_request_link_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
}

export interface AgentReviewUnitAttributionQueueFact {
  session_pk: string;
  review_unit_attribution_pk: string;
  repo_fingerprint: string;
  repo_source: RepoSource;
  vendor_session_id: string;
  decided_at: number;
  review_unit_key: string;
  review_url: string;
  review_host: string;
  review_owner: string;
  review_repo: string;
  review_number: number;
  git_branch: string;
  attribution_method: ReviewUnitAttributionMethod;
  confidence: ReviewUnitAttributionConfidence;
  status: ReviewUnitAttributionStatus;
  ambiguity_reason: string;
  evidence_pull_request_link_pk: string;
  rule_version: string;
}

export interface AgentIngestQueueFacts {
  messages: AgentMessageQueueFact[];
  tool_events: AgentToolEventQueueFact[];
  file_events: AgentFileEventQueueFact[];
  capability_snapshots: AgentCapabilitySnapshotQueueFact[];
  pull_request_links: AgentPullRequestLinkQueueFact[];
  /** Optional so pre-rollout queue messages without this edge category still consume cleanly. */
  review_unit_attributions?: AgentReviewUnitAttributionQueueFact[];
}

/**
 * What the ingest Worker enqueues for the agent consumer. Carries assembled `*_pk` surrogates and
 * tenancy; the consumer prices each message and writes one batched insert per base datasource.
 */
export interface AgentIngestQueueMessage {
  type: 'agent';
  source: AgentSource;
  parser_version: string;
  desktop_version: string;
  collector_batch_id: string;
  tenancy: AgentTenancy;
  facts: AgentIngestQueueFacts;
  /** Worker enqueue time (epoch ms); the consumer uses it as the `IngestedAt` version column. */
  enqueued_at: number;
}
