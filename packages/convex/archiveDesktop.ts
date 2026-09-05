import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  archiveHistoryChoiceValidator,
  archiveSourceAuthorizationInputValidator,
  archiveSupportedSourceValidator,
} from './validators';
import { activationOperationId, appendArchiveAuditEvent, enrollmentOperationId } from './archiveAuditLib';
import {
  ARCHIVE_CAP_BYTES,
  assertArchiveMutationAllowed,
  claimArchiveActivation,
  claimContributionForUser,
  claimEnrollmentByIdempotencyKey,
  claimEnrollmentSlot,
  consentSourcesMatch,
  decideEnrollmentAction,
  ensureArchiveStatusRow,
  getArchiveActivation,
  getArchiveStatusRow,
  getEnrollmentByIdempotencyKey,
  invalidateArchiveEnrollment,
  isActiveProSubscription,
  isArchiveServerEnabled,
  refreshArchiveStatusCounts,
  repairEnrollmentSlots,
  requireActiveMembership,
  sourceAlreadyAuthorized,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from './archiveLib';

const desktopSnapshotValidator = v.object({
  userId: v.id('users'),
  orgId: v.id('organizations'),
  role: v.union(v.literal('owner'), v.literal('member')),
  plan: v.union(v.literal('hobby'), v.literal('pro')),
  planStatus: v.union(
    v.literal('active'),
    v.literal('inactive'),
    v.literal('canceled'),
    v.literal('none'),
  ),
  serverEnabled: v.boolean(),
  activation: v.union(
    v.literal('not_enabled'),
    v.literal('active'),
    v.literal('frozen'),
    v.literal('deleting'),
  ),
  activationId: v.optional(v.id('archiveActivations')),
  collectorId: v.string(),
  collectorUserId: v.id('users'),
  enrollmentId: v.optional(v.id('archiveEnrollments')),
  enrollmentStatus: v.optional(
    v.union(
      v.literal('active'),
      v.literal('unenrolled'),
      v.literal('revoked'),
      v.literal('member_removed'),
    ),
  ),
});

async function loadOrgUser(
  ctx: Parameters<typeof requireActiveMembership>[0],
  userId: Id<'users'>,
) {
  const user = await ctx.db.get(userId);
  if (!user?.orgId || !user.enabled) {
    throw new Error('Not authenticated');
  }
  const org = await ctx.db.get(user.orgId);
  if (!org || org.deletedAt) {
    throw new Error('Organization not found');
  }
  const membership = await requireActiveMembership(ctx, user.orgId, user._id);
  return { user: { ...user, orgId: user.orgId }, org, membership };
}

async function getOrgSubscription(
  ctx: Parameters<typeof requireActiveMembership>[0],
  orgId: Id<'organizations'>,
) {
  return await ctx.db
    .query('subscriptions')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .first();
}

function planStatusOf(subscription: { status: string } | null): 'active' | 'inactive' | 'canceled' | 'none' {
  if (!subscription) return 'none';
  if (subscription.status === 'active') return 'active';
  if (subscription.status === 'canceled') return 'canceled';
  return 'inactive';
}

async function findCollectorCredential(
  ctx: Parameters<typeof requireActiveMembership>[0],
  user: Doc<'users'> & { orgId: Id<'organizations'> },
  collectorId: string,
) {
  const credentials = await ctx.db
    .query('collectorCredentials')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .collect();
  const credential = credentials.find(
    (row) => row.orgId === user.orgId && row.collectorId === collectorId,
  );
  if (!credential) {
    throw new Error('Collector Credential not found');
  }
  if (credential.status !== 'active') {
    throw new Error('Collector Credential is revoked');
  }
  return credential;
}

export const snapshotForUser = internalQuery({
  args: {
    userId: v.id('users'),
    collectorId: v.string(),
  },
  returns: desktopSnapshotValidator,
  handler: async (ctx, args) => {
    const { user, org, membership } = await loadOrgUser(ctx, args.userId);
    const activation = await getArchiveActivation(ctx, user.orgId);
    const subscription = await getOrgSubscription(ctx, user.orgId);
    const credentials = await ctx.db
      .query('collectorCredentials')
      .withIndex('by_user_id', (q) => q.eq('userId', user._id))
      .collect();
    const credential = credentials.find(
      (row) => row.orgId === user.orgId && row.collectorId === args.collectorId,
    );
    const enrollments = credential
      ? await ctx.db
          .query('archiveEnrollments')
          .withIndex('by_collector_credential', (q) =>
            q.eq('collectorCredentialId', credential._id),
          )
          .collect()
      : [];
    const current = enrollments.find((row) => row.status === 'active') ?? enrollments[0];
    return {
      userId: user._id,
      orgId: user.orgId,
      role: org.ownerId === user._id && membership.role === 'owner' ? 'owner' : 'member',
      plan: subscription?.tier === 'pro' ? 'pro' : 'hobby',
      planStatus: planStatusOf(subscription),
      serverEnabled: isArchiveServerEnabled(),
      activation: !activation
        ? 'not_enabled'
        : activation.status === 'frozen'
          ? 'frozen'
          : activation.status === 'deleting'
            ? 'deleting'
            : 'active',
      ...(activation ? { activationId: activation._id } : {}),
      collectorId: args.collectorId,
      collectorUserId: credential?.userId ?? user._id,
      ...(current ? { enrollmentId: current._id, enrollmentStatus: current.status } : {}),
    };
  },
});

export const activateForUser = internalMutation({
  args: { userId: v.id('users') },
  returns: v.object({
    activationId: v.id('archiveActivations'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { user, org, membership } = await loadOrgUser(ctx, args.userId);
    if (org.ownerId !== user._id || membership.role !== 'owner') {
      throw new Error('Only the organization owner can activate Conversation Archive');
    }
    const existing = await getArchiveActivation(ctx, org._id);
    assertArchiveMutationAllowed({
      org,
      activation: existing,
      serverEnabled: isArchiveServerEnabled(),
    });
    if (!isArchiveServerEnabled()) {
      throw new Error('Conversation Archive is not enabled');
    }
    const subscription = await getOrgSubscription(ctx, org._id);
    if (!isActiveProSubscription(subscription)) {
      throw new Error('Active Pro entitlement is required');
    }
    if (existing) {
      return { activationId: existing._id, created: false };
    }

    const now = Date.now();
    const insertedId = await ctx.db.insert('archiveActivations', {
      orgId: org._id,
      activatedByUserId: user._id,
      activatedAt: now,
      capBytes: ARCHIVE_CAP_BYTES,
      status: 'active',
    });
    const winner = await claimArchiveActivation(ctx, org._id);
    const activationId = winner?._id ?? insertedId;
    if (activationId !== insertedId) {
      return { activationId, created: false };
    }
    await ensureArchiveStatusRow(ctx, {
      orgId: org._id,
      lifecycle: 'active',
      capBytes: ARCHIVE_CAP_BYTES,
      now,
    });
    await appendArchiveAuditEvent(ctx, {
      orgId: org._id,
      actorKind: 'user',
      actorUserId: user._id,
      action: 'activation',
      outcome: 'success',
      operationId: activationOperationId(org._id),
      targetKind: 'activation',
      targetId: activationId,
      activationId,
      now,
    });
    return { activationId, created: true };
  },
});

export const enrollForUser = internalMutation({
  args: {
    userId: v.id('users'),
    collectorId: v.string(),
    authorizedSources: v.array(archiveSourceAuthorizationInputValidator),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    enrollmentId: v.id('archiveEnrollments'),
    contributionId: v.id('archiveContributions'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { user, org } = await loadOrgUser(ctx, args.userId);
    if (!isArchiveServerEnabled()) {
      throw new Error('Conversation Archive is not enabled');
    }
    const activation = await getArchiveActivation(ctx, user.orgId);
    assertArchiveMutationAllowed({
      org,
      activation,
      serverEnabled: isArchiveServerEnabled(),
    });
    if (!activation) {
      throw new Error('Conversation Archive is not activated');
    }
    if (activation.status === 'frozen') {
      throw new Error('Conversation Archive is frozen');
    }
    const subscription = await getOrgSubscription(ctx, user.orgId);
    if (!isActiveProSubscription(subscription)) {
      throw new Error('Active Pro entitlement is required');
    }
    const credential = await findCollectorCredential(ctx, user, args.collectorId);
    const sources = validateAuthorizedSources(args.authorizedSources);
    const idempotencyKey = validateEnrollmentIdempotencyKey(args.idempotencyKey);
    const now = Date.now();

    const existingByKey = await getEnrollmentByIdempotencyKey(ctx, user.orgId, idempotencyKey);
    const slot = await repairEnrollmentSlots(ctx, user.orgId, credential._id);
    const current = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;
    const decision = decideEnrollmentAction({
      existingByKey,
      currentEnrollment: current,
      request: {
        userId: user._id,
        collectorCredentialId: credential._id,
        authorizedSources: sources,
      },
    });

    if (decision === 'replay' && existingByKey) {
      return {
        enrollmentId: existingByKey._id,
        contributionId: existingByKey.contributionId,
        created: false,
      };
    }
    if (decision === 'conflict') {
      if (
        existingByKey &&
        (existingByKey.userId !== user._id ||
          existingByKey.collectorCredentialId !== credential._id)
      ) {
        throw new Error('Enrollment idempotency key is already bound to another Collector');
      }
      throw new Error('Enrollment idempotency key does not match the original consent');
    }
    if (decision === 'already_enrolled') {
      throw new Error('Collector is already enrolled');
    }

    const contribution = await claimContributionForUser(ctx, user.orgId, user._id, now);
    const enrollmentId = await ctx.db.insert('archiveEnrollments', {
      orgId: user.orgId,
      userId: user._id,
      collectorCredentialId: credential._id,
      collectorId: credential.collectorId,
      contributionId: contribution._id,
      idempotencyKey,
      consentSources: sources,
      authorizedSources: sources.map((source) => ({
        ...source,
        authorizedAt: now,
      })),
      status: 'active',
      createdAt: now,
    });

    const claimedByKey = await claimEnrollmentByIdempotencyKey(
      ctx,
      user.orgId,
      idempotencyKey,
      enrollmentId,
    );
    if (!claimedByKey.created) {
      if (
        claimedByKey.enrollment.userId !== user._id ||
        claimedByKey.enrollment.collectorCredentialId !== credential._id
      ) {
        throw new Error('Enrollment idempotency key is already bound to another Collector');
      }
      if (!consentSourcesMatch(claimedByKey.enrollment.consentSources, sources)) {
        throw new Error('Enrollment idempotency key does not match the original consent');
      }
      await refreshArchiveStatusCounts(ctx, user.orgId, now);
      return {
        enrollmentId: claimedByKey.enrollment._id,
        contributionId: claimedByKey.enrollment.contributionId,
        created: false,
      };
    }

    if (slot) {
      await ctx.db.patch(slot._id, { currentEnrollmentId: enrollmentId });
    } else {
      const claimed = await claimEnrollmentSlot(ctx, user.orgId, credential._id, enrollmentId);
      if (!claimed.created) {
        const winner = await ctx.db.get(claimed.enrollmentId);
        if (!winner) throw new Error('Enrollment not found');
        if (winner.idempotencyKey !== idempotencyKey) {
          await ctx.db.delete(enrollmentId);
          throw new Error('Collector is already enrolled');
        }
        await refreshArchiveStatusCounts(ctx, user.orgId, now);
        return {
          enrollmentId: winner._id,
          contributionId: winner.contributionId,
          created: false,
        };
      }
    }

    const status = await getArchiveStatusRow(ctx, user.orgId);
    if (status) {
      await refreshArchiveStatusCounts(ctx, user.orgId, now);
    } else {
      await ensureArchiveStatusRow(ctx, {
        orgId: user.orgId,
        lifecycle: 'active',
        capBytes: ARCHIVE_CAP_BYTES,
        now,
      });
    }

    await appendArchiveAuditEvent(ctx, {
      orgId: user.orgId,
      actorKind: 'user',
      actorUserId: user._id,
      action: 'enrollment',
      outcome: 'success',
      operationId: await enrollmentOperationId(user.orgId, idempotencyKey),
      targetKind: 'enrollment',
      targetId: enrollmentId,
      enrollmentId,
      contributionId: contribution._id,
      now,
    });
    return {
      enrollmentId,
      contributionId: contribution._id,
      created: true,
    };
  },
});

export const addAuthorizedSourceForUser = internalMutation({
  args: {
    userId: v.id('users'),
    enrollmentId: v.id('archiveEnrollments'),
    source: archiveSupportedSourceValidator,
    historyChoice: archiveHistoryChoiceValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, org } = await loadOrgUser(ctx, args.userId);
    const activation = await getArchiveActivation(ctx, user.orgId);
    assertArchiveMutationAllowed({
      org,
      activation,
      serverEnabled: isArchiveServerEnabled(),
    });
    if (!activation) {
      throw new Error('Conversation Archive is not activated');
    }
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
      throw new Error('Enrollment not found');
    }
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }
    validateAuthorizedSources([{ source: args.source, historyChoice: args.historyChoice }]);
    if (sourceAlreadyAuthorized(enrollment.authorizedSources, args.source)) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(enrollment._id, {
      authorizedSources: [
        ...enrollment.authorizedSources,
        {
          source: args.source,
          historyChoice: args.historyChoice,
          authorizedAt: now,
        },
      ],
    });
    return null;
  },
});

export const unenrollForUser = internalMutation({
  args: {
    userId: v.id('users'),
    enrollmentId: v.id('archiveEnrollments'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await loadOrgUser(ctx, args.userId);
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
      throw new Error('Enrollment not found');
    }
    await invalidateArchiveEnrollment(ctx, enrollment, 'user_unenrolled', Date.now(), user._id);
    return null;
  },
});

export const revokeForUser = internalMutation({
  args: {
    userId: v.id('users'),
    enrollmentId: v.id('archiveEnrollments'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, org, membership } = await loadOrgUser(ctx, args.userId);
    if (org.ownerId !== user._id || membership.role !== 'owner') {
      throw new Error('Only the organization owner can revoke enrollments');
    }
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId) {
      throw new Error('Enrollment not found');
    }
    await invalidateArchiveEnrollment(ctx, enrollment, 'owner_revoked', Date.now(), user._id);
    return null;
  },
});
