import type {
  AgentCapabilityKind,
  AgentEventStatus,
  AgentFileOperation,
  AgentMessageRole,
  AgentNavigationHintCoverage,
  AgentNavigationKind,
  AgentSource,
  AgentToolErrorCategory,
  AgentToolErrorCoverage,
  CacheCoverage,
  PullRequestLinkConfidence,
  PullRequestLinkEvidence,
  RepoSource,
  ReviewUnitAttributionConfidence,
  ReviewUnitAttributionMethod,
  ReviewUnitAttributionStatus,
  TokenCoverage,
} from './agent-ingest';

export const AGENT_INGEST_LIMITS = {
  maxFactsPerCategory: 10_000,
  maxFactsTotal: 25_000,
  maxFactStringBytes: 2_048,
  maxIdentifierBytes: 512,
  maxPathBytes: 1_024,
  // Queue admission rejects any single fact above 124 KB. Keep this contract bound above that
  // transport ceiling so the Worker can return its specific 413 queue-fit response.
  maxUrlBytes: 256 * 1_024,
  maxCommandExcerptBytes: 1_024,
  maxErrorExcerptBytes: 4_096,
  maxToolExcerptBytes: 5 * 1_024,
  maxStoredNavigationHintBytes: 256,
  // Ingest re-redacts these optional legacy fields to the 256-byte stored cap after validation.
  maxNavigationHintBytes: 4 * 1_024,
  maxRepoRelativePaths: 256,
  maxRepoRelativePathBytes: 1_024,
  maxRepoRelativePathsBytes: 64 * 1_024,
  maxLegacyRawBundles: 1_000,
  maxLegacyRawPartIds: 1_024,
  maxLegacyRawPartIdBytes: 256,
  maxLegacyRawPartIdsBytes: 64 * 1_024,
  // This legacy field is base64 text that is ignored after validation, so the bound is on its
  // UTF-8 encoded JSON string rather than a decoded upload size.
  maxLegacyRawGzipBytes: 10 * 1_024 * 1_024,
  maxTimestampMs: 8_640_000_000_000_000,
  maxTraceHeaderBytes: 8 * 1_024,
} as const;

export type FieldSpec =
  | { kind: 'string'; maxBytes: number; optional?: boolean }
  | { kind: 'nullableString'; maxBytes: number; optional?: boolean }
  | { kind: 'boolean'; optional?: boolean }
  | {
      kind: 'number';
      min: number;
      max: number;
      nullable?: boolean;
      optional?: boolean;
    }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | {
      kind: 'stringArray';
      maxItems: number;
      itemMaxBytes: number;
      maxTotalBytes: number;
      optional?: boolean;
    };

export const stringField = (maxBytes: number, optional = false): FieldSpec => ({
  kind: 'string',
  maxBytes,
  optional,
});
export const nullableStringField = (maxBytes: number, optional = false): FieldSpec => ({
  kind: 'nullableString',
  maxBytes,
  optional,
});
export const booleanField = (optional = false): FieldSpec => ({ kind: 'boolean', optional });
export const numberField = (
  min: number,
  max: number,
  options: Pick<FieldSpec & { kind: 'number' }, 'nullable' | 'optional'> = {},
): FieldSpec => ({ kind: 'number', min, max, ...options });
export const uint32Field = (
  options: Pick<FieldSpec & { kind: 'number' }, 'nullable' | 'optional'> = {},
) => numberField(0, 0xffff_ffff, options);
export const uint8Field = (
  options: Pick<FieldSpec & { kind: 'number' }, 'nullable' | 'optional'> = {},
) => numberField(0, 0xff, options);
export const timestampField = (nullable = false, optional = false): FieldSpec =>
  numberField(0, AGENT_INGEST_LIMITS.maxTimestampMs, { nullable, optional });
export const enumField = (values: readonly string[], optional = false): FieldSpec => ({
  kind: 'enum',
  values,
  optional,
});
export const stringArrayField = (
  maxItems: number,
  itemMaxBytes: number,
  maxTotalBytes: number,
  optional = false,
): FieldSpec => ({ kind: 'stringArray', maxItems, itemMaxBytes, maxTotalBytes, optional });

export const AGENT_SOURCES = [
  'claude',
  'codex',
  'cursor',
] as const satisfies readonly AgentSource[];
export const TOKEN_COVERAGES = [
  'full',
  'partial',
  'missing',
] as const satisfies readonly TokenCoverage[];
export const CACHE_COVERAGES = ['full', 'missing'] as const satisfies readonly CacheCoverage[];
export const EVENT_STATUSES = [
  'success',
  'failure',
  'unknown',
] as const satisfies readonly AgentEventStatus[];
export const TOOL_ERROR_CATEGORIES = [
  'unknown',
  'missing_file',
  'read_directory',
  'edit_before_read',
  'stale_file_before_edit',
  'external_schema_validation',
  'runtime_env_mismatch',
  'tool_input_validation',
  'human_or_policy_rejection',
  'wrong_tool_name',
  'oversized_read',
  'other',
] as const satisfies readonly AgentToolErrorCategory[];
export const TOOL_ERROR_COVERAGES = [
  'not_applicable',
  'classified',
  'unknown',
] as const satisfies readonly AgentToolErrorCoverage[];
export const NAVIGATION_KINDS = [
  'none',
  'search',
  'file_read',
  'directory_list',
  'directory_change',
] as const satisfies readonly AgentNavigationKind[];
export const NAVIGATION_HINT_COVERAGES = [
  'not_applicable',
  'structured',
  'unknown',
] as const satisfies readonly AgentNavigationHintCoverage[];
export const REPO_SOURCES = ['remote', 'path'] as const satisfies readonly RepoSource[];
export const MESSAGE_ROLES = [
  'user',
  'assistant',
  'system',
  'tool',
  'other',
] as const satisfies readonly AgentMessageRole[];
export const FILE_OPERATIONS = [
  'read',
  'write',
  'edit',
  'create',
  'delete',
  'rename',
  'other',
] as const satisfies readonly AgentFileOperation[];
export const CAPABILITY_KINDS = [
  'base_instructions',
  'dynamic_tools',
  'mcp_servers',
  'other',
] as const satisfies readonly AgentCapabilityKind[];
export const LINK_EVIDENCE = [
  'assistant_text',
  'tool_output',
  'transcript_record',
] as const satisfies readonly PullRequestLinkEvidence[];
export const LINK_CONFIDENCES = [
  'high',
  'medium',
  'low',
] as const satisfies readonly PullRequestLinkConfidence[];
export const REVIEW_ATTRIBUTION_METHODS = [
  'direct_link',
  'branch_retro',
  'manual',
] as const satisfies readonly ReviewUnitAttributionMethod[];
export const REVIEW_ATTRIBUTION_CONFIDENCES = [
  'high',
  'medium',
  'low',
] as const satisfies readonly ReviewUnitAttributionConfidence[];
export const REVIEW_ATTRIBUTION_STATUSES = [
  'attributed',
  'ambiguous',
  'rejected',
] as const satisfies readonly ReviewUnitAttributionStatus[];
