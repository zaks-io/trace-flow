import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const ARCHIVE_USER_AUDIT_ACTIONS = ['activation', 'enrollment', 'revocation'] as const;
export type ArchiveUserAuditAction = (typeof ARCHIVE_USER_AUDIT_ACTIONS)[number];

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

export const ARCHIVE_AUDIT_ACTIONS = [
  ...ARCHIVE_USER_AUDIT_ACTIONS,
  ...ARCHIVE_API_AUDIT_ACTIONS,
] as const;
export type ArchiveAuditAction = (typeof ARCHIVE_AUDIT_ACTIONS)[number];

export const ARCHIVE_AUDIT_OUTCOMES = ['success', 'failure'] as const;
export type ArchiveAuditOutcome = (typeof ARCHIVE_AUDIT_OUTCOMES)[number];

export const ARCHIVE_AUDIT_ACTOR_KINDS = ['user', 'archive_api', 'operator'] as const;
export type ArchiveAuditActorKind = (typeof ARCHIVE_AUDIT_ACTOR_KINDS)[number];

export const ARCHIVE_AUDIT_TARGET_KINDS = [
  'activation',
  'enrollment',
  'contribution',
  'export',
  'archive',
  'encryption_key',
  'session',
] as const;
export type ArchiveAuditTargetKind = (typeof ARCHIVE_AUDIT_TARGET_KINDS)[number];

export const ARCHIVE_AUDIT_OPERATION_ID_MAX_LENGTH = 256;
export const ARCHIVE_AUDIT_TARGET_ID_MAX_LENGTH = 256;
export const ARCHIVE_AUDIT_MANIFEST_ROOT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const ARCHIVE_AUDIT_FORBIDDEN_FIELD_NAMES = [
  'transcript',
  'transcripts',
  'content',
  'command',
  'commands',
  'path',
  'paths',
  'localPath',
  'absolutePath',
  'secret',
  'secrets',
  'payload',
  'payloads',
  'ciphertext',
  'plaintext',
  'decrypted',
  'chunk',
  'chunks',
  'body',
  'bodies',
] as const;

export const ARCHIVE_AUDIT_FORBIDDEN_EVENT_TYPES = [
  'chunk_upload',
  'chunk_download',
  'upload',
  'download',
  'chunk',
] as const;

export const ARCHIVE_AUDIT_CALLER_SUBSTITUTION_FIELDS = [
  'actor',
  'actorUserId',
  'actorKind',
  'orgId',
  'occurredAt',
  'timestamp',
  'serverTime',
] as const;

export const ARCHIVE_AUDIT_ALLOWED_INPUT_KEYS = [
  'binding',
  'expectedOrgId',
  'action',
  'outcome',
  'operationId',
  'targetKind',
  'targetId',
  'relevantCount',
  'manifestRootHash',
  'source',
  'sourceSessionId',
] as const;

export interface ArchiveAuditEventRecord {
  orgId: string;
  actorKind: ArchiveAuditActorKind;
  actorUserId?: string;
  action: ArchiveAuditAction;
  outcome: ArchiveAuditOutcome;
  occurredAt: number;
  operationId: string;
  targetKind?: ArchiveAuditTargetKind;
  targetId?: string;
  enrollmentId?: string;
  contributionId?: string;
  activationId?: string;
  source?: 'claude' | 'codex';
  sourceSessionId?: string;
  relevantCount?: number;
  manifestRootHash?: string;
}

