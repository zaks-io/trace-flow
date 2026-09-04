import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id, TableNames } from './_generated/dataModel';

export const ARCHIVE_SUPPORTED_SOURCES = ['claude', 'codex'] as const;
export type ArchiveSupportedSource = (typeof ARCHIVE_SUPPORTED_SOURCES)[number];

export const ARCHIVE_HISTORY_CHOICES = ['new_only', 'all_history'] as const;
export type ArchiveHistoryChoice = (typeof ARCHIVE_HISTORY_CHOICES)[number];

export const ARCHIVE_CAP_BYTES = 100 * 1024 * 1024 * 1024;
export const ARCHIVE_GRACE_MS = 90 * 24 * 60 * 60 * 1000;
export const ARCHIVE_ENABLED_ENV = 'CONVERSATION_ARCHIVE_ENABLED';
export const ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type ArchiveEnrollmentStatus = 'active' | 'unenrolled' | 'revoked' | 'member_removed';
export type ArchiveInvalidationReason = 'user_unenrolled' | 'owner_revoked' | 'member_removed';
export type ArchiveActivationStatus = 'active' | 'frozen' | 'deleting';
export type ArchiveLifecycle = 'not_enabled' | 'active' | 'blocked' | 'frozen' | 'deleting';

export type ArchiveWriteDenialReason =
  | 'server_disabled'
  | 'not_activated'
  | 'not_enrolled'
  | 'enrollment_invalid'
  | 'credential_revoked'
  | 'not_pro'
  | 'frozen'
  | 'deleting'
  | 'source_unauthorized';

export type ArchiveEnrollmentDecision =
  | 'create'
  | 'replay'
  | 'renew'
  | 'conflict'
  | 'already_enrolled';

export const ARCHIVE_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export interface ArchiveSourceAuthorizationInput {
  source: ArchiveSupportedSource;
  historyChoice: ArchiveHistoryChoice;
}

export function isArchiveServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARCHIVE_ENABLED_ENV] === 'true';
}

export function isActiveProSubscription(
  subscription: { tier: string; status: string } | null,
): boolean {
  return subscription?.tier === 'pro' && subscription.status === 'active';
}

export function archiveGraceDeadlineAt(now: number): number {
  return now + ARCHIVE_GRACE_MS;
}

export function validateEnrollmentIdempotencyKey(key: string): string {
  if (key.trim().length === 0) {
    throw new Error('Enrollment idempotency key is required');
  }
  if (key !== key.trim()) {
    throw new Error('Enrollment idempotency key must not include leading or trailing whitespace');
  }
  if (key.length > ARCHIVE_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new Error('Enrollment idempotency key is too long');
  }
  return key;
}

export function consentSourcesMatch(
  existing: { source: string; historyChoice: string }[],
  requested: ArchiveSourceAuthorizationInput[],
): boolean {
  if (existing.length !== requested.length) return false;
  const normalize = (rows: { source: string; historyChoice: string }[]) =>
    [...rows]
      .map((row) => `${row.source}:${row.historyChoice}`)
      .sort()
      .join('|');
  return normalize(existing) === normalize(requested);
}

export function decideEnrollmentAction(input: {
  existingByKey: {
    userId: string;
    collectorCredentialId: string;
    consentSources: { source: string; historyChoice: string }[];
  } | null;
  currentEnrollment: { status: ArchiveEnrollmentStatus } | null;
  request: {
    userId: string;
    collectorCredentialId: string;
    authorizedSources: ArchiveSourceAuthorizationInput[];
  };
}): ArchiveEnrollmentDecision {
  if (input.existingByKey) {
    if (
      input.existingByKey.userId !== input.request.userId ||
      input.existingByKey.collectorCredentialId !== input.request.collectorCredentialId
    ) {
      return 'conflict';
    }
    if (!consentSourcesMatch(input.existingByKey.consentSources, input.request.authorizedSources)) {
      return 'conflict';
    }
    return 'replay';
  }
  if (input.currentEnrollment?.status === 'active') return 'already_enrolled';
  if (input.currentEnrollment) return 'renew';
  return 'create';
}

