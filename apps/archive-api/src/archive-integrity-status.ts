import type { ArchiveIntegrityErrorClass } from '@trace-flow/types';
import type { ArchiveApiEnv } from './context';
import type { ArchiveScope } from './archive-contract';

export interface ArchiveIntegrityStatusUpdate {
  collectorCredentialId: string;
  source: ArchiveScope['source'];
  sourceSessionId: string;
  errorClass: ArchiveIntegrityErrorClass;
}

export interface ArchiveRepairStatusUpdate {
  orgId: string;
  userId: string;
  contributionId: string;
  source: ArchiveScope['source'];
  sourceSessionId: string;
  repairOutcome: 'failure' | 'success';
}

const STATUS_TIMEOUT_MS = 5000;

export async function publishArchiveIntegrityStatus(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  update: ArchiveIntegrityStatusUpdate,
): Promise<void> {
  const response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/session-integrity`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('archive_integrity_status_publication_failed');
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    (body as { source?: unknown }).source !== update.source ||
    (body as { sourceSessionId?: unknown }).sourceSessionId !== update.sourceSessionId ||
    (body as { errorClass?: unknown }).errorClass !== update.errorClass
  ) {
    throw new Error('archive_integrity_status_publication_malformed');
  }
}

export async function publishArchiveRepairStatus(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  update: ArchiveRepairStatusUpdate,
): Promise<void> {
  const response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/session-integrity`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('archive_integrity_status_publication_failed');
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    (body as { contributionId?: unknown }).contributionId !== update.contributionId ||
    (body as { source?: unknown }).source !== update.source ||
    (body as { sourceSessionId?: unknown }).sourceSessionId !== update.sourceSessionId ||
    (body as { repairOutcome?: unknown }).repairOutcome !== update.repairOutcome ||
    (update.repairOutcome === 'success' &&
      (body as { errorClass?: unknown }).errorClass !== undefined)
  ) {
    throw new Error('archive_integrity_status_publication_malformed');
  }
}
