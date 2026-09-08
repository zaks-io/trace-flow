import type { Logger } from '@trace-flow/logging';
import { isArchiveCanonicalIdentifier } from '@trace-flow/types';
import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import type { ArchiveAuthorizedSource, CollectorArchivePolicy } from './collector-policy';
import type { ArchiveSupportedSource } from './enrollment';

export type ArchiveHistoryChoice = 'new_only' | 'all_history';

export interface CollectorEnrollmentSource {
  source: ArchiveSupportedSource;
  historyChoice: ArchiveHistoryChoice;
}

export interface CollectorEnrollmentRequest {
  authorizedSources: CollectorEnrollmentSource[];
  idempotencyKey: string;
}

export interface CollectorEnrollmentInput extends CollectorEnrollmentRequest {
  hashedSecret: string;
  orgId: string;
  userId: string;
  collectorId: string;
}

const ENROLLMENT_TIMEOUT_MS = 5000;
const MAX_ENROLLMENT_REQUEST_BYTES = 64 * 1024;

const DENIAL_REASONS = new Set<CollectorArchivePolicy['reason']>([
  'server_disabled',
  'not_activated',
  'not_enrolled',
  'enrollment_invalid',
  'credential_revoked',
  'not_pro',
  'frozen',
  'deleting',
  'source_unauthorized',
]);

const REQUEST_KEYS = ['authorizedSources', 'idempotencyKey'] as const;
const SOURCE_KEYS = ['source', 'historyChoice'] as const;
const ENROLLED_RESPONSE_KEYS = [
  'authorizedSources',
  'collectorCredentialId',
  'collectorId',
  'enrolled',
  'orgId',
  'reason',
  'userId',
] as const;
const DENIED_RESPONSE_KEYS = ['authorizedSources', 'enrolled', 'reason'] as const;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isArchiveHistoryChoice(value: unknown): value is ArchiveHistoryChoice {
  return value === 'new_only' || value === 'all_history';
}

function isArchiveSource(value: unknown): value is ArchiveSupportedSource {
  return value === 'claude' || value === 'codex';
}

function isAuthorizedSource(value: unknown): value is ArchiveAuthorizedSource {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'historyChoice', 'authorizedAt'])) {
    return false;
  }
  return (
    isArchiveSource(value.source) &&
    isArchiveHistoryChoice(value.historyChoice) &&
    typeof value.authorizedAt === 'number' &&
    Number.isSafeInteger(value.authorizedAt) &&
    value.authorizedAt >= 0
  );
}

function isEnrollmentSource(value: unknown): value is CollectorEnrollmentSource {
  return (
    isRecord(value) &&
    hasExactKeys(value, SOURCE_KEYS) &&
    isArchiveSource(value.source) &&
    isArchiveHistoryChoice(value.historyChoice)
  );
}

export function parseCollectorEnrollmentRequest(value: unknown): CollectorEnrollmentRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return null;
  if (
    !Array.isArray(value.authorizedSources) ||
    value.authorizedSources.length === 0 ||
    !value.authorizedSources.every(isEnrollmentSource)
  ) {
    return null;
  }
  const sources = value.authorizedSources;
  if (new Set(sources.map((source) => source.source)).size !== sources.length) return null;
  if (
    typeof value.idempotencyKey !== 'string' ||
    value.idempotencyKey.trim().length === 0 ||
    value.idempotencyKey !== value.idempotencyKey.trim() ||
    value.idempotencyKey.length > 128
  ) {
    return null;
  }
  return { authorizedSources: sources, idempotencyKey: value.idempotencyKey };
}

interface UpstreamEnrollmentSuccess extends RecordValue {
  enrolled: true;
  authorizedSources: ArchiveAuthorizedSource[];
  reason: null;
  orgId: string;
  userId: string;
  collectorId: string;
  collectorCredentialId: string;
}

interface UpstreamEnrollmentDenial extends RecordValue {
  enrolled: false;
  authorizedSources: [];
  reason: Exclude<CollectorArchivePolicy['reason'], null>;
}

