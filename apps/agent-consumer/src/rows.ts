import type {
  AgentCapabilitySnapshotQueueFact,
  AgentFileEventQueueFact,
  AgentIngestQueueMessage,
  AgentMessageQueueFact,
  AgentPullRequestLinkQueueFact,
  AgentReviewUnitAttributionQueueFact,
  AgentTenancy,
  AgentToolEventQueueFact,
} from '@trace-flow/types';

/**
 * Maps the snake_case / epoch-ms wire facts onto the agent_* datasource columns. The at-rest
 * identity columns are CamelCase (`OrgId`, `EventAt`, …) and the timestamp columns are
 * `DateTime64(3)`; the consumer emits the ClickHouse datetime literal the schema's JSONPaths read
 * (the Phase-1 fixtures use the same `"YYYY-MM-DD HH:MM:SS.mmm"` form). Wire `null`s collapse to the
 * non-null at-rest sentinels (`0`, `''`, epoch) — `cost_usd` is the only Nullable column, set by the
 * caller from pricing.
 */

/** epoch ms → the UTC `DateTime64(3)` literal `"YYYY-MM-DD HH:MM:SS.mmm"`. */
export function toClickhouseDateTime64(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', '');
}

/** Per-message context shared by every row the message contributes. */
interface BatchContext {
  tenancy: AgentTenancy;
  source: AgentIngestQueueMessage['source'];
  parserVersion: string;
  /** `enqueued_at` as the `DateTime64(3)` literal; the `IngestedAt` version column for every row. */
  ingestedAt: string;
}

export function batchContext(message: AgentIngestQueueMessage): BatchContext {
  return {
    tenancy: message.tenancy,
    source: message.source,
    parserVersion: message.parser_version,
    ingestedAt: toClickhouseDateTime64(message.enqueued_at),
  };
}

interface CommonFact {
  session_pk: string;
  repo_fingerprint: string;
  repo_source: string;
  vendor_session_id: string;
  event_at: number;
}

function commonFields(ctx: BatchContext, fact: CommonFact) {
  return {
    OrgId: ctx.tenancy.org_id,
    UserId: ctx.tenancy.user_id,
    CollectorId: ctx.tenancy.collector_id,
    CollectorCredentialId: ctx.tenancy.collector_credential_id,
    session_pk: fact.session_pk,
    repo_fingerprint: fact.repo_fingerprint,
    repo_source: fact.repo_source,
    source: ctx.source,
    parser_version: ctx.parserVersion,
    EventAt: toClickhouseDateTime64(fact.event_at),
    IngestedAt: ctx.ingestedAt,
    vendor_session_id: fact.vendor_session_id,
  };
}

export function messageRow(ctx: BatchContext, fact: AgentMessageQueueFact, costUsd: number | null) {
  return {
    ...commonFields(ctx, fact),
    message_pk: fact.message_pk,
    VendorStartedAt: toClickhouseDateTime64(fact.vendor_started_at ?? 0),
    vendor_message_id: fact.vendor_message_id ?? '',
    turn_index: fact.turn_index,
    role: fact.role,
    model: fact.model,
    input_tokens: fact.input_tokens,
    output_tokens: fact.output_tokens,
    cache_read_tokens: fact.cache_read_tokens,
    cache_creation_tokens: fact.cache_creation_tokens,
    cache_creation_5m_tokens: fact.cache_creation_5m_tokens,
    cache_creation_1h_tokens: fact.cache_creation_1h_tokens,
    reasoning_tokens: fact.reasoning_tokens,
    token_coverage: fact.token_coverage,
    cache_coverage: fact.cache_coverage,
    agent_depth: fact.agent_depth,
    is_subagent_spawn: fact.is_subagent_spawn ? 1 : 0,
    is_sidechain: fact.is_sidechain ? 1 : 0,
    agent_id: fact.agent_id,
    normalized_git_remote: fact.normalized_git_remote,
    repo_path_fallback: fact.repo_path_fallback,
    git_branch: fact.git_branch,
    git_head_sha: fact.git_head_sha,
    dropped_sensitive: fact.dropped_sensitive,
    cost_usd: costUsd,
  };
}

