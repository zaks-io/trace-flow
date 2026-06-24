import { describe, it, expect } from 'vitest';
import {
  batchContext,
  capabilitySnapshotRow,
  fileEventRow,
  messageRow,
  pullRequestLinkRow,
  reviewUnitAttributionRow,
  toClickhouseDateTime64,
  toolEventRow,
} from '../rows';
import {
  EVENT_AT,
  capabilitySnapshotFact,
  fileEventFact,
  messageFact,
  pullRequestLinkFact,
  queueMessage,
  reviewUnitAttributionFact,
  toolEventFact,
} from './factories';

// The exact JSONPath column set of each agent_* datasource. A row mapper must emit precisely these
// keys — the Events API drops unknown keys silently and quarantines rows missing a schema column, so
// drift here is invisible until live ingest. Pin it.
const MESSAGE_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'message_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'EventAt',
  'IngestedAt',
  'VendorStartedAt',
  'vendor_session_id',
  'vendor_message_id',
  'turn_index',
  'role',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
  'reasoning_tokens',
  'token_coverage',
  'cache_coverage',
  'agent_depth',
  'is_subagent_spawn',
  'is_sidechain',
  'agent_id',
  'normalized_git_remote',
  'repo_path_fallback',
  'git_branch',
  'git_head_sha',
  'dropped_sensitive',
  'cost_usd',
];
const TOOL_EVENT_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'tool_use_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'EventAt',
  'IngestedAt',
  'vendor_session_id',
  'vendor_message_id',
  'tool_use_id',
  'source_block_index',
  'tool_name',
  'command_family',
  'command_program',
  'command_subcommand',
  'status',
  'exit_code',
  'duration_ms',
  'repo_relative_paths',
  'extracted_provider',
  'extracted_repo',
  'extracted_pr_number',
  'command_excerpt',
  'error_excerpt',
  'extracted_subagent_agent_id',
  'extracted_subagent_model',
  'extracted_subagent_input_tokens',
  'extracted_subagent_output_tokens',
  'extracted_subagent_cache_read_tokens',
  'extracted_subagent_cache_creation_tokens',
  'dropped_sensitive',
];
const FILE_EVENT_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'file_event_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'EventAt',
  'IngestedAt',
  'vendor_session_id',
  'vendor_message_id',
  'source_block_index',
  'normalized_repo_path',
  'operation',
  'dropped_sensitive',
];
const CAPABILITY_SNAPSHOT_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'capability_snapshot_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'EventAt',
  'IngestedAt',
  'vendor_session_id',
  'source_snapshot_id',
  'stable_turn_index',
  'capability_kind',
  'item_count',
  'total_size_bytes',
  'total_tokens_estimate',
  'content_hash',
  'redacted_label',
  'dropped_sensitive',
];
const PULL_REQUEST_LINK_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'pull_request_link_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'EventAt',
  'IngestedAt',
  'vendor_session_id',
  'source_event_id',
  'stable_turn_index',
  'host',
  'owner',
  'repo',
  'number',
  'url',
  'confidence',
  'evidence',
  'dropped_sensitive',
];
const REVIEW_UNIT_ATTRIBUTION_COLUMNS = [
  'OrgId',
  'UserId',
  'CollectorId',
  'CollectorCredentialId',
  'session_pk',
  'review_unit_attribution_pk',
  'repo_fingerprint',
  'repo_source',
  'source',
  'parser_version',
  'DecidedAt',
  'IngestedAt',
  'vendor_session_id',
  'review_unit_key',
  'review_url',
  'review_host',
  'review_owner',
  'review_repo',
  'review_number',
  'git_branch',
  'attribution_method',
  'confidence',
  'status',
  'ambiguity_reason',
  'evidence_pull_request_link_pk',
  'rule_version',
];

const ctx = batchContext(queueMessage());

function keys(row: object): string[] {
  return Object.keys(row).sort();
}

describe('toClickhouseDateTime64', () => {
  it('renders epoch ms as the UTC DateTime64(3) literal', () => {
    expect(toClickhouseDateTime64(EVENT_AT)).toBe('2026-05-20 10:00:00.000');
  });

  it('keeps millisecond precision', () => {
    expect(toClickhouseDateTime64(Date.UTC(2026, 4, 20, 10, 0, 0, 123))).toBe(
      '2026-05-20 10:00:00.123',
    );
  });

  it('renders the epoch-0 sentinel', () => {
    expect(toClickhouseDateTime64(0)).toBe('1970-01-01 00:00:00.000');
  });
});

describe('batchContext', () => {
  it('derives IngestedAt from enqueued_at', () => {
    expect(ctx.ingestedAt).toBe('2026-05-20 12:00:00.000');
  });
});

