import type { Logger } from '@trace-flow/logging';
import type { ArchiveApiEnv } from './context';

export const ARCHIVE_API_AUDIT_ACTIONS = [
  'export_grant_issuance',
  'export_completed',
  'export_failed',
  'deletion',
  'key_rotation',
  'integrity_failure',
  'operator_repair_attempt',
  'operator_repair_outcome',
] as const;
export type ArchiveApiAuditAction = (typeof ARCHIVE_API_AUDIT_ACTIONS)[number];

export type ArchiveAuditOutcome = 'success' | 'failure';

export type ArchiveAuditBinding =
  | { kind: 'activation'; activationId: string }
  | { kind: 'enrollment'; enrollmentId: string }
  | { kind: 'contribution'; contributionId: string }
  | { kind: 'collector_credential'; collectorCredentialId: string };

export interface ArchiveAuditAppendRequest {
  binding: ArchiveAuditBinding;
  expectedOrgId?: string;
  action: ArchiveApiAuditAction;
  outcome: ArchiveAuditOutcome;
  operationId: string;
  targetKind?:
    | 'activation'
    | 'enrollment'
    | 'contribution'
    | 'export'
    | 'archive'
    | 'encryption_key'
    | 'session';
  targetId?: string;
  relevantCount?: number;
  manifestRootHash?: string;
  source?: 'claude' | 'codex';
  sourceSessionId?: string;
}

export interface ArchiveAuditAppendResult {
  eventId: string;
  created: boolean;
}

const AUDIT_TIMEOUT_MS = 5000;

const FORBIDDEN_EVENT_TYPES = [
  'chunk_upload',
  'chunk_download',
  'upload',
  'download',
  'chunk',
] as const;

const FORBIDDEN_FIELDS = [
  'transcript',
  'transcripts',
  'content',
  'command',
  'commands',
  'path',
  'paths',
  'localPath',
  'secret',
  'secrets',
  'payload',
  'payloads',
  'ciphertext',
  'actor',
  'actorUserId',
  'actorKind',
  'orgId',
  'occurredAt',
  'timestamp',
] as const;

export function assertArchiveAuditRequest(
  input: ArchiveAuditAppendRequest,
): ArchiveAuditAppendRequest {
  for (const key of Object.keys(input)) {
    if ((FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      throw new Error('Caller-supplied actor, tenant, or transcript fields are not allowed');
    }
  }
  if ((FORBIDDEN_EVENT_TYPES as readonly string[]).includes(input.action)) {
    throw new Error('Per-chunk archive audit events are not recorded');
  }
  if (!(ARCHIVE_API_AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error('Unknown archive audit event type');
  }
  return input;
}

/**
 * Posts one metadata-only semantic Archive Audit Event through the authenticated
 * Convex internal seam. Actor, Organization, and server time are derived by Convex.
 */
export async function appendArchiveAuditEvent(
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  input: ArchiveAuditAppendRequest,
  logger: Logger,
): Promise<ArchiveAuditAppendResult> {
  const body = assertArchiveAuditRequest(input);
  const res = await fetch(`${env.CONVEX_SITE_URL}/archive-api/audit-events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ARCHIVE_API_SHARED_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
  });
  if (!res.ok) {
    logger.error('archive_api.audit_append_failed', undefined, { status: res.status });
    throw new Error('Failed to append archive audit event');
  }
  const parsed: unknown = await res.json();
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { eventId?: unknown }).eventId !== 'string' ||
    typeof (parsed as { created?: unknown }).created !== 'boolean'
  ) {
    logger.error('archive_api.audit_append_malformed');
    throw new Error('Failed to append archive audit event');
  }
  return parsed as ArchiveAuditAppendResult;
}