export function validateAuthorizedSources(
  sources: ArchiveSourceAuthorizationInput[],
): ArchiveSourceAuthorizationInput[] {
  if (sources.length === 0) {
    throw new Error('At least one authorized Source is required');
  }

  const seen = new Set<string>();
  const normalized: ArchiveSourceAuthorizationInput[] = [];
  for (const source of sources) {
    if (!ARCHIVE_SUPPORTED_SOURCES.includes(source.source)) {
      throw new Error(`Source ${source.source} is not authorized for Conversation Archive`);
    }
    if (!ARCHIVE_HISTORY_CHOICES.includes(source.historyChoice)) {
      throw new Error(`Invalid history choice for ${source.source}`);
    }
    if (seen.has(source.source)) {
      throw new Error(`Source ${source.source} is listed more than once`);
    }
    seen.add(source.source);
    normalized.push(source);
  }
  return normalized;
}

export function sourceAlreadyAuthorized(
  authorizedSources: { source: string }[],
  source: string,
): boolean {
  return authorizedSources.some((entry) => entry.source === source);
}

export function enrollmentAllowsSource(
  enrollment: { status: ArchiveEnrollmentStatus; authorizedSources: { source: string }[] },
  source: string,
): boolean {
  return (
    enrollment.status === 'active' && sourceAlreadyAuthorized(enrollment.authorizedSources, source)
  );
}

export function decideWriteAuthorization(input: {
  serverEnabled: boolean;
  activation: { status: ArchiveActivationStatus } | null;
  subscription: { tier: string; status: string } | null;
  credential: { status: string; orgId: string; userId: string } | null;
  enrollment: {
    status: ArchiveEnrollmentStatus;
    authorizedSources: { source: string }[];
  } | null;
  source: string;
}): { allowed: true } | { allowed: false; reason: ArchiveWriteDenialReason } {
  if (!input.serverEnabled) return { allowed: false, reason: 'server_disabled' };
  if (!input.activation) return { allowed: false, reason: 'not_activated' };
  if (input.activation.status === 'deleting') return { allowed: false, reason: 'deleting' };
  if (input.activation.status === 'frozen') return { allowed: false, reason: 'frozen' };
  if (!isActiveProSubscription(input.subscription)) return { allowed: false, reason: 'not_pro' };
  if (input.credential?.status !== 'active') {
    return { allowed: false, reason: 'credential_revoked' };
  }
  if (!input.enrollment) return { allowed: false, reason: 'not_enrolled' };
  if (input.enrollment.status !== 'active') return { allowed: false, reason: 'enrollment_invalid' };
  if (!enrollmentAllowsSource(input.enrollment, input.source)) {
    return { allowed: false, reason: 'source_unauthorized' };
  }
  return { allowed: true };
}

export type VersionedUpdateDecision = 'apply' | 'replay' | 'stale' | 'conflict';

export function decideVersionedUpdate(input: {
  storedVersion: number | undefined;
  incomingVersion: number;
  payloadEquals: boolean;
}): VersionedUpdateDecision {
  if (input.storedVersion === undefined) return 'apply';
  if (input.incomingVersion < input.storedVersion) return 'stale';
  if (input.incomingVersion > input.storedVersion) return 'apply';
  return input.payloadEquals ? 'replay' : 'conflict';
}

export function assertVersionedUpdate(
  decision: VersionedUpdateDecision,
  kind: 'server_status' | 'heartbeat',
): void {
  if (decision === 'stale') {
    throw new Error(
      kind === 'server_status'
        ? 'Stale archive server status revision'
        : 'Stale collector heartbeat observation',
    );
  }
  if (decision === 'conflict') {
    throw new Error(
      kind === 'server_status'
        ? 'Archive server status revision was reused with a different payload'
        : 'Collector heartbeat observation was reused with a different payload',
    );
  }
}

export function heartbeatPayloadEquals(
  stored: { pendingSpoolBytes?: number; localError?: string },
  incoming: { pendingSpoolBytes: number; localError?: string },
): boolean {
  return (
    stored.pendingSpoolBytes === incoming.pendingSpoolBytes &&
    (stored.localError ?? undefined) === (incoming.localError ?? undefined)
  );
}