type UpstreamEnrollmentResponse = UpstreamEnrollmentSuccess | UpstreamEnrollmentDenial;

function isUpstreamEnrollmentResponse(value: unknown): value is UpstreamEnrollmentResponse {
  if (!isRecord(value)) return false;
  if (value.enrolled === false) {
    return (
      hasExactKeys(value, DENIED_RESPONSE_KEYS) &&
      Array.isArray(value.authorizedSources) &&
      value.authorizedSources.length === 0 &&
      typeof value.reason === 'string' &&
      DENIAL_REASONS.has(value.reason as Exclude<CollectorArchivePolicy['reason'], null>)
    );
  }
  if (
    value.enrolled !== true ||
    !hasExactKeys(value, ENROLLED_RESPONSE_KEYS) ||
    value.reason !== null ||
    !isArchiveCanonicalIdentifier(value.orgId) ||
    !isArchiveCanonicalIdentifier(value.userId) ||
    !isArchiveCanonicalIdentifier(value.collectorId) ||
    !isArchiveCanonicalIdentifier(value.collectorCredentialId) ||
    !Array.isArray(value.authorizedSources) ||
    value.authorizedSources.length === 0 ||
    !value.authorizedSources.every(isAuthorizedSource)
  ) {
    return false;
  }
  if (
    new Set(value.authorizedSources.map((source) => source.source)).size !==
    value.authorizedSources.length
  ) {
    return false;
  }
  return true;
}

function unavailable(): Error {
  return new Error('policy_unavailable');
}

function policyFromResponse(
  response: UpstreamEnrollmentResponse,
  input: CollectorEnrollmentInput,
): CollectorArchivePolicy {
  if (response.enrolled === false) {
    return { enrolled: false, authorizedSources: [], reason: response.reason };
  }
  if (
    response.orgId !== input.orgId ||
    response.userId !== input.userId ||
    response.collectorId !== input.collectorId
  ) {
    throw unavailable();
  }
  return {
    enrolled: true,
    authorizedSources: [...response.authorizedSources].sort((a, b) =>
      a.source.localeCompare(b.source),
    ),
    reason: null,
  };
}

export class CollectorEnrollmentConflictError extends ArchiveContractError {
  constructor() {
    super('consent_conflict');
  }
}

export async function submitCollectorEnrollment(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: CollectorEnrollmentInput,
  logger: Logger,
): Promise<CollectorArchivePolicy> {
  let response: Response;
  try {
    response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/enroll`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hashedSecret: input.hashedSecret,
        authorizedSources: input.authorizedSources,
        idempotencyKey: input.idempotencyKey,
        orgId: input.orgId,
        userId: input.userId,
        collectorId: input.collectorId,
      }),
      signal: AbortSignal.timeout(ENROLLMENT_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error('archive_api.collector_enrollment_unavailable', error);
    throw unavailable();
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    logger.error('archive_api.collector_enrollment_malformed', error, { status: response.status });
    throw unavailable();
  }

  if (response.status === 409) {
    if (isRecord(body) && hasExactKeys(body, ['error']) && body.error === 'consent_conflict') {
      throw new CollectorEnrollmentConflictError();
    }
    logger.error('archive_api.collector_enrollment_malformed', undefined, {
      status: response.status,
    });
    throw unavailable();
  }
  if (!response.ok) {
    logger.error('archive_api.collector_enrollment_upstream_failed', undefined, {
      status: response.status,
    });
    throw unavailable();
  }
  if (!isUpstreamEnrollmentResponse(body)) {
    logger.error('archive_api.collector_enrollment_malformed', undefined, {
      status: response.status,
    });
    throw unavailable();
  }
  return policyFromResponse(body, input);
}

export const COLLECTOR_ENROLLMENT_MAX_REQUEST_BYTES = MAX_ENROLLMENT_REQUEST_BYTES;
