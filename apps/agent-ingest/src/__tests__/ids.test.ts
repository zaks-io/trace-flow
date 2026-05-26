import { describe, it, expect } from 'vitest';
import { assembleQueueFacts, hashToUuid, repoFingerprint } from '../ids';
import { emptyFacts, facts, messageFact, toolEventFact } from './factories';

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('hashToUuid', () => {
  it('emits a valid UUIDv8', async () => {
    expect(await hashToUuid(['claude', 'vsid-1'])).toMatch(UUID_V8);
  });

  it('is deterministic for identical parts', async () => {
    expect(await hashToUuid(['a', 'b'])).toBe(await hashToUuid(['a', 'b']));
  });

  it('is sensitive to field boundaries (length-prefixed)', async () => {
    expect(await hashToUuid(['ab', 'c'])).not.toBe(await hashToUuid(['a', 'bc']));
  });
});

describe('repoFingerprint', () => {
  it('prefers the remote and stamps repo_source=remote', async () => {
    const fp = await repoFingerprint('github.com/acme/repo', '/some/path');
    expect(fp.repoSource).toBe('remote');
    expect(fp.fingerprint).toMatch(UUID_V8);
  });

  it('falls back to the path with repo_source=path when no remote', async () => {
    const fp = await repoFingerprint('', 'acme/repo');
    expect(fp.repoSource).toBe('path');
  });

  it('separates remote and path namespaces for the same string', async () => {
    const remote = await repoFingerprint('x', '');
    const path = await repoFingerprint('', 'x');
    expect(remote.fingerprint).not.toBe(path.fingerprint);
  });
});

describe('assembleQueueFacts', () => {
  it('stamps session_pk, row pk, fingerprint, and source on every array', async () => {
    const { queueFacts, sessionPks } = await assembleQueueFacts(facts(), 'claude');
    expect(sessionPks).toHaveLength(1);
    expect(queueFacts.messages[0]!.session_pk).toMatch(UUID_V8);
    expect(queueFacts.messages[0]!.message_pk).toMatch(UUID_V8);
    expect(queueFacts.messages[0]!.repo_fingerprint).toMatch(UUID_V8);
    expect(queueFacts.messages[0]!.repo_source).toBe('remote');
    expect(queueFacts.tool_events[0]!.tool_use_pk).toMatch(UUID_V8);
    expect(queueFacts.file_events[0]!.file_event_pk).toMatch(UUID_V8);
    expect(queueFacts.capability_snapshots[0]!.capability_snapshot_pk).toMatch(UUID_V8);
    expect(queueFacts.pull_request_links[0]!.pull_request_link_pk).toMatch(UUID_V8);
  });

  it('shares one session_pk + fingerprint across a session', async () => {
    const { queueFacts } = await assembleQueueFacts(facts(), 'claude');
    const spk = queueFacts.messages[0]!.session_pk;
    expect(queueFacts.tool_events[0]!.session_pk).toBe(spk);
    expect(queueFacts.file_events[0]!.session_pk).toBe(spk);
    expect(queueFacts.messages[0]!.repo_fingerprint).toBe(
      queueFacts.tool_events[0]!.repo_fingerprint,
    );
  });

  it('derives distinct message_pks from turn_index when vendor_message_id is null (Codex)', async () => {
    const codex = await assembleQueueFacts(
      facts({
        messages: [
          messageFact({ vendor_message_id: null, turn_index: 0 }),
          messageFact({ vendor_message_id: null, turn_index: 1 }),
        ],
        tool_events: [],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
      'codex',
    );
    const [a, b] = codex.queueFacts.messages;
    expect(a!.message_pk).not.toBe(b!.message_pk);
  });

  it('falls back to (message id, block index) for tool_use_pk when tool_use_id is null', async () => {
    const result = await assembleQueueFacts(
      facts({
        messages: [],
        tool_events: [
          toolEventFact({ tool_use_id: null, source_block_index: 0 }),
          toolEventFact({ tool_use_id: null, source_block_index: 1 }),
        ],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
      'codex',
    );
    const [a, b] = result.queueFacts.tool_events;
    expect(a!.tool_use_pk).not.toBe(b!.tool_use_pk);
  });

  it('gives path-fallback identity to sessions present only in non-message arrays', async () => {
    const result = await assembleQueueFacts(
      facts({
        messages: [],
        tool_events: [toolEventFact({ vendor_session_id: 'orphan' })],
        file_events: [],
        capability_snapshots: [],
        pull_request_links: [],
      }),
      'claude',
    );
    expect(result.queueFacts.tool_events[0]!.repo_source).toBe('path');
    expect(result.sessionPks).toHaveLength(1);
  });

  it('produces no facts and no session_pks for empty input', async () => {
    const { queueFacts, sessionPks } = await assembleQueueFacts(emptyFacts(), 'claude');
    expect(sessionPks).toHaveLength(0);
    expect(queueFacts.messages).toHaveLength(0);
  });
});