export function serverStatusPayloadEquals(
  stored: {
    storedBytes: number;
    lastDurableAcknowledgedAt?: number;
    lifecycle: string;
  },
  incoming: {
    storedBytes: number;
    lastDurableAcknowledgedAt?: number;
    lifecycle: string;
  },
): boolean {
  return (
    stored.storedBytes === incoming.storedBytes &&
    stored.lastDurableAcknowledgedAt === incoming.lastDurableAcknowledgedAt &&
    stored.lifecycle === incoming.lifecycle
  );
}

export function assertHeartbeatObservedAt(observedAt: number, now: number): void {
  if (!Number.isFinite(observedAt)) {
    throw new Error('Collector heartbeat observation is invalid');
  }
  if (observedAt > now + ARCHIVE_HEARTBEAT_FUTURE_SKEW_MS) {
    throw new Error('Collector heartbeat observation is in the future');
  }
}

export async function applyCollectorHeartbeat(
  ctx: MutationCtx,
  enrollment: Doc<'archiveEnrollments'>,
  args: { pendingSpoolBytes: number; localError?: string; observedAt: number },
  now: number = Date.now(),
): Promise<void> {
  assertHeartbeatObservedAt(args.observedAt, now);
  const decision = decideVersionedUpdate({
    storedVersion: enrollment.localObservedAt,
    incomingVersion: args.observedAt,
    payloadEquals: heartbeatPayloadEquals(enrollment, args),
  });
  if (decision === 'replay') return;
  assertVersionedUpdate(decision, 'heartbeat');
  await ctx.db.patch(enrollment._id, {
    pendingSpoolBytes: args.pendingSpoolBytes,
    localError: args.localError,
    localObservedAt: args.observedAt,
  });
}

export function projectLifecycle(input: {
  activation: { status: ArchiveActivationStatus } | null;
  storedBytes: number;
  capBytes: number;
}): ArchiveLifecycle {
  if (!input.activation) return 'not_enabled';
  if (input.activation.status === 'deleting') return 'deleting';
  if (input.activation.status === 'frozen') return 'frozen';
  if (input.storedBytes >= input.capBytes) return 'blocked';
  return 'active';
}

export function resolveServerLifecycle(
  activationStatus: ArchiveActivationStatus,
  requested: ArchiveLifecycle,
): ArchiveLifecycle {
  if (activationStatus === 'deleting') return 'deleting';
  if (activationStatus === 'frozen' && requested !== 'deleting') return 'frozen';
  return requested;
}

export function isOrganizationDeleted(org: { deletedAt?: number } | null | undefined): boolean {
  return org == null || org.deletedAt !== undefined;
}

export function isOrganizationDeletionStarted(
  org: { deletionStartedAt?: number } | null | undefined,
): boolean {
  return org?.deletionStartedAt !== undefined;
}

export function assertArchiveMutationAllowed(input: {
  org: { deletedAt?: number; deletionStartedAt?: number } | null;
  activation: { status: ArchiveActivationStatus } | null;
  serverEnabled: boolean;
}): void {
  if (!input.serverEnabled) {
    throw new Error('Conversation Archive is not enabled');
  }
  assertArchiveAuthorityReductionAllowed(input);
}

export function assertArchiveAuthorityReductionAllowed(input: {
  org: { deletedAt?: number; deletionStartedAt?: number } | null | undefined;
  activation: { status: ArchiveActivationStatus } | null;
}): void {
  if (isOrganizationDeleted(input.org)) throw new Error('Organization not found');
  if (isOrganizationDeletionStarted(input.org) || input.activation?.status === 'deleting') {
    throw new Error('Conversation Archive is deleting');
  }
}

export function pickOldestDocument<T extends { _creationTime: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  return rows.reduce((oldest, row) => (row._creationTime < oldest._creationTime ? row : oldest));
}

async function keepOldestDocuments<T extends { _id: Id<TableNames>; _creationTime: number }>(
  ctx: MutationCtx,
  rows: T[],
): Promise<T | null> {
  const winner = pickOldestDocument(rows);
  if (!winner) return null;
  for (const row of rows) {
    if (row._id !== winner._id) {
      await ctx.db.delete(row._id);
    }
  }
  return winner;
}

