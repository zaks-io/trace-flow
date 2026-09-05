import type { ArchiveApiEnv } from './context';

export interface ArchiveStatusUpdate {
  orgId: string;
  revision: number;
  storedBytes: number;
  lifecycle: 'active' | 'blocked';
  lastDurableAcknowledgedAt?: number;
}

const STATUS_TIMEOUT_MS = 5000;

export function parseArchiveStatusUpdate(value: unknown): ArchiveStatusUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('archive_status_payload_invalid');
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.orgId !== 'string' ||
    body.orgId.length === 0 ||
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 1 ||
    typeof body.storedBytes !== 'number' ||
    !Number.isSafeInteger(body.storedBytes) ||
    body.storedBytes < 0 ||
    (body.lifecycle !== 'active' && body.lifecycle !== 'blocked') ||
    (body.lastDurableAcknowledgedAt !== undefined &&
      (typeof body.lastDurableAcknowledgedAt !== 'number' ||
        !Number.isSafeInteger(body.lastDurableAcknowledgedAt) ||
        body.lastDurableAcknowledgedAt < 0))
  ) {
    throw new Error('archive_status_payload_invalid');
  }
  return {
    orgId: body.orgId,
    revision: body.revision,
    storedBytes: body.storedBytes,
    lifecycle: body.lifecycle,
    ...(body.lastDurableAcknowledgedAt === undefined
      ? {}
      : { lastDurableAcknowledgedAt: body.lastDurableAcknowledgedAt }),
  };
}

export async function publishArchiveStatus(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  update: ArchiveStatusUpdate,
): Promise<{ revision: number; replay: boolean }> {
  const response = await fetch(`${env.CONVEX_SITE_URL}/archive-api/status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('archive_status_publication_failed');

  const body = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('archive_status_publication_malformed');
  }
  const result = body as { revision?: unknown; replay?: unknown };
  if (result.revision !== update.revision || typeof result.replay !== 'boolean') {
    throw new Error('archive_status_publication_malformed');
  }
  return { revision: update.revision, replay: result.replay };
}