export function isArchiveAuditAction(value: unknown): value is ArchiveAuditAction {
  return typeof value === 'string' && (ARCHIVE_AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isArchiveApiAuditAction(value: unknown): value is ArchiveApiAuditAction {
  return (
    typeof value === 'string' && (ARCHIVE_API_AUDIT_ACTIONS as readonly string[]).includes(value)
  );
}

export function actorKindForApiAction(action: ArchiveApiAuditAction): 'archive_api' | 'operator' {
  return action === 'operator_repair_attempt' || action === 'operator_repair_outcome'
    ? 'operator'
    : 'archive_api';
}

export function activationOperationId(orgId: string): string {
  return `activation:${orgId}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function enrollmentOperationId(
  orgId: string,
  idempotencyKey: string,
): Promise<string> {
  return `enrollment:${orgId}:${await sha256Hex(idempotencyKey)}`;
}

export function revocationOperationId(enrollmentId: string): string {
  return `revocation:${enrollmentId}`;
}

function assertNoPathOrSecretShape(label: string, value: string): void {
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error(`${label} must not contain a path`);
  }
  if (value.includes(':') && (value.includes('secret') || value.includes('token'))) {
    throw new Error(`${label} must not contain a secret`);
  }
}

export function validateAuditOperationId(operationId: string): string {
  if (operationId.trim().length === 0) {
    throw new Error('Audit operation identity is required');
  }
  if (operationId !== operationId.trim()) {
    throw new Error('Audit operation identity must not include leading or trailing whitespace');
  }
  if (operationId.length > ARCHIVE_AUDIT_OPERATION_ID_MAX_LENGTH) {
    throw new Error('Audit operation identity is too long');
  }
  if (operationId.includes('/') || operationId.includes('\\')) {
    throw new Error('Audit operation identity must not contain a path');
  }
  return operationId;
}

export function validateAuditTargetId(targetId: string): string {
  if (targetId.trim().length === 0) {
    throw new Error('Audit target identity is required');
  }
  if (targetId !== targetId.trim()) {
    throw new Error('Audit target identity must not include leading or trailing whitespace');
  }
  if (targetId.length > ARCHIVE_AUDIT_TARGET_ID_MAX_LENGTH) {
    throw new Error('Audit target identity is too long');
  }
  assertNoPathOrSecretShape('Audit target identity', targetId);
  return targetId;
}

export function validateManifestRootHash(hash: string): string {
  if (!ARCHIVE_AUDIT_MANIFEST_ROOT_HASH_PATTERN.test(hash)) {
    throw new Error('Manifest root hash must be a 64-character lowercase hex digest');
  }
  return hash;
}

export function validateRelevantCount(count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('Audit relevant count must be a non-negative integer');
  }
  return count;
}

export function rejectForbiddenAuditFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if ((ARCHIVE_AUDIT_FORBIDDEN_FIELD_NAMES as readonly string[]).includes(key)) {
      throw new Error(`Archive audit events cannot store ${key}`);
    }
  }
}

export function rejectCallerSubstitutionFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if ((ARCHIVE_AUDIT_CALLER_SUBSTITUTION_FIELDS as readonly string[]).includes(key)) {
      throw new Error('Caller-supplied actor or tenant substitution is not allowed');
    }
  }
}

export function rejectUnknownAuditAction(action: unknown): asserts action is ArchiveAuditAction {
  if (
    typeof action === 'string' &&
    (ARCHIVE_AUDIT_FORBIDDEN_EVENT_TYPES as readonly string[]).includes(action)
  ) {
    throw new Error('Per-chunk archive audit events are not recorded');
  }
  if (!isArchiveAuditAction(action)) {
    throw new Error('Unknown archive audit event type');
  }
}

export function serializeArchiveApiAuditInput(input: Record<string, unknown>): {
  binding: Record<string, unknown>;
  expectedOrgId?: string;
  action: ArchiveApiAuditAction;
  outcome: ArchiveAuditOutcome;
  operationId: string;
  targetKind?: ArchiveAuditTargetKind;
  targetId?: string;
  relevantCount?: number;
  manifestRootHash?: string;
  source?: 'claude' | 'codex';
  sourceSessionId?: string;
} {
  rejectForbiddenAuditFields(input);
  rejectCallerSubstitutionFields(input);

  for (const key of Object.keys(input)) {
    if (!(ARCHIVE_AUDIT_ALLOWED_INPUT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown archive audit field: ${key}`);
    }
  }

  rejectUnknownAuditAction(input.action);
  if (!isArchiveApiAuditAction(input.action)) {
    throw new Error('Unknown archive audit event type');
  }
  if (input.outcome !== 'success' && input.outcome !== 'failure') {
    throw new Error('Unknown archive audit outcome');
  }
  if (typeof input.operationId !== 'string') {
    throw new Error('Audit operation identity is required');
  }
  if (typeof input.binding !== 'object' || input.binding === null || Array.isArray(input.binding)) {
    throw new Error('Audit binding is required');
  }

  const serialized: ReturnType<typeof serializeArchiveApiAuditInput> = {
    binding: input.binding as Record<string, unknown>,
    action: input.action,
    outcome: input.outcome,
    operationId: validateAuditOperationId(input.operationId),
  };

  if (input.expectedOrgId !== undefined) {
    if (typeof input.expectedOrgId !== 'string') {
      throw new Error('Caller-supplied actor or tenant substitution is not allowed');
    }
    serialized.expectedOrgId = input.expectedOrgId;
  }
  if (input.targetKind !== undefined) {
    if (!(ARCHIVE_AUDIT_TARGET_KINDS as readonly string[]).includes(input.targetKind as string)) {
      throw new Error('Unknown archive audit target kind');
    }
    serialized.targetKind = input.targetKind as ArchiveAuditTargetKind;
  }
  if (input.targetId !== undefined) {
    if (typeof input.targetId !== 'string') {
      throw new Error('Audit target identity is required');
    }
    serialized.targetId = validateAuditTargetId(input.targetId);
  }
  if (input.relevantCount !== undefined) {
    if (typeof input.relevantCount !== 'number') {
      throw new Error('Audit relevant count must be a non-negative integer');
    }
    serialized.relevantCount = validateRelevantCount(input.relevantCount);
  }
  if (input.manifestRootHash !== undefined) {
    if (typeof input.manifestRootHash !== 'string') {
      throw new Error('Manifest root hash must be a 64-character lowercase hex digest');
    }
    serialized.manifestRootHash = validateManifestRootHash(input.manifestRootHash);
  }
  if (input.source !== undefined) {
    if (input.source !== 'claude' && input.source !== 'codex') {
      throw new Error('Unknown archive audit source');
    }
    serialized.source = input.source;
  }
  if (input.sourceSessionId !== undefined) {
    if (typeof input.sourceSessionId !== 'string') {
      throw new Error('Audit source session identity is required');
    }
    serialized.sourceSessionId = validateAuditTargetId(input.sourceSessionId);
  }

  return serialized;
}