export async function beginArchiveDeletion(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  now: number,
): Promise<void> {
  const org = await ctx.db.get(orgId);
  if (!org || isOrganizationDeleted(org)) throw new Error('Organization not found');
  if (!isOrganizationDeletionStarted(org)) {
    await ctx.db.patch(orgId, { deletionStartedAt: now });
  }

  const activation = await getArchiveActivation(ctx, orgId);
  if (!activation) return;
  if (activation.status !== 'deleting') {
    await ctx.db.patch(activation._id, { status: 'deleting' });
  }
  const status = await getArchiveStatusRow(ctx, orgId);
  if (status && status.lifecycle !== 'deleting') {
    await ctx.db.patch(status._id, { lifecycle: 'deleting', updatedAt: now });
  }
}

export async function getArchiveActivation(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveActivations'> | null> {
  const rows = await ctx.db
    .query('archiveActivations')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .collect();
  return pickOldestDocument(rows);
}

export async function getArchiveStatusRow(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveStatuses'> | null> {
  const rows = await ctx.db
    .query('archiveStatuses')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .collect();
  return pickOldestDocument(rows);
}

export async function getEnrollmentSlot(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  collectorCredentialId: Id<'collectorCredentials'>,
): Promise<Doc<'archiveEnrollmentSlots'> | null> {
  const rows = await ctx.db
    .query('archiveEnrollmentSlots')
    .withIndex('by_org_collector', (q) =>
      q.eq('orgId', orgId).eq('collectorCredentialId', collectorCredentialId),
    )
    .collect();
  return pickOldestDocument(rows);
}

export async function getContributionForUser(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
): Promise<Doc<'archiveContributions'> | null> {
  const rows = await ctx.db
    .query('archiveContributions')
    .withIndex('by_org_user', (q) => q.eq('orgId', orgId).eq('userId', userId))
    .collect();
  return pickOldestDocument(rows);
}

export async function getEnrollmentByIdempotencyKey(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  idempotencyKey: string,
): Promise<Doc<'archiveEnrollments'> | null> {
  const rows = await ctx.db
    .query('archiveEnrollments')
    .withIndex('by_org_idempotency_key', (q) =>
      q.eq('orgId', orgId).eq('idempotencyKey', idempotencyKey),
    )
    .collect();
  return pickOldestDocument(rows);
}

export async function claimEnrollmentByIdempotencyKey(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  idempotencyKey: string,
  enrollmentId: Id<'archiveEnrollments'>,
): Promise<{ enrollment: Doc<'archiveEnrollments'>; created: boolean }> {
  const rows = await ctx.db
    .query('archiveEnrollments')
    .withIndex('by_org_idempotency_key', (q) =>
      q.eq('orgId', orgId).eq('idempotencyKey', idempotencyKey),
    )
    .collect();
  const winner = (await keepOldestDocuments(ctx, rows))!;
  return { enrollment: winner, created: winner._id === enrollmentId };
}

export async function claimArchiveActivation(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveActivations'> | null> {
  const rows = await ctx.db
    .query('archiveActivations')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .collect();
  return await keepOldestDocuments(ctx, rows);
}

export async function claimEnrollmentSlot(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  collectorCredentialId: Id<'collectorCredentials'>,
  enrollmentId: Id<'archiveEnrollments'>,
): Promise<{ enrollmentId: Id<'archiveEnrollments'>; created: boolean }> {
  const rows = await ctx.db
    .query('archiveEnrollmentSlots')
    .withIndex('by_org_collector', (q) =>
      q.eq('orgId', orgId).eq('collectorCredentialId', collectorCredentialId),
    )
    .collect();

  if (rows.length === 0) {
    await ctx.db.insert('archiveEnrollmentSlots', {
      orgId,
      collectorCredentialId,
      currentEnrollmentId: enrollmentId,
    });
    return { enrollmentId, created: true };
  }

  const winner = (await keepOldestDocuments(ctx, rows))!;
  if (winner.currentEnrollmentId !== enrollmentId) {
    return { enrollmentId: winner.currentEnrollmentId, created: false };
  }
  return { enrollmentId, created: true };
}

export async function repairEnrollmentSlots(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  collectorCredentialId: Id<'collectorCredentials'>,
): Promise<Doc<'archiveEnrollmentSlots'> | null> {
  const rows = await ctx.db
    .query('archiveEnrollmentSlots')
    .withIndex('by_org_collector', (q) =>
      q.eq('orgId', orgId).eq('collectorCredentialId', collectorCredentialId),
    )
    .collect();
  return await keepOldestDocuments(ctx, rows);
}

