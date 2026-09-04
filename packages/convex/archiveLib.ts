import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

export const ARCHIVE_SUPPORTED_SOURCES = ['claude', 'codex'] as const;
export type ArchiveSupportedSource = (typeof ARCHIVE_SUPPORTED_SOURCES)[number];

export const ARCHIVE_HISTORY_CHOICES = ['new_only', 'all_history'] as const;
export type ArchiveHistoryChoice = (typeof ARCHIVE_HISTORY_CHOICES)[number];

export const ARCHIVE_CAP_BYTES = 100 * 1024 * 1024 * 1024;
export const ARCHIVE_GRACE_MS = 90 * 24 * 60 * 60 * 1000;
export const ARCHIVE_ENABLED_ENV = 'CONVERSATION_ARCHIVE_ENABLED';

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

export type ArchiveEnrollmentDecision = 'create' | 'replay' | 'renew';

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

export function decideEnrollmentAction(
  currentEnrollment: { status: ArchiveEnrollmentStatus } | null,
): ArchiveEnrollmentDecision {
  if (currentEnrollment === null) return 'create';
  if (currentEnrollment.status === 'active') return 'replay';
  return 'renew';
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
  source?: string;
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
  if (input.source && !enrollmentAllowsSource(input.enrollment, input.source)) {
    return { allowed: false, reason: 'source_unauthorized' };
  }
  return { allowed: true };
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

export async function getArchiveActivation(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveActivations'> | null> {
  return await ctx.db
    .query('archiveActivations')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .unique();
}

export async function getArchiveStatusRow(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
): Promise<Doc<'archiveStatuses'> | null> {
  return await ctx.db
    .query('archiveStatuses')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .unique();
}

export async function getEnrollmentSlot(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  collectorCredentialId: Id<'collectorCredentials'>,
): Promise<Doc<'archiveEnrollmentSlots'> | null> {
  return await ctx.db
    .query('archiveEnrollmentSlots')
    .withIndex('by_org_collector', (q) =>
      q.eq('orgId', orgId).eq('collectorCredentialId', collectorCredentialId),
    )
    .unique();
}

export async function getContributionForUser(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
): Promise<Doc<'archiveContributions'> | null> {
  return await ctx.db
    .query('archiveContributions')
    .withIndex('by_org_user', (q) => q.eq('orgId', orgId).eq('userId', userId))
    .unique();
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

export async function ensureArchiveStatusRow(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    lifecycle: ArchiveLifecycle;
    capBytes: number;
    graceDeadlineAt?: number;
    now: number;
  },
): Promise<Id<'archiveStatuses'>> {
  const existing = await getArchiveStatusRow(ctx, args.orgId);
  const counts = await countActiveEnrollments(ctx, args.orgId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      lifecycle: args.lifecycle,
      capBytes: args.capBytes,
      graceDeadlineAt: args.graceDeadlineAt,
      ...counts,
      updatedAt: args.now,
    });
    return existing._id;
  }

  return await ctx.db.insert('archiveStatuses', {
    orgId: args.orgId,
    lifecycle: args.lifecycle,
    storedBytes: 0,
    capBytes: args.capBytes,
    enrolledContributorCount: counts.enrolledContributorCount,
    enrolledCollectorCount: counts.enrolledCollectorCount,
    graceDeadlineAt: args.graceDeadlineAt,
    updatedAt: args.now,
  });
}

export async function syncArchiveLifecycleForEntitlement(
  ctx: MutationCtx,
  orgId: Id<'organizations'>,
  subscription: { tier: string; status: string } | null,
  now: number,
): Promise<void> {
  const activation = await getArchiveActivation(ctx, orgId);
  if (!activation) return;

  const entitled = isActiveProSubscription(subscription);
  if (entitled) {
    const status = await getArchiveStatusRow(ctx, orgId);
    const storedBytes = status?.storedBytes ?? 0;
    const nextStatus: ArchiveActivationStatus = 'active';
    await ctx.db.patch(activation._id, {
      status: nextStatus,
      graceDeadlineAt: undefined,
    });
    await ensureArchiveStatusRow(ctx, {
      orgId,
      lifecycle: projectLifecycle({
        activation: { status: nextStatus },
        storedBytes,
        capBytes: activation.capBytes,
      }),
      capBytes: activation.capBytes,
      now,
    });
    return;
  }

  const graceDeadlineAt = activation.graceDeadlineAt ?? archiveGraceDeadlineAt(now);
  await ctx.db.patch(activation._id, {
    status: 'frozen',
    graceDeadlineAt,
  });
  await ensureArchiveStatusRow(ctx, {
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
