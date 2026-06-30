import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type {
  AgentIngestEnvelope,
  AgentMessageFact,
  AgentToolEventFact,
  AgentFileEventFact,
  AgentCapabilitySnapshotFact,
  AgentPullRequestLinkFact,
  AgentSource,
  AgentMessageRole,
  TokenCoverage,
  CacheCoverage,
  AgentEventStatus,
  AgentToolErrorCategory,
  AgentToolErrorCoverage,
  AgentNavigationKind,
  AgentNavigationHintCoverage,
  AgentFileOperation,
  AgentCapabilityKind,
  PullRequestLinkConfidence,
  PullRequestLinkEvidence,
} from '../agent-ingest';

/**
 * The Rust mirror (`packages/collector-contracts`) serializes the same fixture and asserts
 * field-equality. Here the TS side deserializes it: typed field access makes a rename a tsc error
 * (so `bun run type-check` is half the guard), and the runtime assertions make a fixture drift a
 * test failure. A serde/TS rename on either side then fails its own assertion.
 */
const repoRoot = new URL('../../../../', import.meta.url);
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, repoRoot), 'utf8'));

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNullableString = (v: unknown): v is string | null => v === null || isString(v);
const isNullableNumber = (v: unknown): v is number | null => v === null || isNumber(v);

// Enum guards: `as const satisfies readonly T[]` makes the literal list a tsc error if it drifts
// from the union in `agent-ingest.ts`, so the fixture is checked against the real wire enums (not
// just "is a string") at both compile time and run time.
const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v);

const isSource = oneOf(['claude', 'codex', 'cursor'] as const satisfies readonly AgentSource[]);
const isRole = oneOf([
  'user',
  'assistant',
  'system',
  'tool',
  'other',
] as const satisfies readonly AgentMessageRole[]);
const isTokenCoverage = oneOf([
  'full',
  'partial',
  'missing',
] as const satisfies readonly TokenCoverage[]);
const isCacheCoverage = oneOf(['full', 'missing'] as const satisfies readonly CacheCoverage[]);
const isStatus = oneOf([
  'success',
  'failure',
  'unknown',
] as const satisfies readonly AgentEventStatus[]);
const isToolErrorCategory = oneOf([
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
] as const satisfies readonly AgentToolErrorCategory[]);
const isToolErrorCoverage = oneOf([
  'not_applicable',
  'classified',
  'unknown',
] as const satisfies readonly AgentToolErrorCoverage[]);
const isNavigationKind = oneOf([
  'none',
  'search',
  'file_read',
  'directory_list',
  'directory_change',
] as const satisfies readonly AgentNavigationKind[]);
const isNavigationHintCoverage = oneOf([
  'not_applicable',
  'structured',
  'unknown',
] as const satisfies readonly AgentNavigationHintCoverage[]);
const isOperation = oneOf([
  'read',
  'write',
  'edit',
  'create',
  'delete',
  'rename',
  'other',
] as const satisfies readonly AgentFileOperation[]);
const isCapabilityKind = oneOf([
  'base_instructions',
  'dynamic_tools',
  'mcp_servers',
  'other',
] as const satisfies readonly AgentCapabilityKind[]);
const isConfidence = oneOf([
  'high',
  'medium',
  'low',
] as const satisfies readonly PullRequestLinkConfidence[]);
const isEvidence = oneOf([
  'assistant_text',
  'tool_output',
  'transcript_record',
] as const satisfies readonly PullRequestLinkEvidence[]);