export function decideAuditAppend(input: {
  existingSuccess: { action: string } | null;
  incoming: { action: string; outcome: ArchiveAuditOutcome };
}): 'append' | 'replay' {
  if (input.incoming.outcome === 'failure') return 'append';
  if (input.existingSuccess?.action === input.incoming.action) {
    return 'replay';
  }
  return 'append';
}

export function isArchiveAuditEventVisibleToMember(input: {
  viewerUserId: string;
  actorUserId?: string;
  enrollmentUserId?: string;
  contributionUserId?: string;
}): boolean {
  return (
    input.actorUserId === input.viewerUserId ||
    input.enrollmentUserId === input.viewerUserId ||
    input.contributionUserId === input.viewerUserId
  );
}

export async function appendArchiveAuditEvent(
  ctx: MutationCtx,
  event: {
    orgId: Id<'organizations'>;
    actorKind: ArchiveAuditActorKind;
    actorUserId?: Id<'users'>;
    action: ArchiveAuditAction;
    outcome: ArchiveAuditOutcome;
    operationId: string;
    targetKind?: ArchiveAuditTargetKind;
    targetId?: string;
    enrollmentId?: Id<'archiveEnrollments'>;
    contributionId?: Id<'archiveContributions'>;
    activationId?: Id<'archiveActivations'>;
    source?: 'claude' | 'codex';
    sourceSessionId?: string;
    relevantCount?: number;
    manifestRootHash?: string;
    now?: number;
  },
): Promise<{ eventId: Id<'archiveAuditEvents'>; created: boolean }> {
  const operationId = validateAuditOperationId(event.operationId);
  const now = event.now ?? Date.now();
  const idempotentOutcome = event.action === 'integrity_failure' ? event.outcome : 'success';
  const existingIdempotentEvent = await ctx.db
    .query('archiveAuditEvents')
    .withIndex('by_org_operation_action_outcome', (q) =>
      q
        .eq('orgId', event.orgId)
        .eq('operationId', operationId)
        .eq('action', event.action)
        .eq('outcome', idempotentOutcome),
    )
    .first();

  const decision = decideAuditAppend({
    existingSuccess: existingIdempotentEvent ? { action: existingIdempotentEvent.action } : null,
    incoming: { action: event.action, outcome: event.outcome },
  });
  if (existingIdempotentEvent && (decision === 'replay' || event.action === 'integrity_failure')) {
    return { eventId: existingIdempotentEvent._id, created: false };
  }

  const eventId = await ctx.db.insert('archiveAuditEvents', {
    orgId: event.orgId,
    actorKind: event.actorKind,
    actorUserId: event.actorUserId,
    action: event.action,
    outcome: event.outcome,
    occurredAt: now,
    operationId,
    targetKind: event.targetKind,
    targetId: event.targetId,
    enrollmentId: event.enrollmentId,
    contributionId: event.contributionId,
    activationId: event.activationId,
    source: event.source,
    sourceSessionId: event.sourceSessionId,
    relevantCount: event.relevantCount,
    manifestRootHash: event.manifestRootHash,
  });
  return { eventId, created: true };
}
