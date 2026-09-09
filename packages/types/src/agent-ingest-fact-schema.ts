import {
  AGENT_INGEST_LIMITS,
  AGENT_SOURCES,
  CACHE_COVERAGES,
  CAPABILITY_KINDS,
  enumField,
  EVENT_STATUSES,
  FILE_OPERATIONS,
  LINK_CONFIDENCES,
  LINK_EVIDENCE,
  MESSAGE_ROLES,
  NAVIGATION_HINT_COVERAGES,
  NAVIGATION_KINDS,
  numberField,
  nullableStringField,
  REPO_SOURCES,
  REVIEW_ATTRIBUTION_CONFIDENCES,
  REVIEW_ATTRIBUTION_METHODS,
  REVIEW_ATTRIBUTION_STATUSES,
  stringArrayField,
  stringField,
  timestampField,
  TOKEN_COVERAGES,
  TOOL_ERROR_CATEGORIES,
  TOOL_ERROR_COVERAGES,
  uint32Field,
  uint8Field,
  type FieldSpec,
  booleanField,
} from './agent-ingest-schema';

const id = stringField(AGENT_INGEST_LIMITS.maxIdentifierBytes);
const path = stringField(AGENT_INGEST_LIMITS.maxPathBytes);
const url = stringField(AGENT_INGEST_LIMITS.maxUrlBytes);
const uint32 = uint32Field();
const nullableUint32 = uint32Field({ nullable: true });
const timestamp = timestampField();
const nullableTimestamp = timestampField(true);
const repoPaths = stringArrayField(
  AGENT_INGEST_LIMITS.maxRepoRelativePaths,
  AGENT_INGEST_LIMITS.maxRepoRelativePathBytes,
  AGENT_INGEST_LIMITS.maxRepoRelativePathsBytes,
);

export const BATCH_FIELDS: Record<string, FieldSpec> = {
  source: enumField(AGENT_SOURCES),
  collector_batch_id: id,
  desktop_version: stringField(128),
  parser_version: stringField(128),
  // Accepted and ignored for collectors released before the raw-upload removal.
  raw_upload_requested: booleanField(true),
};

export const MESSAGE_FIELDS: Record<string, FieldSpec> = {
  vendor_session_id: id,
  vendor_message_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  turn_index: uint32,
  role: enumField(MESSAGE_ROLES),
  event_at: timestamp,
  model: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  input_tokens: uint32,
  output_tokens: uint32,
  cache_read_tokens: uint32,
  cache_creation_tokens: uint32,
  cache_creation_5m_tokens: uint32,
  cache_creation_1h_tokens: uint32,
  reasoning_tokens: uint32,
  token_coverage: enumField(TOKEN_COVERAGES),
  cache_coverage: enumField(CACHE_COVERAGES),
  agent_depth: uint8Field(),
  is_subagent_spawn: booleanField(),
  is_sidechain: booleanField(),
  agent_id: id,
  normalized_git_remote: url,
  repo_path_fallback: path,
  git_branch: path,
  git_head_sha: id,
  vendor_started_at: nullableTimestamp,
  dropped_sensitive: uint32,
};

export const TOOL_FIELDS: Record<string, FieldSpec> = {
  vendor_session_id: id,
  vendor_message_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  tool_use_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  source_block_index: uint32,
  event_at: timestamp,
  tool_name: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  command_family: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  command_program: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  command_subcommand: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  status: enumField(EVENT_STATUSES),
  error_category: enumField(TOOL_ERROR_CATEGORIES, true),
  error_category_coverage: enumField(TOOL_ERROR_COVERAGES, true),
  exit_code: numberField(-0x8000_0000, 0x7fff_ffff, { nullable: true }),
  duration_ms: nullableUint32,
  is_navigation: booleanField(true),
  navigation_kind: enumField(NAVIGATION_KINDS, true),
  navigation_hint_coverage: enumField(NAVIGATION_HINT_COVERAGES, true),
  navigation_path_hint: stringField(AGENT_INGEST_LIMITS.maxNavigationHintBytes, true),
  navigation_pattern_hint: stringField(AGENT_INGEST_LIMITS.maxNavigationHintBytes, true),
  repo_relative_paths: repoPaths,
  extracted_provider: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  extracted_repo: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  extracted_pr_number: nullableUint32,
  command_excerpt: stringField(AGENT_INGEST_LIMITS.maxCommandExcerptBytes),
  error_excerpt: stringField(AGENT_INGEST_LIMITS.maxErrorExcerptBytes),
  extracted_subagent_agent_id: id,
  extracted_subagent_model: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  extracted_subagent_input_tokens: uint32,
  extracted_subagent_output_tokens: uint32,
  extracted_subagent_cache_read_tokens: uint32,
  extracted_subagent_cache_creation_tokens: uint32,
  dropped_sensitive: uint32,
};