export async function claimContributionForUser(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
  now: number,
): Promise<Doc<'archiveContributions'>> {
  const rows = await ctx.db
    .query('archiveContributions')
    .withIndex('by_org_user', (q) => q.eq('orgId', orgId).eq('userId', userId))
    .collect();
  const existing = pickOldestDocument(rows);
  if (!existing) {
    const contributionId = await ctx.db.insert('archiveContributions', {
      orgId,
      userId,
      createdAt: now,
      status: 'active',
    });
    return (await ctx.db.get(contributionId))!;
  }

  if (existing.status !== 'active') {
    await ctx.db.patch(existing._id, { status: 'active' });
  }
  return existing.status === 'active' ? existing : { ...existing, status: 'active' };
}

export async function requireActiveMembership(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
): Promise<Doc<'organizationMembers'>> {
  const membership = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user_id', (q) => q.eq('userId', userId))
    .filter((q) => q.eq(q.field('orgId'), orgId))
    .first();

  if (membership?.status !== 'active') {
    throw new Error('Not an active organization member');
  }
  return membership;
}

export async function countActiveEnrollments(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<{ enrolledContributorCount: number; enrolledCollectorCount: number }> {
  const enrollments = await ctx.db
    .query('archiveEnrollments')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .collect();

  const active = enrollments.filter((enrollment) => enrollment.status === 'active');
  const contributors = new Set(active.map((enrollment) => enrollment.userId));
  return {
    enrolledContributorCount: contributors.size,
    enrolledCollectorCount: active.length,
  };
}

export async function refreshArchiveStatusCounts(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  now: number,
): Promise<void> {
  const status = await getArchiveStatusRow(ctx, orgId);
  if (!status) return;
  const counts = await countActiveEnrollments(ctx, orgId);
  await ctx.db.patch(status._id, {
    ...counts,
    updatedAt: now,
  });
}

export function nextActivationStatusForEntitlement(
  current: ArchiveActivationStatus,
  entitled: boolean,
): ArchiveActivationStatus {
  if (current === 'deleting') return 'deleting';
  return entitled ? 'active' : 'frozen';
}

export async function ensureArchiveStatusRow(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    lifecycle: ArchiveLifecycle;
    capBytes: number;
    graceDeadlineAt?: number | null;
    now: number;
  },
): Promise<Id<'archiveStatuses'>> {
  const existing = await getArchiveStatusRow(ctx, args.orgId);
  const counts = await countActiveEnrollments(ctx, args.orgId);
  if (existing) {
    // Enrollment and count refresh must not overwrite Archive API-owned
    // lifecycle, stored bytes, or last durable acknowledgement.
    const patch: {
      capBytes: number;
      enrolledContributorCount: number;
      enrolledCollectorCount: number;
      updatedAt: number;
      graceDeadlineAt?: number;
    } = {
      capBytes: args.capBytes,
      ...counts,
      updatedAt: args.now,
    };
    if (args.graceDeadlineAt !== undefined) {
      patch.graceDeadlineAt = args.graceDeadlineAt ?? undefined;
    }
    await ctx.db.patch(existing._id, patch);
    return existing._id;
  }

  return await ctx.db.insert('archiveStatuses', {
    orgId: args.orgId,
    lifecycle: args.lifecycle,
    storedBytes: 0,
    capBytes: args.capBytes,
    enrolledContributorCount: counts.enrolledContributorCount,
    enrolledCollectorCount: counts.enrolledCollectorCount,
    graceDeadlineAt: args.graceDeadlineAt ?? undefined,
    serverRevision: 0,
    updatedAt: args.now,
  });
}

async function applyEntitlementLifecycle(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    lifecycle: ArchiveLifecycle;
    capBytes: number;
    graceDeadlineAt?: number | null;
    now: number;
  },
): Promise<void> {
  const statusId = await ensureArchiveStatusRow(ctx, args);
  await ctx.db.patch(statusId, {
    lifecycle: args.lifecycle,
    updatedAt: args.now,
  });
}

