import type { Logger } from '@trace-flow/logging';
import { parseArchiveWrappedKeyVersion } from '@trace-flow/utils';
import type { ArchiveApiEnv } from './context';
import { assertIdentifier } from './archive-contract';

export const ARCHIVE_SUPPORTED_SOURCES = ['claude', 'codex'] as const;
export type ArchiveSupportedSource = (typeof ARCHIVE_SUPPORTED_SOURCES)[number];

export type ArchiveWriteDenialReason =
  | 'server_disabled'
  | 'not_activated'
  | 'not_enrolled'
  | 'enrollment_invalid'
  | 'credential_revoked'
  | 'not_pro'
  | 'frozen'
  | 'deleting'
  | 'source_unauthorized'
  | 'policy_unavailable';

export interface ArchiveWriteAllowed {
  allowed: true;
  enrollmentId: string;
  contributionId: string;
  orgId: string;
  userId: string;
  collectorId: string;
  collectorCredentialId: string;
}

export function assertArchiveWriteIdentity(decision: ArchiveWriteAllowed): void {
  assertIdentifier(decision.enrollmentId, 'invalid_policy_identity');
  assertIdentifier(decision.contributionId, 'invalid_policy_identity');
  assertIdentifier(decision.orgId, 'invalid_policy_identity');
  assertIdentifier(decision.userId, 'invalid_policy_identity');
  assertIdentifier(decision.collectorId, 'invalid_policy_identity');
  assertIdentifier(decision.collectorCredentialId, 'invalid_policy_identity');
}

export interface ArchiveWrappedKey {
  keyVersion: number;
  wrappedKey: string;
}

export type ArchiveWriteDecision =
  | ArchiveWriteAllowed
  | { allowed: false; reason: ArchiveWriteDenialReason };

const POLICY_FRESH_TTL_MS = 60_000;
const POLICY_TIMEOUT_MS = 5000;

interface CachedDecision {
  key: string;
  decision: ArchiveWriteDecision;
  fetchedAt: number;
}

let cached: CachedDecision | null = null;

export function __resetArchivePolicyCache(): void {
  cached = null;
}

export function isArchiveSupportedSource(
  value: string | undefined,
): value is ArchiveSupportedSource {
  return value === 'claude' || value === 'codex';
}

function cacheKey(input: {
  hashedSecret: string;
  source: ArchiveSupportedSource;
  orgId: string;
  userId: string;
  collectorId: string;
}): string {
  return `${input.hashedSecret}:${input.source}:${input.orgId}:${input.userId}:${input.collectorId}`;
}

function currentCache(key: string, now = Date.now()): ArchiveWriteDecision | null {
  if (cached?.key !== key) return null;
  if (now - cached.fetchedAt >= POLICY_FRESH_TTL_MS) return null;
  return cached.decision;
}

function isArchiveWriteDecision(value: unknown): value is ArchiveWriteDecision {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.allowed === true) {
    return (
      typeof v.enrollmentId === 'string' &&
      typeof v.contributionId === 'string' &&
      typeof v.orgId === 'string' &&
      typeof v.userId === 'string' &&
      typeof v.collectorId === 'string' &&
      typeof v.collectorCredentialId === 'string'
    );
  }
  if (v.allowed === false) {
    return typeof v.reason === 'string';
  }
  return false;
}

/**
 * Live Convex enrollment check. Unenrollment / revocation / member removal win
 * because Convex is consulted on every request when reachable.
 *
 * The cache is deny-only. Cached `allowed: true` is never upload commit
 * authority: an allow must be a current Convex decision at this boundary.
 * Cached denials may be reused when Convex is unavailable. Every other policy
 * outage fails closed.
 */
export async function authorizeArchiveUpload(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: {
    hashedSecret: string;
    source: ArchiveSupportedSource;
    orgId: string;
    userId: string;
    collectorId: string;
  },
  logger: Logger,
): Promise<ArchiveWriteDecision> {
  const key = cacheKey(input);

  try {
    const res = await fetch(`${env.CONVEX_SITE_URL}/archive-api/authorize-write`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hashedSecret: input.hashedSecret,
        source: input.source,
        orgId: input.orgId,
        userId: input.userId,
        collectorId: input.collectorId,
      }),
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error('archive_api.policy_fetch_failed', undefined, { status: res.status });
      return degradeOrFail(key, logger);
    }
    const parsed: unknown = await res.json();
    if (!isArchiveWriteDecision(parsed)) {
      logger.error('archive_api.policy_malformed');
      return degradeOrFail(key, logger);
    }
    rememberDenial(key, parsed);
    return parsed;
  } catch (err) {
    logger.error('archive_api.policy_fetch_error', err);
    return degradeOrFail(key, logger);
  }
}

export async function getArchiveWrappedKey(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: { orgId: string; keyVersion: number },
  logger: Logger,
): Promise<ArchiveWrappedKey> {
  try {
    const response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/key`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(POLICY_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error('archive_api.key_fetch_failed', undefined, { status: response.status });
      throw new Error('archive_key_unavailable');
    }
    const parsed = await response.json<Record<string, unknown>>();
    if (typeof parsed.wrappedKey !== 'string' || parsed.keyVersion !== input.keyVersion) {
      throw new Error('archive_key_malformed');
    }
    parseArchiveWrappedKeyVersion(parsed.wrappedKey, input);
    return { keyVersion: input.keyVersion, wrappedKey: parsed.wrappedKey };
  } catch (error) {
    logger.error('archive_api.key_fetch_error', error);
    throw new Error('archive_key_unavailable');
  }
}

function rememberDenial(key: string, decision: ArchiveWriteDecision): void {
  if (decision.allowed === false) {
    cached = { key, decision, fetchedAt: Date.now() };
    return;
  }
  if (cached?.key === key) {
    cached = null;
  }
}

function degradeOrFail(key: string, logger: Logger): ArchiveWriteDecision {
  const decision = currentCache(key);
  if (decision?.allowed === false) {
    logger.warn('archive_api.policy_degraded', { cached: true, reason: decision.reason });
    return decision;
  }
  logger.error('archive_api.policy_unavailable');
  return { allowed: false, reason: 'policy_unavailable' };
}
