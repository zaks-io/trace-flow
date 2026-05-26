import type {
  AgentCapabilitySnapshotQueueFact,
  AgentFileEventQueueFact,
  AgentIngestQueueFacts,
  AgentIngestQueueMessage,
  AgentMessageQueueFact,
  AgentPullRequestLinkQueueFact,
  AgentToolEventQueueFact,
} from '@trace-flow/types';

export const EVENT_AT = Date.UTC(2026, 4, 20, 10, 0, 0); // 2026-05-20 10:00:00.000 UTC
const ENQUEUED_AT = Date.UTC(2026, 4, 20, 12, 0, 0); // 2026-05-20 12:00:00.000 UTC

export function messageFact(over: Partial<AgentMessageQueueFact> = {}): AgentMessageQueueFact {
  return {
    session_pk: 's1',
    message_pk: 'msg_1',
    repo_fingerprint: 'repo_abc',
    repo_source: 'remote',
    vendor_session_id: 'vs1',
    vendor_message_id: 'vm1',
    turn_index: 0,
    role: 'assistant',
    event_at: EVENT_AT,
    model: 'claude-opus-4-7',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    reasoning_tokens: 0,
    token_coverage: 'full',
    cache_coverage: 'full',
    agent_depth: 0,
    is_subagent_spawn: false,
    is_sidechain: false,
    agent_id: '',
    normalized_git_remote: 'github.com/acme/app',
    repo_path_fallback: '',
    git_branch: 'main',
    git_head_sha: 'abc123',
    vendor_started_at: null,
    dropped_sensitive: 0,
    ...over,
  };
}

export function toolEventFact(
  over: Partial<AgentToolEventQueueFact> = {},
): AgentToolEventQueueFact {
  return {
    session_pk: 's1',
    tool_use_pk: 'tu_1',
    repo_fingerprint: 'repo_abc',
    repo_source: 'remote',
    vendor_session_id: 'vs1',
    vendor_message_id: null,
    tool_use_id: null,
    source_block_index: 0,
    event_at: EVENT_AT,
    tool_name: 'bash',
    command_family: 'git',
    command_program: 'git',
    command_subcommand: 'status',
    status: 'success',
    exit_code: null,
    duration_ms: null,
    repo_relative_paths: [],
    extracted_provider: '',
    extracted_repo: '',
    extracted_pr_number: null,
    command_excerpt: '',
    error_excerpt: '',
    extracted_subagent_agent_id: '',
    extracted_subagent_model: '',
    extracted_subagent_input_tokens: 0,
    extracted_subagent_output_tokens: 0,
    extracted_subagent_cache_read_tokens: 0,
    extracted_subagent_cache_creation_tokens: 0,
    dropped_sensitive: 0,
    ...over,
  };
}

export function fileEventFact(
  over: Partial<AgentFileEventQueueFact> = {},
): AgentFileEventQueueFact {
  return {
    session_pk: 's1',
    file_event_pk: 'fe_1',
    repo_fingerprint: 'repo_abc',
    repo_source: 'remote',
    vendor_session_id: 'vs1',
    vendor_message_id: null,
    source_block_index: 0,
    normalized_repo_path: 'src/index.ts',
    operation: 'edit',
    event_at: EVENT_AT,
    dropped_sensitive: 0,
    ...over,
  };
}

export function capabilitySnapshotFact(
  over: Partial<AgentCapabilitySnapshotQueueFact> = {},
): AgentCapabilitySnapshotQueueFact {
  return {
    session_pk: 's1',
    capability_snapshot_pk: 'cap_1',
    repo_fingerprint: 'repo_abc',
    repo_source: 'remote',
    vendor_session_id: 'vs1',
    source_snapshot_id: null,
    stable_turn_index: 0,
    event_at: EVENT_AT,
    capability_kind: 'base_instructions',
    item_count: 1,
    total_size_bytes: 100,
    total_tokens_estimate: 50,
    content_hash: 'hash1',
    redacted_label: '',
    dropped_sensitive: 0,
    ...over,
  };
}

export function pullRequestLinkFact(
  over: Partial<AgentPullRequestLinkQueueFact> = {},
): AgentPullRequestLinkQueueFact {
  return {
    session_pk: 's1',
    pull_request_link_pk: 'pr_1',
    repo_fingerprint: 'repo_abc',
    repo_source: 'remote',
    vendor_session_id: 'vs1',
    source_event_id: null,
    stable_turn_index: 0,
    event_at: EVENT_AT,
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
    number: 42,
    url: 'https://github.com/acme/app/pull/42',
    confidence: 'high',
    evidence: 'assistant_text',
    dropped_sensitive: 0,
    ...over,
  };
}

export function emptyQueueFacts(): AgentIngestQueueFacts {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  };
}

export function queueMessage(over: Partial<AgentIngestQueueMessage> = {}): AgentIngestQueueMessage {
  return {
    type: 'agent',
    source: 'claude',
    parser_version: 'v1',
    desktop_version: '1.0.0',
    collector_batch_id: 'batch-1',
    tenancy: {
      org_id: 'org-1',
      user_id: 'user-1',
      collector_id: 'collector-1',
      collector_credential_id: 'cred-1',
    },
    facts: { ...emptyQueueFacts(), messages: [messageFact()] },
    enqueued_at: ENQUEUED_AT,
    ...over,
  };
}
