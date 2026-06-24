import { describe, it, expect } from 'vitest';
import type { AgentIngestQueueFacts } from '@trace-flow/types';
import { assembleQueueFacts, hashToUuid, repoFingerprint } from '../ids';
import { emptyFacts, facts, messageFact, toolEventFact } from './factories';

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function firstReviewUnitAttribution(queueFacts: AgentIngestQueueFacts) {
  const [edge] = queueFacts.review_unit_attributions ?? [];
  expect(edge).toBeDefined();
  return edge!;
}

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
    expect(firstReviewUnitAttribution(queueFacts).review_unit_attribution_pk).toMatch(UUID_V8);
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
    expect(queueFacts.review_unit_attributions).toHaveLength(0);
  });

  it('attributes exactly one same-repo hosted-review link to a review unit', async () => {
    const { queueFacts } = await assembleQueueFacts(facts(), 'claude');
    const edge = firstReviewUnitAttribution(queueFacts);
    expect(edge.status).toBe('attributed');
    expect(edge.attribution_method).toBe('direct_link');
    expect(edge.rule_version).toBe('direct_link_v1');
    expect(edge.review_unit_key).toBe('hosted:github.com/acme/repo:pull_request:42');
    expect(edge.review_url).toBe('https://github.com/acme/repo/pull/42');
    expect(edge.confidence).toBe('high');
    expect(edge.ambiguity_reason).toBe('');
    expect(edge.evidence_pull_request_link_pk).toBe(
      queueFacts.pull_request_links[0]!.pull_request_link_pk,
    );
  });

  it('keeps duplicate decisions idempotent and gives changed decisions a new pk', async () => {
    const original = await assembleQueueFacts(facts(), 'claude');
    const duplicate = await assembleQueueFacts(facts(), 'claude');
    const changed = await assembleQueueFacts(
      facts({
        pull_request_links: [
          {
            ...facts().pull_request_links[0]!,
            number: 43,
            url: 'https://github.com/acme/repo/pull/43',
          },
        ],
      }),
      'claude',
    );

    expect(firstReviewUnitAttribution(original.queueFacts).review_unit_attribution_pk).toBe(
      firstReviewUnitAttribution(duplicate.queueFacts).review_unit_attribution_pk,
    );
    expect(firstReviewUnitAttribution(original.queueFacts).review_unit_attribution_pk).not.toBe(
      firstReviewUnitAttribution(changed.queueFacts).review_unit_attribution_pk,
    );
  });

  it('gives changed attribution audit metadata a new pk', async () => {
    const original = await assembleQueueFacts(facts(), 'claude');
    const branchChanged = await assembleQueueFacts(
      facts({ messages: [messageFact({ git_branch: 'feature/renamed' })] }),
      'claude',
    );
    const evidenceChanged = await assembleQueueFacts(
      facts({
        pull_request_links: [
          {
            ...facts().pull_request_links[0]!,
            source_event_id: 'evt-9',
          },
        ],
      }),
      'claude',
    );

    const originalPk = firstReviewUnitAttribution(original.queueFacts).review_unit_attribution_pk;
    expect(
      firstReviewUnitAttribution(branchChanged.queueFacts).review_unit_attribution_pk,
    ).not.toBe(originalPk);
    expect(
      firstReviewUnitAttribution(evidenceChanged.queueFacts).review_unit_attribution_pk,
    ).not.toBe(originalPk);
  });

  it('marks multiple distinct review links in one session ambiguous', async () => {
    const { queueFacts } = await assembleQueueFacts(
      facts({
        pull_request_links: [
          {
            ...facts().pull_request_links[0]!,
            number: 42,
            url: 'https://github.com/acme/repo/pull/42',
          },
          {
            ...facts().pull_request_links[0]!,
            stable_turn_index: 1,
            number: 43,
            url: 'https://github.com/acme/repo/pull/43',
          },
        ],
      }),
      'claude',
    );
    const edge = firstReviewUnitAttribution(queueFacts);
    expect(edge.status).toBe('ambiguous');
    expect(edge.ambiguity_reason).toBe('multiple_review_units');
    expect(edge.review_unit_key).toBe('');
  });

  it('rejects a single review link when the repo identity does not match the session remote', async () => {
    const { queueFacts } = await assembleQueueFacts(
      facts({
        pull_request_links: [
          {
            ...facts().pull_request_links[0]!,
            repo: 'other',
            url: 'https://github.com/acme/other/pull/42',
          },
        ],
      }),
      'claude',
    );
    const edge = firstReviewUnitAttribution(queueFacts);
    expect(edge.status).toBe('rejected');
    expect(edge.ambiguity_reason).toBe('repo_mismatch');
    expect(edge.review_url).toBe('https://github.com/acme/other/pull/42');
  });

  it('rejects a review link when the session has no resolved remote', async () => {
    const { queueFacts } = await assembleQueueFacts(
      facts({ messages: [messageFact({ normalized_git_remote: '', repo_path_fallback: 'repo' })] }),
      'claude',
    );
    const edge = firstReviewUnitAttribution(queueFacts);
    expect(edge.status).toBe('rejected');
    expect(edge.ambiguity_reason).toBe('missing_remote');
  });
});
