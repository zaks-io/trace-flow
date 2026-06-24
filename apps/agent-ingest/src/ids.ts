import type {
  AgentIngestFacts,
  AgentIngestQueueFacts,
  AgentPullRequestLinkQueueFact,
  AgentReviewUnitAttributionQueueFact,
  AgentSource,
  RepoSource,
} from '@trace-flow/types';
import { sha256Hex } from '@trace-flow/utils';

const DIRECT_LINK_RULE_VERSION = 'direct_link_v1';

/**
 * Deterministic UUIDv8 from stable parts. Each part is length-prefixed before joining so distinct
 * field boundaries can never collide (`["ab","c"]` ≠ `["a","bc"]`). The first 128 bits of SHA-256
 * become the UUID, with the version (8) and variant nibbles forced to valid values.
 */
export async function hashToUuid(parts: (string | number)[]): Promise<string> {
  const joined = parts
    .map((p) => {
      const s = String(p);
      return `${s.length}:${s}`;
    })
    .join('|');
  const hex = (await sha256Hex(joined)).slice(0, 32);
  const variantNibble = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const u = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variantNibble}${hex.slice(17, 32)}`;
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}

const sessionPk = (source: AgentSource, vendorSessionId: string): Promise<string> =>
  hashToUuid([source, vendorSessionId]);

/** Codex has no vendor message id, so it falls back to the positional turn index (ADR "Identity"). */
const messagePk = (
  source: AgentSource,
  vendorSessionId: string,
  vendorMessageId: string | null,
  turnIndex: number,
): Promise<string> => hashToUuid([source, vendorSessionId, vendorMessageId ?? `turn:${turnIndex}`]);

/** `tool_use_id` is the key; when absent, substitute (vendor message id, block index). */
const toolUsePk = (
  source: AgentSource,
  vendorSessionId: string,
  toolUseId: string | null,
  vendorMessageId: string | null,
  blockIndex: number,
): Promise<string> =>
  hashToUuid([
    source,
    vendorSessionId,
    toolUseId ?? `block:${vendorMessageId ?? ''}:${blockIndex}`,
  ]);

const fileEventPk = (
  source: AgentSource,
  vendorSessionId: string,
  vendorMessageId: string | null,
  normalizedRepoPath: string,
  operation: string,
  blockIndex: number,
): Promise<string> =>
  hashToUuid([
    source,
    vendorSessionId,
    vendorMessageId ?? '',
    normalizedRepoPath,
    operation,
    blockIndex,
  ]);

const capabilitySnapshotPk = (
  source: AgentSource,
  vendorSessionId: string,
  sourceSnapshotId: string | null,
  stableTurnIndex: number,
): Promise<string> =>
  hashToUuid([source, vendorSessionId, sourceSnapshotId ?? `turn:${stableTurnIndex}`]);

const pullRequestLinkPk = (
  source: AgentSource,
  vendorSessionId: string,
  sourceEventId: string | null,
  stableTurnIndex: number,
  url: string,
): Promise<string> =>
  hashToUuid([source, vendorSessionId, sourceEventId ?? `turn:${stableTurnIndex}`, url]);

const reviewUnitAttributionPk = (
  source: AgentSource,
  vendorSessionId: string,
  ruleVersion: string,
  decisionSignature: string,
): Promise<string> => hashToUuid([source, vendorSessionId, ruleVersion, decisionSignature]);

/**
 * `repo_fingerprint = hash(normalized remote)`, falling back to a normalized path hash stamped
 * `repo_source = 'path'` (Provisional Repo) when no remote resolved. Hashing lives here, in one
 * place (ADR "Identity").
 */
export async function repoFingerprint(
  normalizedGitRemote: string,
  repoPathFallback: string,
): Promise<{ fingerprint: string; repoSource: RepoSource }> {
  if (normalizedGitRemote) {
    return { fingerprint: await hashToUuid(['remote', normalizedGitRemote]), repoSource: 'remote' };
  }
  return { fingerprint: await hashToUuid(['path', repoPathFallback]), repoSource: 'path' };
}

interface SessionIdentity {
  sessionPk: string;
  fingerprint: string;
  repoSource: RepoSource;
  remote: string;
  gitBranch: string;
}

/**
 * Stamps every fact with its `session_pk`, row `*_pk`, `repo_fingerprint`, and `repo_source`.
 * Session-grain attribution (the git remote) rides on the message spine and is read once per
 * `vendor_session_id`, then applied to all of that session's facts across the five arrays.
 */
export async function assembleQueueFacts(
  facts: AgentIngestFacts,
  source: AgentSource,
): Promise<{ queueFacts: AgentIngestQueueFacts; sessionPks: string[] }> {
  const attribution = new Map<string, { remote: string; path: string; gitBranch: string }>();
  for (const m of facts.messages) {
    if (!attribution.has(m.vendor_session_id)) {
      attribution.set(m.vendor_session_id, {
        remote: m.normalized_git_remote,
        path: m.repo_path_fallback,
        gitBranch: m.git_branch,
      });
    }
  }
  // Sessions present only in non-message arrays still need an identity (no remote → path fallback).
  for (const f of [
    ...facts.tool_events,
    ...facts.file_events,
    ...facts.capability_snapshots,
    ...facts.pull_request_links,
  ]) {
    if (!attribution.has(f.vendor_session_id)) {
      attribution.set(f.vendor_session_id, { remote: '', path: '', gitBranch: '' });
    }
  }

  const identity = new Map<string, SessionIdentity>();
  for (const [vsid, attr] of attribution) {
    const [pk, fp] = await Promise.all([
      sessionPk(source, vsid),
      repoFingerprint(attr.remote, attr.path),
    ]);
    identity.set(vsid, {
      sessionPk: pk,
      fingerprint: fp.fingerprint,
      repoSource: fp.repoSource,
      remote: attr.remote,
      gitBranch: attr.gitBranch,
    });
  }
  const idOf = (vsid: string): SessionIdentity => {
    const i = identity.get(vsid);
    if (!i) throw new Error(`missing session identity for ${vsid}`);
    return i;
  };

  const messages = await Promise.all(
    facts.messages.map(async (m) => {
      const i = idOf(m.vendor_session_id);
      return {
        ...m,
        session_pk: i.sessionPk,
        message_pk: await messagePk(source, m.vendor_session_id, m.vendor_message_id, m.turn_index),
        repo_fingerprint: i.fingerprint,
        repo_source: i.repoSource,
      };
    }),
  );
  const tool_events = await Promise.all(
    facts.tool_events.map(async (t) => {
      const i = idOf(t.vendor_session_id);
      return {
        ...t,
        session_pk: i.sessionPk,
        tool_use_pk: await toolUsePk(
          source,
          t.vendor_session_id,
          t.tool_use_id,
          t.vendor_message_id,
          t.source_block_index,
        ),
        repo_fingerprint: i.fingerprint,
        repo_source: i.repoSource,
      };
    }),
  );
  const file_events = await Promise.all(
    facts.file_events.map(async (f) => {
      const i = idOf(f.vendor_session_id);
      return {
        ...f,
        session_pk: i.sessionPk,
        file_event_pk: await fileEventPk(
          source,
          f.vendor_session_id,
          f.vendor_message_id,
          f.normalized_repo_path,
          f.operation,
          f.source_block_index,
        ),
        repo_fingerprint: i.fingerprint,
        repo_source: i.repoSource,
      };
    }),
  );
  const capability_snapshots = await Promise.all(
    facts.capability_snapshots.map(async (c) => {
      const i = idOf(c.vendor_session_id);
      return {
        ...c,
        session_pk: i.sessionPk,
        capability_snapshot_pk: await capabilitySnapshotPk(
          source,
          c.vendor_session_id,
          c.source_snapshot_id,
          c.stable_turn_index,
        ),
        repo_fingerprint: i.fingerprint,
        repo_source: i.repoSource,
      };
    }),
  );
  const pull_request_links = await Promise.all(
    facts.pull_request_links.map(async (p) => {
      const i = idOf(p.vendor_session_id);
      return {
        ...p,
        session_pk: i.sessionPk,
        pull_request_link_pk: await pullRequestLinkPk(
          source,
          p.vendor_session_id,
          p.source_event_id,
          p.stable_turn_index,
          p.url,
        ),
        repo_fingerprint: i.fingerprint,
        repo_source: i.repoSource,
      };
    }),
  );

  const queueFacts: AgentIngestQueueFacts = {
    messages,
    tool_events,
    file_events,
    capability_snapshots,
    pull_request_links,
    review_unit_attributions: await buildReviewUnitAttributions(
      source,
      identity,
      pull_request_links,
    ),
  };

  const sessionPks = [...new Set([...identity.values()].map((i) => i.sessionPk))];
  return { queueFacts, sessionPks };
}

async function buildReviewUnitAttributions(
  source: AgentSource,
  identities: Map<string, SessionIdentity>,
  links: AgentPullRequestLinkQueueFact[],
): Promise<AgentReviewUnitAttributionQueueFact[]> {
  const bySession = new Map<string, AgentPullRequestLinkQueueFact[]>();
  for (const link of links) {
    const rows = bySession.get(link.vendor_session_id) ?? [];
    rows.push(link);
    bySession.set(link.vendor_session_id, rows);
  }

  return Promise.all(
    [...bySession.entries()].map(async ([vendorSessionId, sessionLinks]) => {
      const identity = identities.get(vendorSessionId);
      if (!identity) {
        throw new Error(`missing session identity for ${vendorSessionId}`);
      }
      const distinct = distinctReviewLinks(sessionLinks);
      const decidedAt = Math.max(...sessionLinks.map((link) => link.event_at));
      const only = distinct.length === 1 ? distinct[0] : undefined;
      const remote = identity.remote.toLowerCase();
      const matchesRemote = Boolean(only && remote && reviewRepoIdentity(only) === remote);
      const status =
        distinct.length !== 1 ? 'ambiguous' : matchesRemote ? 'attributed' : 'rejected';
      const ambiguityReason =
        distinct.length !== 1
          ? 'multiple_review_units'
          : !remote
            ? 'missing_remote'
            : matchesRemote
              ? ''
              : 'repo_mismatch';
      const evidencePullRequestLinkPk = only?.pull_request_link_pk ?? '';
      const decisionSignature = reviewUnitDecisionSignature(
        remote,
        distinct,
        status,
        ambiguityReason,
        identity.fingerprint,
        identity.repoSource,
        identity.gitBranch,
        evidencePullRequestLinkPk,
        decidedAt,
      );

      return {
        session_pk: identity.sessionPk,
        review_unit_attribution_pk: await reviewUnitAttributionPk(
          source,
          vendorSessionId,
          DIRECT_LINK_RULE_VERSION,
          decisionSignature,
        ),
        repo_fingerprint: identity.fingerprint,
        repo_source: identity.repoSource,
        vendor_session_id: vendorSessionId,
        decided_at: decidedAt,
        review_unit_key: only ? reviewUnitKey(only) : '',
        review_url: only?.url ?? '',
        review_host: only?.host ?? '',
        review_owner: only?.owner ?? '',
        review_repo: only?.repo ?? '',
        review_number: only?.number ?? 0,
        git_branch: identity.gitBranch,
        attribution_method: 'direct_link',
        confidence: status === 'attributed' ? 'high' : 'low',
        status,
        ambiguity_reason: ambiguityReason,
        evidence_pull_request_link_pk: evidencePullRequestLinkPk,
        rule_version: DIRECT_LINK_RULE_VERSION,
      };
    }),
  );
}

function distinctReviewLinks(
  links: AgentPullRequestLinkQueueFact[],
): AgentPullRequestLinkQueueFact[] {
  const byUrl = new Map<string, AgentPullRequestLinkQueueFact>();
  for (const link of links) {
    if (!byUrl.has(link.url)) {
      byUrl.set(link.url, link);
    }
  }
  return [...byUrl.values()];
}

function reviewRepoIdentity(link: AgentPullRequestLinkQueueFact): string {
  return `${link.host}/${link.owner}/${link.repo}`.toLowerCase();
}

function reviewUnitKey(link: AgentPullRequestLinkQueueFact): string {
  return `hosted:${link.host}/${link.owner}/${link.repo}:${reviewKind(link.url)}:${link.number}`;
}

function reviewUnitDecisionSignature(
  remote: string,
  links: AgentPullRequestLinkQueueFact[],
  status: AgentReviewUnitAttributionQueueFact['status'],
  ambiguityReason: string,
  repoFingerprint: string,
  repoSource: RepoSource,
  gitBranch: string,
  evidencePullRequestLinkPk: string,
  decidedAt: number,
): string {
  return [
    remote,
    repoFingerprint,
    repoSource,
    gitBranch,
    status,
    ambiguityReason,
    evidencePullRequestLinkPk,
    decidedAt,
    ...links.map((link) => link.url).sort(),
  ].join('\x1f');
}

function reviewKind(url: string): string {
  if (url.includes('/-/merge_requests/')) return 'merge_request';
  return 'pull_request';
}
