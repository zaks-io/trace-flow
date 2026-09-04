import type {
  AgentCapabilitySnapshotFact,
  AgentFileEventFact,
  AgentIngestEnvelope,
  AgentIngestFacts,
  AgentMessageFact,
  AgentPullRequestLinkFact,
  AgentToolEventFact,
} from '@trace-flow/types';

/** Minimal fully-typed fact builders so tests can assert on identity/redaction without boilerplate. */

export function messageFact(over: Partial<AgentMessageFact> = {}): AgentMessageFact {
  return {
    vendor_session_id: 'vsid-1',
    vendor_message_id: 'msg-1',
    turn_index: 0,
    role: 'assistant',
    event_at: 1_700_000_000_000,
    model: 'claude-sonnet-4-6',
    input_tokens: 10,
    output_tokens: 20,
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
    normalized_git_remote: 'github.com/acme/repo',
    repo_path_fallback: '',
    git_branch: 'main',
    git_head_sha: 'abc123',
    vendor_started_at: null,
    dropped_sensitive: 0,
    ...over,
  };
}

export function toolEventFact(over: Partial<AgentToolEventFact> = {}): AgentToolEventFact {
  const fact: AgentToolEventFact = {
    vendor_session_id: 'vsid-1',
    vendor_message_id: 'msg-1',
    tool_use_id: 'tool-1',
    source_block_index: 0,
    event_at: 1_700_000_000_000,
    tool_name: 'Bash',
    command_family: 'git',
    command_program: 'git',
    command_subcommand: 'status',
    status: 'success',
    error_category: 'unknown',
    error_category_coverage: 'not_applicable',
    exit_code: 0,
    duration_ms: 12,
    is_navigation: false,
    navigation_kind: 'none',
    navigation_hint_coverage: 'not_applicable',
    navigation_path_hint: '',
    navigation_pattern_hint: '',
    repo_relative_paths: [],
    extracted_provider: '',
    extracted_repo: '',
    extracted_pr_number: null,
    command_excerpt: 'git status',
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

  if (fact.status === 'failure') {
    if (over.error_category_coverage === undefined) fact.error_category_coverage = 'unknown';
    if (over.exit_code === undefined) fact.exit_code = 1;
  }
  if (fact.is_navigation) {
    if (over.navigation_kind === undefined) fact.navigation_kind = 'search';
    if (over.navigation_hint_coverage === undefined) fact.navigation_hint_coverage = 'unknown';
  }

  return fact;
}

function fileEventFact(over: Partial<AgentFileEventFact> = {}): AgentFileEventFact {
  return {
    vendor_session_id: 'vsid-1',
    vendor_message_id: 'msg-1',
    source_block_index: 0,
    normalized_repo_path: 'src/index.ts',
    operation: 'edit',
    event_at: 1_700_000_000_000,
    dropped_sensitive: 0,
    ...over,
  };
}

function capabilitySnapshotFact(
  over: Partial<AgentCapabilitySnapshotFact> = {},
): AgentCapabilitySnapshotFact {
  return {
    vendor_session_id: 'vsid-1',
    source_snapshot_id: 'snap-1',
    stable_turn_index: 0,
    event_at: 1_700_000_000_000,
    capability_kind: 'mcp_servers',
    item_count: 3,
    total_size_bytes: 1024,
    total_tokens_estimate: 256,
    content_hash: 'hash-1',
    redacted_label: '',
    dropped_sensitive: 0,
    ...over,
  };
}

function pullRequestLinkFact(
  over: Partial<AgentPullRequestLinkFact> = {},
): AgentPullRequestLinkFact {
  return {
    vendor_session_id: 'vsid-1',
    source_event_id: 'evt-1',
    stable_turn_index: 0,
    event_at: 1_700_000_000_000,
    host: 'github.com',
    owner: 'acme',
    repo: 'repo',
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    confidence: 'high',
    evidence: 'assistant_text',
    dropped_sensitive: 0,
    ...over,
  };
}

export function facts(over: Partial<AgentIngestFacts> = {}): AgentIngestFacts {
  return {
    messages: [messageFact()],
    tool_events: [toolEventFact()],
    file_events: [fileEventFact()],
    capability_snapshots: [capabilitySnapshotFact()],
    pull_request_links: [pullRequestLinkFact()],
    ...over,
  };
}

export function emptyFacts(): AgentIngestFacts {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  };
}

export function envelope(over: Partial<AgentIngestEnvelope> = {}): AgentIngestEnvelope {
  return {
    batch: {
      source: 'claude',
      collector_batch_id: 'batch-1',
      desktop_version: '1.2.3',
      parser_version: '1.2.3',
    },
    facts: facts(),
    ...over,
  };
}