function assertMessage(m: AgentMessageFact): void {
  expect(isString(m.vendor_session_id)).toBe(true);
  expect(isNullableString(m.vendor_message_id)).toBe(true);
  expect(isNumber(m.turn_index)).toBe(true);
  expect(isRole(m.role)).toBe(true);
  expect(isNumber(m.event_at)).toBe(true);
  expect(isString(m.model)).toBe(true);
  expect(isNumber(m.input_tokens)).toBe(true);
  expect(isNumber(m.output_tokens)).toBe(true);
  expect(isNumber(m.cache_read_tokens)).toBe(true);
  expect(isNumber(m.cache_creation_tokens)).toBe(true);
  expect(isNumber(m.cache_creation_5m_tokens)).toBe(true);
  expect(isNumber(m.cache_creation_1h_tokens)).toBe(true);
  expect(isNumber(m.reasoning_tokens)).toBe(true);
  expect(isTokenCoverage(m.token_coverage)).toBe(true);
  expect(isCacheCoverage(m.cache_coverage)).toBe(true);
  expect(isNumber(m.agent_depth)).toBe(true);
  expect(isBool(m.is_subagent_spawn)).toBe(true);
  expect(isBool(m.is_sidechain)).toBe(true);
  expect(isString(m.agent_id)).toBe(true);
  expect(isString(m.normalized_git_remote)).toBe(true);
  expect(isString(m.repo_path_fallback)).toBe(true);
  expect(isString(m.git_branch)).toBe(true);
  expect(isString(m.git_head_sha)).toBe(true);
  expect(isNullableNumber(m.vendor_started_at)).toBe(true);
  expect(isNumber(m.dropped_sensitive)).toBe(true);
}

function assertToolEvent(t: AgentToolEventFact): void {
  expect(isString(t.vendor_session_id)).toBe(true);
  expect(isNullableString(t.vendor_message_id)).toBe(true);
  expect(isNullableString(t.tool_use_id)).toBe(true);
  expect(isNumber(t.source_block_index)).toBe(true);
  expect(isNumber(t.event_at)).toBe(true);
  expect(isString(t.tool_name)).toBe(true);
  expect(isString(t.command_family)).toBe(true);
  expect(isString(t.command_program)).toBe(true);
  expect(isString(t.command_subcommand)).toBe(true);
  expect(isStatus(t.status)).toBe(true);
  expect(isToolErrorCategory(t.error_category)).toBe(true);
  expect(isToolErrorCoverage(t.error_category_coverage)).toBe(true);
  expect(isNullableNumber(t.exit_code)).toBe(true);
  expect(isNullableNumber(t.duration_ms)).toBe(true);
  expect(isBool(t.is_navigation)).toBe(true);
  expect(isNavigationKind(t.navigation_kind)).toBe(true);
  expect(isNavigationHintCoverage(t.navigation_hint_coverage)).toBe(true);
  expect(isString(t.navigation_path_hint)).toBe(true);
  expect(isString(t.navigation_pattern_hint)).toBe(true);
  expect(Array.isArray(t.repo_relative_paths) && t.repo_relative_paths.every(isString)).toBe(true);
  expect(isString(t.extracted_provider)).toBe(true);
  expect(isString(t.extracted_repo)).toBe(true);
  expect(isNullableNumber(t.extracted_pr_number)).toBe(true);
  expect(isString(t.command_excerpt)).toBe(true);
  expect(isString(t.error_excerpt)).toBe(true);
  expect(isString(t.extracted_subagent_agent_id)).toBe(true);
  expect(isString(t.extracted_subagent_model)).toBe(true);
  expect(isNumber(t.extracted_subagent_input_tokens)).toBe(true);
  expect(isNumber(t.extracted_subagent_output_tokens)).toBe(true);
  expect(isNumber(t.extracted_subagent_cache_read_tokens)).toBe(true);
  expect(isNumber(t.extracted_subagent_cache_creation_tokens)).toBe(true);
  expect(isNumber(t.dropped_sensitive)).toBe(true);
}

function assertFileEvent(f: AgentFileEventFact): void {
  expect(isString(f.vendor_session_id)).toBe(true);
  expect(isNullableString(f.vendor_message_id)).toBe(true);
  expect(isNumber(f.source_block_index)).toBe(true);
  expect(isString(f.normalized_repo_path)).toBe(true);
  expect(isOperation(f.operation)).toBe(true);
  expect(isNumber(f.event_at)).toBe(true);
  expect(isNumber(f.dropped_sensitive)).toBe(true);
}

function assertCapability(c: AgentCapabilitySnapshotFact): void {
  expect(isString(c.vendor_session_id)).toBe(true);
  expect(isNullableString(c.source_snapshot_id)).toBe(true);
  expect(isNumber(c.stable_turn_index)).toBe(true);
  expect(isNumber(c.event_at)).toBe(true);
  expect(isCapabilityKind(c.capability_kind)).toBe(true);
  expect(isNumber(c.item_count)).toBe(true);
  expect(isNumber(c.total_size_bytes)).toBe(true);
  expect(isNumber(c.total_tokens_estimate)).toBe(true);
  expect(isString(c.content_hash)).toBe(true);
  expect(isString(c.redacted_label)).toBe(true);
  expect(isNumber(c.dropped_sensitive)).toBe(true);
}

