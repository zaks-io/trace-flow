import type { Logger } from '@trace-flow/logging';
import type { ArchiveApiEnv } from './context';
import type { ArchiveSupportedSource, ArchiveWriteDenialReason } from './enrollment';

export interface ArchiveAuthorizedSource {
  source: ArchiveSupportedSource;
  historyChoice: 'new_only' | 'all_history';
  authorizedAt: number;
}

export type CollectorArchivePolicy =
  | { enrolled: true; authorizedSources: ArchiveAuthorizedSource[]; reason: null }
  | { enrolled: false; authorizedSources: []; reason: ArchiveWriteDenialReason };

type PolicyDecision =
  | {
      allowed: true;
      enrollmentId: string;
      contributionId: string;
      orgId: string;
      userId: string;
      collectorId: string;
      collectorCredentialId: string;
      authorizedSources: ArchiveAuthorizedSource[];
    }
  | { allowed: false; reason: ArchiveWriteDenialReason };

const POLICY_TIMEOUT_MS = 5000;
const DENIAL_REASONS = new Set<ArchiveWriteDenialReason>([
  'server_disabled',
  'not_activated',
  'not_enrolled',
  'enrollment_invalid',
  'credential_revoked',
  'not_pro',
  'frozen',
  'deleting',
  'source_unauthorized',
  'policy_unavailable',
]);

function isAuthorizedSource(value: unknown): value is ArchiveAuthorizedSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    (row.source === 'claude' || row.source === 'codex') &&
    (row.historyChoice === 'new_only' || row.historyChoice === 'all_history') &&
    typeof row.authorizedAt === 'number' &&
    Number.isSafeInteger(row.authorizedAt) &&
    row.authorizedAt >= 0
  );
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  if (decision.allowed === false) {
    return (
      typeof decision.reason === 'string' &&
      DENIAL_REASONS.has(decision.reason as ArchiveWriteDenialReason)
    );
  }
  return (
    decision.allowed === true &&
    typeof decision.enrollmentId === 'string' &&
    typeof decision.contributionId === 'string' &&
    typeof decision.orgId === 'string' &&
    typeof decision.userId === 'string' &&
    typeof decision.collectorId === 'string' &&
    typeof decision.collectorCredentialId === 'string' &&
    Array.isArray(decision.authorizedSources) &&
    decision.authorizedSources.length > 0 &&
    decision.authorizedSources.every(isAuthorizedSource)
  );
}

async function fetchSourceDecision(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: {
    hashedSecret: string;
    source: ArchiveSupportedSource;
    orgId: string;
    userId: string;
    collectorId: string;
  },
): Promise<PolicyDecision> {
  const response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/authorize-write`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('policy_unavailable');
  const decision: unknown = await response.json();
  if (!isPolicyDecision(decision)) throw new Error('policy_unavailable');
  if (
    decision.allowed &&
    (decision.orgId !== input.orgId ||
      decision.userId !== input.userId ||
      decision.collectorId !== input.collectorId)
  ) {
    throw new Error('policy_unavailable');
  }
  return decision;
}

export async function fetchCollectorArchivePolicy(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  identity: { hashedSecret: string; orgId: string; userId: string; collectorId: string },
  logger: Logger,
): Promise<CollectorArchivePolicy> {
  let decisions: [PolicyDecision, PolicyDecision];
  try {
    decisions = await Promise.all([
      fetchSourceDecision(env, { ...identity, source: 'claude' }),
      fetchSourceDecision(env, { ...identity, source: 'codex' }),
    ]);
  } catch (error) {
    logger.error('archive_api.collector_policy_unavailable', error);
    throw new Error('policy_unavailable');
  }

  const allowed = decisions.filter(
    (decision): decision is Extract<PolicyDecision, { allowed: true }> => decision.allowed,
  );
  const firstAllowed = allowed[0];
  if (firstAllowed) {
    const authorizedSources = [...firstAllowed.authorizedSources].sort((a, b) =>
      a.source.localeCompare(b.source),
    );
    const uniqueSources = new Set(authorizedSources.map((source) => source.source));
    const allowedSources = new Set<ArchiveSupportedSource>();
    if (decisions[0].allowed) allowedSources.add('claude');
    if (decisions[1].allowed) allowedSources.add('codex');
    const firstSources = JSON.stringify(firstAllowed.authorizedSources);
    if (
      uniqueSources.size !== authorizedSources.length ||
      uniqueSources.size !== allowedSources.size ||
      [...allowedSources].some((source) => !uniqueSources.has(source)) ||
      allowed.some(
        (decision) =>
          decision.enrollmentId !== firstAllowed.enrollmentId ||
          decision.contributionId !== firstAllowed.contributionId ||
          decision.collectorCredentialId !== firstAllowed.collectorCredentialId,
      ) ||
      allowed.some((decision) => JSON.stringify(decision.authorizedSources) !== firstSources)
    ) {
      logger.error('archive_api.collector_policy_malformed');
      throw new Error('policy_unavailable');
    }
    return { enrolled: true, authorizedSources, reason: null };
  }

  const [claudeDecision, codexDecision] = decisions;
  if (claudeDecision.allowed || codexDecision.allowed) {
    logger.error('archive_api.collector_policy_malformed');
    throw new Error('policy_unavailable');
  }
  if (claudeDecision.reason !== codexDecision.reason) {
    logger.error('archive_api.collector_policy_inconsistent');
    throw new Error('policy_unavailable');
  }
  return { enrolled: false, authorizedSources: [], reason: claudeDecision.reason };
}
