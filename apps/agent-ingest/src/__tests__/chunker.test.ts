import { describe, it, expect } from 'vitest';
import type { AgentIngestQueueFacts, AgentIngestQueueMessage } from '@trace-flow/types';
import { CATEGORIES, MAX_QUEUE_MESSAGE_BYTES, chunkFacts } from '../chunker';

const base: Omit<AgentIngestQueueMessage, 'facts'> = {
  type: 'agent',
  source: 'claude',
  parser_version: '1.2.3',
  desktop_version: '1.2.3',
  collector_batch_id: 'batch-1',
  tenancy: {
    org_id: 'org-1',
    user_id: 'user-1',
    collector_id: 'collector-1',
    collector_credential_id: 'cred-1',
  },
  enqueued_at: 1_700_000_000_000,
};

function messageQueueFact(i: number): AgentIngestQueueFacts['messages'][number] {
  return {
    vendor_session_id: 'vsid-1',
    vendor_message_id: `msg-${i}`,
    turn_index: i,
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
    session_pk: 'session-pk',
    message_pk: `message-pk-${i}`,
    repo_fingerprint: 'fp',
    repo_source: 'remote',
  };
}

function emptyQueueFacts(): AgentIngestQueueFacts {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
  };
}

const encoder = new TextEncoder();
const size = (m: AgentIngestQueueMessage): number => encoder.encode(JSON.stringify(m)).length;

describe('CATEGORIES', () => {
  it('covers every fact array — a missing category would silently drop that array', () => {
    const keys = Object.keys(emptyQueueFacts()).sort();
    expect([...CATEGORIES].sort()).toEqual(keys);
  });
});

describe('chunkFacts', () => {
  it('returns no messages for empty facts', () => {
    expect(chunkFacts(base, emptyQueueFacts())).toHaveLength(0);
  });

  it('packs a small batch into a single message', () => {
    const f = emptyQueueFacts();
    f.messages = [messageQueueFact(0), messageQueueFact(1)];
    const out = chunkFacts(base, f);
    expect(out).toHaveLength(1);
    expect(out[0]!.facts.messages).toHaveLength(2);
  });

  it('splits into multiple messages, each under the cap, preserving every fact', () => {
    const f = emptyQueueFacts();
    f.messages = Array.from({ length: 2000 }, (_v, i) => messageQueueFact(i));

    const out = chunkFacts(base, f);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) {
      expect(size(m)).toBeLessThanOrEqual(MAX_QUEUE_MESSAGE_BYTES);
    }
    const total = out.reduce((n, m) => n + m.facts.messages.length, 0);
    expect(total).toBe(2000);
  });

  it('packs facts drawn from more than one array into a single message', () => {
    const f = emptyQueueFacts();
    f.messages = [messageQueueFact(0)];
    f.tool_events = [
      {
        vendor_session_id: 'vsid-1',
        vendor_message_id: 'msg-0',
        tool_use_id: 'tool-0',
        source_block_index: 0,
        event_at: 1_700_000_000_000,
        tool_name: 'Bash',
        command_family: 'git',
        command_program: 'git',
        command_subcommand: 'status',
        status: 'success',
        exit_code: 0,
        duration_ms: 5,
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
        session_pk: 'session-pk',
        tool_use_pk: 'tool-pk',
        repo_fingerprint: 'fp',
        repo_source: 'remote',
      },
    ];
    f.file_events = [
      {
        vendor_session_id: 'vsid-1',
        vendor_message_id: 'msg-0',
        source_block_index: 0,
        normalized_repo_path: 'src/index.ts',
        operation: 'edit',
        event_at: 1_700_000_000_000,
        dropped_sensitive: 0,
        session_pk: 'session-pk',
        file_event_pk: 'file-pk',
        repo_fingerprint: 'fp',
        repo_source: 'remote',
      },
    ];

    const out = chunkFacts(base, f);
    expect(out).toHaveLength(1);
    expect(out[0]!.facts.messages).toHaveLength(1);
    expect(out[0]!.facts.tool_events).toHaveLength(1);
    expect(out[0]!.facts.file_events).toHaveLength(1);
  });
});