describe('messageRow', () => {
  it('emits exactly the agent_message_facts schema columns', () => {
    expect(keys(messageRow(ctx, messageFact(), 0.000003))).toEqual([...MESSAGE_COLUMNS].sort());
  });

  it('passes a numeric cost through and preserves a null cost (the only Nullable column)', () => {
    expect(messageRow(ctx, messageFact(), 0.000003).cost_usd).toBe(0.000003);
    expect(messageRow(ctx, messageFact(), null).cost_usd).toBeNull();
  });

  it('renders timestamp columns as DateTime64(3) literals', () => {
    const row = messageRow(ctx, messageFact(), null);
    expect(row.EventAt).toBe('2026-05-20 10:00:00.000');
    expect(row.IngestedAt).toBe('2026-05-20 12:00:00.000');
  });

  it('collapses a null vendor_started_at to the epoch sentinel', () => {
    expect(messageRow(ctx, messageFact({ vendor_started_at: null }), null).VendorStartedAt).toBe(
      '1970-01-01 00:00:00.000',
    );
  });

  it('renders a present vendor_started_at', () => {
    expect(
      messageRow(ctx, messageFact({ vendor_started_at: EVENT_AT }), null).VendorStartedAt,
    ).toBe('2026-05-20 10:00:00.000');
  });

  it('collapses a null vendor_message_id to the empty-string sentinel', () => {
    expect(messageRow(ctx, messageFact({ vendor_message_id: null }), null).vendor_message_id).toBe(
      '',
    );
  });

  it('encodes booleans as UInt8', () => {
    const on = messageRow(ctx, messageFact({ is_subagent_spawn: true, is_sidechain: true }), null);
    expect(on.is_subagent_spawn).toBe(1);
    expect(on.is_sidechain).toBe(1);
    const off = messageRow(
      ctx,
      messageFact({ is_subagent_spawn: false, is_sidechain: false }),
      null,
    );
    expect(off.is_subagent_spawn).toBe(0);
    expect(off.is_sidechain).toBe(0);
  });
});

describe('toolEventRow', () => {
  it('emits exactly the agent_tool_event_facts schema columns', () => {
    expect(keys(toolEventRow(ctx, toolEventFact()))).toEqual([...TOOL_EVENT_COLUMNS].sort());
  });

  it('collapses nullable wire fields to non-null sentinels', () => {
    const row = toolEventRow(
      ctx,
      toolEventFact({
        vendor_message_id: null,
        tool_use_id: null,
        exit_code: null,
        duration_ms: null,
        extracted_pr_number: null,
      }),
    );
    expect(row.vendor_message_id).toBe('');
    expect(row.tool_use_id).toBe('');
    expect(row.exit_code).toBe(0);
    expect(row.duration_ms).toBe(0);
    expect(row.extracted_pr_number).toBe(0);
  });

  it('preserves present nullable values', () => {
    const row = toolEventRow(ctx, toolEventFact({ exit_code: 137, duration_ms: 250 }));
    expect(row.exit_code).toBe(137);
    expect(row.duration_ms).toBe(250);
  });
});

describe('fileEventRow', () => {
  it('emits exactly the agent_file_event_facts schema columns', () => {
    expect(keys(fileEventRow(ctx, fileEventFact()))).toEqual([...FILE_EVENT_COLUMNS].sort());
  });

  it('collapses a null vendor_message_id to the empty-string sentinel', () => {
    expect(fileEventRow(ctx, fileEventFact({ vendor_message_id: null })).vendor_message_id).toBe(
      '',
    );
  });
});

describe('capabilitySnapshotRow', () => {
  it('emits exactly the agent_capability_snapshot_facts schema columns', () => {
    expect(keys(capabilitySnapshotRow(ctx, capabilitySnapshotFact()))).toEqual(
      [...CAPABILITY_SNAPSHOT_COLUMNS].sort(),
    );
  });

  it('collapses a null source_snapshot_id to the empty-string sentinel', () => {
    expect(
      capabilitySnapshotRow(ctx, capabilitySnapshotFact({ source_snapshot_id: null }))
        .source_snapshot_id,
    ).toBe('');
  });
});

describe('pullRequestLinkRow', () => {
  it('emits exactly the agent_pull_request_facts schema columns', () => {
    expect(keys(pullRequestLinkRow(ctx, pullRequestLinkFact()))).toEqual(
      [...PULL_REQUEST_LINK_COLUMNS].sort(),
    );
  });

  it('collapses a null source_event_id to the empty-string sentinel', () => {
    expect(
      pullRequestLinkRow(ctx, pullRequestLinkFact({ source_event_id: null })).source_event_id,
    ).toBe('');
  });
});

describe('reviewUnitAttributionRow', () => {
  it('emits exactly the agent_review_unit_attributions schema columns', () => {
    expect(keys(reviewUnitAttributionRow(ctx, reviewUnitAttributionFact()))).toEqual(
      [...REVIEW_UNIT_ATTRIBUTION_COLUMNS].sort(),
    );
  });

  it('renders decision and ingest timestamps separately', () => {
    const row = reviewUnitAttributionRow(ctx, reviewUnitAttributionFact());
    expect(row.DecidedAt).toBe('2026-05-20 10:00:00.000');
    expect(row.IngestedAt).toBe('2026-05-20 12:00:00.000');
  });
});