function assertPrLink(p: AgentPullRequestLinkFact): void {
  expect(isString(p.vendor_session_id)).toBe(true);
  expect(isNullableString(p.source_event_id)).toBe(true);
  expect(isNumber(p.stable_turn_index)).toBe(true);
  expect(isNumber(p.event_at)).toBe(true);
  expect(isString(p.host)).toBe(true);
  expect(isString(p.owner)).toBe(true);
  expect(isString(p.repo)).toBe(true);
  expect(isNumber(p.number)).toBe(true);
  expect(isString(p.url)).toBe(true);
  expect(isConfidence(p.confidence)).toBe(true);
  expect(isEvidence(p.evidence)).toBe(true);
  expect(isNumber(p.dropped_sensitive)).toBe(true);
}

describe('AgentIngestEnvelope contract fixture', () => {
  const envelope = readFixture('agent-envelope.sample.json') as AgentIngestEnvelope;

  it('deserializes the batch with every field present and typed', () => {
    const { batch } = envelope;
    expect(isSource(batch.source)).toBe(true);
    expect(isString(batch.collector_batch_id)).toBe(true);
    expect(isString(batch.desktop_version)).toBe(true);
    expect(isString(batch.parser_version)).toBe(true);
    expect(isBool(batch.raw_upload_requested)).toBe(true);
  });

  it('carries all five fully-populated fact arrays', () => {
    const { facts } = envelope;
    expect(facts.messages.length).toBeGreaterThan(0);
    expect(facts.tool_events.length).toBeGreaterThan(0);
    expect(facts.file_events.length).toBeGreaterThan(0);
    expect(facts.capability_snapshots.length).toBeGreaterThan(0);
    expect(facts.pull_request_links.length).toBeGreaterThan(0);
    facts.messages.forEach(assertMessage);
    facts.tool_events.forEach(assertToolEvent);
    facts.file_events.forEach(assertFileEvent);
    facts.capability_snapshots.forEach(assertCapability);
    facts.pull_request_links.forEach(assertPrLink);
  });

  it('keeps new tool classifications optional for legacy collectors', () => {
    const legacyTool: AgentToolEventFact = { ...envelope.facts.tool_events[0]! };
    delete legacyTool.error_category;
    delete legacyTool.error_category_coverage;
    delete legacyTool.is_navigation;
    delete legacyTool.navigation_kind;
    delete legacyTool.navigation_hint_coverage;
    delete legacyTool.navigation_path_hint;
    delete legacyTool.navigation_pattern_hint;

    expect(legacyTool.error_category).toBeUndefined();
    expect(legacyTool.navigation_kind).toBeUndefined();
  });

  it('plumbs the deferred raw_session_bundles slot', () => {
    expect(envelope.raw_session_bundles).toBeDefined();
    const bundle = envelope.raw_session_bundles?.[0];
    expect(bundle).toBeDefined();
    expect(isString(bundle?.gzip_base64)).toBe(true);
    expect(isString(bundle?.manifest.vendor_session_id)).toBe(true);
    expect(isNumber(bundle?.manifest.byte_count)).toBe(true);
    expect(Array.isArray(bundle?.manifest.part_ids)).toBe(true);
  });
});

describe('shared redaction canary corpus', () => {
  it('parses and every case carries name/category/input/expect', () => {
    const corpus = readFixture('redaction-canary.json') as {
      cases: { name: string; category: string; input: string; expect: string }[];
    };
    expect(Array.isArray(corpus.cases)).toBe(true);
    expect(corpus.cases.length).toBeGreaterThan(0);
    for (const c of corpus.cases) {
      expect(isString(c.name)).toBe(true);
      expect(isString(c.category)).toBe(true);
      expect(isString(c.input)).toBe(true);
      expect(['drop', 'mask']).toContain(c.expect);
    }
  });
});