export function toolEventRow(ctx: BatchContext, fact: AgentToolEventQueueFact) {
  return {
    ...commonFields(ctx, fact),
    tool_use_pk: fact.tool_use_pk,
    vendor_message_id: fact.vendor_message_id ?? '',
    tool_use_id: fact.tool_use_id ?? '',
    source_block_index: fact.source_block_index,
    tool_name: fact.tool_name,
    command_family: fact.command_family,
    command_program: fact.command_program,
    command_subcommand: fact.command_subcommand,
    status: fact.status,
    exit_code: fact.exit_code ?? 0,
    duration_ms: fact.duration_ms ?? 0,
    repo_relative_paths: fact.repo_relative_paths,
    extracted_provider: fact.extracted_provider,
    extracted_repo: fact.extracted_repo,
    extracted_pr_number: fact.extracted_pr_number ?? 0,
    command_excerpt: fact.command_excerpt,
    error_excerpt: fact.error_excerpt,
    extracted_subagent_agent_id: fact.extracted_subagent_agent_id,
    extracted_subagent_model: fact.extracted_subagent_model,
    extracted_subagent_input_tokens: fact.extracted_subagent_input_tokens,
    extracted_subagent_output_tokens: fact.extracted_subagent_output_tokens,
    extracted_subagent_cache_read_tokens: fact.extracted_subagent_cache_read_tokens,
    extracted_subagent_cache_creation_tokens: fact.extracted_subagent_cache_creation_tokens,
    dropped_sensitive: fact.dropped_sensitive,
  };
}

export function fileEventRow(ctx: BatchContext, fact: AgentFileEventQueueFact) {
  return {
    ...commonFields(ctx, fact),
    file_event_pk: fact.file_event_pk,
    vendor_message_id: fact.vendor_message_id ?? '',
    source_block_index: fact.source_block_index,
    normalized_repo_path: fact.normalized_repo_path,
    operation: fact.operation,
    dropped_sensitive: fact.dropped_sensitive,
  };
}

export function capabilitySnapshotRow(ctx: BatchContext, fact: AgentCapabilitySnapshotQueueFact) {
  return {
    ...commonFields(ctx, fact),
    capability_snapshot_pk: fact.capability_snapshot_pk,
    source_snapshot_id: fact.source_snapshot_id ?? '',
    stable_turn_index: fact.stable_turn_index,
    capability_kind: fact.capability_kind,
    item_count: fact.item_count,
    total_size_bytes: fact.total_size_bytes,
    total_tokens_estimate: fact.total_tokens_estimate,
    content_hash: fact.content_hash,
    redacted_label: fact.redacted_label,
    dropped_sensitive: fact.dropped_sensitive,
  };
}

export function pullRequestLinkRow(ctx: BatchContext, fact: AgentPullRequestLinkQueueFact) {
  return {
    ...commonFields(ctx, fact),
    pull_request_link_pk: fact.pull_request_link_pk,
    source_event_id: fact.source_event_id ?? '',
    stable_turn_index: fact.stable_turn_index,
    host: fact.host,
    owner: fact.owner,
    repo: fact.repo,
    number: fact.number,
    url: fact.url,
    confidence: fact.confidence,
    evidence: fact.evidence,
    dropped_sensitive: fact.dropped_sensitive,
  };
}

export function reviewUnitAttributionRow(
  ctx: BatchContext,
  fact: AgentReviewUnitAttributionQueueFact,
) {
  return {
    OrgId: ctx.tenancy.org_id,
    UserId: ctx.tenancy.user_id,
    CollectorId: ctx.tenancy.collector_id,
    CollectorCredentialId: ctx.tenancy.collector_credential_id,
    session_pk: fact.session_pk,
    review_unit_attribution_pk: fact.review_unit_attribution_pk,
    repo_fingerprint: fact.repo_fingerprint,
    repo_source: fact.repo_source,
    source: ctx.source,
    parser_version: ctx.parserVersion,
    DecidedAt: toClickhouseDateTime64(fact.decided_at),
    IngestedAt: ctx.ingestedAt,
    vendor_session_id: fact.vendor_session_id,
    review_unit_key: fact.review_unit_key,
    review_url: fact.review_url,
    review_host: fact.review_host,
    review_owner: fact.review_owner,
    review_repo: fact.review_repo,
    review_number: fact.review_number,
    git_branch: fact.git_branch,
    attribution_method: fact.attribution_method,
    confidence: fact.confidence,
    status: fact.status,
    ambiguity_reason: fact.ambiguity_reason,
    evidence_pull_request_link_pk: fact.evidence_pull_request_link_pk,
    rule_version: fact.rule_version,
  };
}