export const FILE_FIELDS: Record<string, FieldSpec> = {
  vendor_session_id: id,
  vendor_message_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  source_block_index: uint32,
  normalized_repo_path: path,
  operation: enumField(FILE_OPERATIONS),
  event_at: timestamp,
  dropped_sensitive: uint32,
};

export const CAPABILITY_FIELDS: Record<string, FieldSpec> = {
  vendor_session_id: id,
  source_snapshot_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  stable_turn_index: uint32,
  event_at: timestamp,
  capability_kind: enumField(CAPABILITY_KINDS),
  item_count: uint32,
  total_size_bytes: numberField(0, Number.MAX_SAFE_INTEGER),
  total_tokens_estimate: uint32,
  content_hash: stringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  redacted_label: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  dropped_sensitive: uint32,
};

export const PULL_REQUEST_FIELDS: Record<string, FieldSpec> = {
  vendor_session_id: id,
  source_event_id: nullableStringField(AGENT_INGEST_LIMITS.maxIdentifierBytes),
  stable_turn_index: uint32,
  event_at: timestamp,
  host: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  owner: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  repo: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
  number: uint32,
  url,
  confidence: enumField(LINK_CONFIDENCES),
  evidence: enumField(LINK_EVIDENCE),
  dropped_sensitive: uint32,
};

export const TENANCY_FIELDS: Record<string, FieldSpec> = {
  org_id: id,
  user_id: id,
  collector_id: id,
  collector_credential_id: id,
};

const queueIdentityFields: Record<string, FieldSpec> = {
  session_pk: id,
  repo_fingerprint: id,
  repo_source: enumField(REPO_SOURCES),
};

export const QUEUE_MESSAGE_FIELDS: Record<string, FieldSpec> = {
  type: enumField(['agent']),
  source: enumField(AGENT_SOURCES),
  parser_version: stringField(128),
  desktop_version: stringField(128),
  collector_batch_id: id,
  enqueued_at: timestamp,
};

export const QUEUE_FACT_SCHEMAS: Record<string, Record<string, FieldSpec>> = {
  messages: { ...MESSAGE_FIELDS, message_pk: id, ...queueIdentityFields },
  tool_events: { ...TOOL_FIELDS, tool_use_pk: id, ...queueIdentityFields },
  file_events: { ...FILE_FIELDS, file_event_pk: id, ...queueIdentityFields },
  capability_snapshots: {
    ...CAPABILITY_FIELDS,
    capability_snapshot_pk: id,
    ...queueIdentityFields,
  },
  pull_request_links: {
    ...PULL_REQUEST_FIELDS,
    pull_request_link_pk: id,
    ...queueIdentityFields,
  },
  review_unit_attributions: {
    ...queueIdentityFields,
    review_unit_attribution_pk: id,
    vendor_session_id: id,
    decided_at: timestamp,
    review_unit_key: id,
    review_url: url,
    review_host: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
    review_owner: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
    review_repo: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
    review_number: uint32,
    git_branch: path,
    attribution_method: enumField(REVIEW_ATTRIBUTION_METHODS),
    confidence: enumField(REVIEW_ATTRIBUTION_CONFIDENCES),
    status: enumField(REVIEW_ATTRIBUTION_STATUSES),
    ambiguity_reason: stringField(AGENT_INGEST_LIMITS.maxFactStringBytes),
    evidence_pull_request_link_pk: id,
    rule_version: id,
  },
};

export const TRACE_CONTEXT_FIELDS: Record<string, FieldSpec> = {
  'sentry-trace': stringField(AGENT_INGEST_LIMITS.maxTraceHeaderBytes, true),
  baggage: stringField(AGENT_INGEST_LIMITS.maxTraceHeaderBytes, true),
};

export const LEGACY_RAW_MANIFEST_FIELDS: Record<string, FieldSpec> = {
  source: enumField(AGENT_SOURCES),
  vendor_session_id: id,
  parser_version: stringField(128),
  part_ids: stringArrayField(
    AGENT_INGEST_LIMITS.maxLegacyRawPartIds,
    AGENT_INGEST_LIMITS.maxLegacyRawPartIdBytes,
    AGENT_INGEST_LIMITS.maxLegacyRawPartIdsBytes,
  ),
  content_hash: id,
  byte_count: numberField(0, Number.MAX_SAFE_INTEGER),
};