export async function syncArchiveLifecycleForEntitlement(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  subscription: { tier: string; status: string } | null,
  now: number,
): Promise<void> {
  const org = await ctx.db.get(orgId);
  if (!org || isOrganizationDeleted(org) || isOrganizationDeletionStarted(org)) return;

  const activation = await getArchiveActivation(ctx, orgId);
  if (!activation) return;
  if (activation.status === 'deleting') return;

  const entitled = isActiveProSubscription(subscription);
  const nextStatus = nextActivationStatusForEntitlement(activation.status, entitled);
  if (nextStatus === 'deleting') return;

  if (nextStatus === 'active') {
    const status = await getArchiveStatusRow(ctx, orgId);
    const storedBytes = status?.storedBytes ?? 0;
    await ctx.db.patch(activation._id, {
      status: nextStatus,
      graceDeadlineAt: undefined,
    });
    await applyEntitlementLifecycle(ctx, {
      orgId,
      lifecycle: projectLifecycle({
        activation: { status: nextStatus },
        storedBytes,
        capBytes: activation.capBytes,
      }),
      capBytes: activation.capBytes,
      graceDeadlineAt: null,
      now,
    });
    return;
  }

  const graceDeadlineAt = activation.graceDeadlineAt ?? archiveGraceDeadlineAt(now);
  await ctx.db.patch(activation._id, {
    status: 'frozen',
    graceDeadlineAt,
  });
  await applyEntitlementLifecycle(ctx, {
    orgId,
    lifecycle: 'frozen',
    capBytes: activation.capBytes,
    graceDeadlineAt,
    now,
  });
}

export async function invalidateArchiveEnrollmentsForUser(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    userId: Id<'users'>;
    reason: ArchiveInvalidationReason;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const enrollments = await ctx.db
    .query('archiveEnrollments')
    .withIndex('by_user_id', (q) => q.eq('userId', args.userId))
    .collect();

  const enrollmentStatus: ArchiveEnrollmentStatus =
    args.reason === 'owner_revoked'
      ? 'revoked'
      : args.reason === 'member_removed'
        ? 'member_removed'
        : 'unenrolled';

  for (const enrollment of enrollments) {
    if (enrollment.orgId !== args.orgId) continue;
    if (enrollment.status !== 'active') continue;
    await ctx.db.patch(enrollment._id, {
      status: enrollmentStatus,
      invalidatedAt: now,
      invalidationReason: args.reason,
    });
  }

  const contribution = await getContributionForUser(ctx, args.orgId, args.userId);
  if (contribution?.status === 'active') {
    const remaining = await ctx.db
      .query('archiveEnrollments')
      .withIndex('by_contribution', (q) => q.eq('contributionId', contribution._id))
      .collect();
    const hasActive = remaining.some((enrollment) => enrollment.status === 'active');
    if (!hasActive) {
      await ctx.db.patch(contribution._id, { status: enrollmentStatus });
    }
  }

  await refreshArchiveStatusCounts(ctx, args.orgId, now);
}

export async function invalidateArchiveEnrollment(
  ctx: MutationCtx,
  enrollment: Doc<'archiveEnrollments'>,
  reason: ArchiveInvalidationReason,
  now: number,
): Promise<void> {
  if (enrollment.status !== 'active') return;

  const org = await ctx.db.get(enrollment.orgId);
  const activation = await getArchiveActivation(ctx, enrollment.orgId);
  assertArchiveAuthorityReductionAllowed({ org, activation });

  const enrollmentStatus: ArchiveEnrollmentStatus =
    reason === 'owner_revoked'
      ? 'revoked'
      : reason === 'member_removed'
        ? 'member_removed'
        : 'unenrolled';

  await ctx.db.patch(enrollment._id, {
    status: enrollmentStatus,
    invalidatedAt: now,
    invalidationReason: reason,
  });

  const remaining = await ctx.db
    .query('archiveEnrollments')
    .withIndex('by_contribution', (q) => q.eq('contributionId', enrollment.contributionId))
    .collect();
  const hasActive = remaining.some((row) => row._id !== enrollment._id && row.status === 'active');
  if (!hasActive) {
    await ctx.db.patch(enrollment.contributionId, { status: enrollmentStatus });
  }

  await refreshArchiveStatusCounts(ctx, enrollment.orgId, now);
}
