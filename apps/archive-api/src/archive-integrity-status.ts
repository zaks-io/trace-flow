import type { ArchiveApiEnv } from './context';
import type { ArchiveScope } from './archive-contract';

export interface ArchiveIntegrityStatusUpdate {
  collectorCredentialId: string;
  source: ArchiveScope['source'];
  sourceSessionId: string;
  errorClass: string;
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
