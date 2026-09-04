import { mutation, query } from './_generated/server';
import { v, type Infer } from 'convex/values';
import { requireAuthenticated } from './auth/auth';
import { requireEnabledUser } from './auth/userHelpers';
import type { Doc, Id } from './_generated/dataModel';
import {
  archiveEnrollmentValidator,
  archiveHistoryChoiceValidator,
  archiveSourceAuthorizationInputValidator,
  type archiveStatusContributionValidator,
  archiveStatusProjectionValidator,
  archiveSupportedSourceValidator,
} from './validators';
import {
  ARCHIVE_CAP_BYTES,
  applyCollectorHeartbeat,
  claimArchiveActivation,
  claimContributionForUser,
  claimEnrollmentByIdempotencyKey,
  claimEnrollmentSlot,
  consentSourcesMatch,
  countActiveEnrollments,
  decideEnrollmentAction,
  ensureArchiveStatusRow,
  getArchiveActivation,
  getArchiveStatusRow,
  getEnrollmentByIdempotencyKey,
  getEnrollmentSlot,
  invalidateArchiveEnrollment,
  isActiveProSubscription,
  isArchiveServerEnabled,
  projectLifecycle,
  refreshArchiveStatusCounts,
  repairEnrollmentSlots,
  requireActiveMembership,
  sourceAlreadyAuthorized,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from './archiveLib';

async function requireCurrentOrgUser(ctx: Parameters<typeof requireEnabledUser>[0]) {
  await requireAuthenticated(ctx);
  const user = await requireEnabledUser(ctx);
  if (!user.orgId) throw new Error('No organization found');
  const org = await ctx.db.get(user.orgId);
  if (!org || org.deletedAt) throw new Error('Organization not found');
  const membership = await requireActiveMembership(ctx, user.orgId, user._id);
  return { user: { ...user, orgId: user.orgId }, org, membership };
}

async function requireOrgOwner(ctx: Parameters<typeof requireEnabledUser>[0]) {
  const current = await requireCurrentOrgUser(ctx);
  if (current.org.ownerId !== current.user._id || current.membership.role !== 'owner') {
    throw new Error('Only the organization owner can activate Conversation Archive');
  }
  return current;
}

async function getOrgSubscription(
  ctx: Parameters<typeof requireEnabledUser>[0],
  orgId: Id<'organizations'>,
) {
  return await ctx.db
    .query('subscriptions')
    .withIndex('by_org_id', (q) => q.eq('orgId', orgId))
    .first();
}

async function requireArchiveWritable(
  ctx: Parameters<typeof requireEnabledUser>[0],
  orgId: Id<'organizations'>,
) {
  if (!isArchiveServerEnabled()) {
    throw new Error('Conversation Archive is not enabled');
  }
  const activation = await getArchiveActivation(ctx, orgId);
  if (!activation) {
    throw new Error('Conversation Archive is not activated');
  }
  if (activation.status === 'deleting') {
    throw new Error('Conversation Archive is deleting');
  }
  if (activation.status === 'frozen') {
    throw new Error('Conversation Archive is frozen');
  }
  const subscription = await getOrgSubscription(ctx, orgId);
  if (!isActiveProSubscription(subscription)) {
    throw new Error('Active Pro entitlement is required');
  }
  return { activation, subscription };
}

async function requireBoundCollectorCredential(
  ctx: Parameters<typeof requireEnabledUser>[0],
  collectorCredentialId: Id<'collectorCredentials'>,
  user: Doc<'users'> & { orgId: Id<'organizations'> },
) {
  const credential = await ctx.db.get(collectorCredentialId);
  if (credential?.orgId !== user.orgId || credential.userId !== user._id) {
    throw new Error('Collector Credential not found');
  }
  if (credential.status !== 'active') {
    throw new Error('Collector Credential is revoked');
  }
  return credential;
}

export const activate = mutation({
  args: {},
  returns: v.object({
    activationId: v.id('archiveActivations'),
    created: v.boolean(),
  }),
  handler: async (ctx) => {
    const { user, org } = await requireOrgOwner(ctx);
    if (!isArchiveServerEnabled()) {
      throw new Error('Conversation Archive is not enabled');
    }
    const subscription = await getOrgSubscription(ctx, org._id);
    if (!isActiveProSubscription(subscription)) {
      throw new Error('Active Pro entitlement is required');
    }

    const existing = await getArchiveActivation(ctx, org._id);
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
    return { activationId, created: true };
  },
});

export const enroll = mutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    authorizedSources: v.array(archiveSourceAuthorizationInputValidator),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    enrollmentId: v.id('archiveEnrollments'),
    contributionId: v.id('archiveContributions'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { user } = await requireCurrentOrgUser(ctx);
    await requireArchiveWritable(ctx, user.orgId);
    const credential = await requireBoundCollectorCredential(ctx, args.collectorCredentialId, user);
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

    return {
      enrollmentId,
      contributionId: contribution._id,
      created: true,
    };
  },
});

export const addAuthorizedSource = mutation({
  args: {
    enrollmentId: v.id('archiveEnrollments'),
    source: archiveSupportedSourceValidator,
    historyChoice: archiveHistoryChoiceValidator,
  },
  returns: archiveEnrollmentValidator,
  handler: async (ctx, args) => {
    const { user } = await requireCurrentOrgUser(ctx);
    await requireArchiveWritable(ctx, user.orgId);
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
      throw new Error('Enrollment not found');
    }
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }

    validateAuthorizedSources([{ source: args.source, historyChoice: args.historyChoice }]);
    if (sourceAlreadyAuthorized(enrollment.authorizedSources, args.source)) {
      return enrollment;
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
    const updated = await ctx.db.get(enrollment._id);
    if (!updated) throw new Error('Enrollment not found');
    return updated;
  },
});

export const unenroll = mutation({
  args: { enrollmentId: v.id('archiveEnrollments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireCurrentOrgUser(ctx);
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
      throw new Error('Enrollment not found');
    }
    await invalidateArchiveEnrollment(ctx, enrollment, 'user_unenrolled', Date.now());
    return null;
  },
});

export const revokeEnrollment = mutation({
  args: { enrollmentId: v.id('archiveEnrollments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user, org, membership } = await requireCurrentOrgUser(ctx);
    if (org.ownerId !== user._id || membership.role !== 'owner') {
      throw new Error('Only the organization owner can revoke enrollments');
    }
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (enrollment?.orgId !== user.orgId) {
      throw new Error('Enrollment not found');
    }
    await invalidateArchiveEnrollment(ctx, enrollment, 'owner_revoked', Date.now());
    return null;
  },
});

export const reportHeartbeat = mutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    pendingSpoolBytes: v.number(),
    localError: v.optional(v.string()),
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireCurrentOrgUser(ctx);
    await requireArchiveWritable(ctx, user.orgId);
    const credential = await requireBoundCollectorCredential(ctx, args.collectorCredentialId, user);
    const slot = await getEnrollmentSlot(ctx, user.orgId, credential._id);
    if (!slot) throw new Error('Enrollment not found');
    const enrollment = await ctx.db.get(slot.currentEnrollmentId);
    if (enrollment?.userId !== user._id) {
      throw new Error('Enrollment not found');
    }
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }

    await applyCollectorHeartbeat(ctx, enrollment, args);
    return null;
  },
});

function toCollectorProjection(enrollment: Doc<'archiveEnrollments'>) {
  return {
    enrollmentId: enrollment._id,
    collectorId: enrollment.collectorId,
    collectorCredentialId: enrollment.collectorCredentialId,
    status: enrollment.status,
    authorizedSources: enrollment.authorizedSources,
    pendingSpoolBytes: enrollment.pendingSpoolBytes,
    localError: enrollment.localError,
    localObservedAt: enrollment.localObservedAt,
  };
}

export const getStatus = query({
  args: {},
  returns: archiveStatusProjectionValidator,
  handler: async (ctx) => {
    const { user, org, membership } = await requireCurrentOrgUser(ctx);
    const isOwner = org.ownerId === user._id && membership.role === 'owner';
    const activation = await getArchiveActivation(ctx, user.orgId);
    const status = await getArchiveStatusRow(ctx, user.orgId);
    const storedBytes = status?.storedBytes ?? 0;
    const capBytes = activation?.capBytes ?? status?.capBytes ?? ARCHIVE_CAP_BYTES;
    const lifecycle = !activation
      ? 'not_enabled'
      : (status?.lifecycle ??
        projectLifecycle({
          activation: { status: activation.status },
          storedBytes,
          capBytes,
        }));

    const contributions = await ctx.db
      .query('archiveContributions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId))
      .collect();
    const visibleContributions = isOwner
      ? contributions
      : contributions.filter((contribution) => contribution.userId === user._id);

    const projectedContributions: Infer<typeof archiveStatusContributionValidator>[] = [];
    for (const contribution of visibleContributions) {
      const collectors = await ctx.db
        .query('archiveEnrollments')
        .withIndex('by_contribution', (q) => q.eq('contributionId', contribution._id))
        .collect();
      projectedContributions.push({
        userId: contribution.userId,
        contributionId: contribution._id,
        status: contribution.status,
        collectors: collectors.map(toCollectorProjection),
      });
    }

    const integrityRows = isOwner
      ? await ctx.db
          .query('archiveSessionIntegrity')
          .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId))
          .collect()
      : (
          await Promise.all(
            visibleContributions.map((contribution) =>
              ctx.db
                .query('archiveSessionIntegrity')
                .withIndex('by_contribution', (q) => q.eq('contributionId', contribution._id))
                .collect(),
            ),
          )
        ).flat();

    const counts = isOwner
      ? await countActiveEnrollments(ctx, user.orgId)
      : {
          enrolledContributorCount: visibleContributions.some((row) =>
            projectedContributions.some(
              (projected) =>
                projected.contributionId === row._id &&
                projected.collectors.some((collector) => collector.status === 'active'),
            ),
          )
            ? 1
            : 0,
          enrolledCollectorCount: projectedContributions.reduce(
            (total, contribution) =>
              total +
              contribution.collectors.filter((collector) => collector.status === 'active').length,
            0,
          ),
        };

    return {
      lifecycle,
      capBytes,
      storedBytes: isOwner ? storedBytes : null,
      lastDurableAcknowledgedAt: isOwner ? (status?.lastDurableAcknowledgedAt ?? null) : null,
      enrolledContributorCount: counts.enrolledContributorCount,
      enrolledCollectorCount: counts.enrolledCollectorCount,
      graceDeadlineAt: activation?.graceDeadlineAt ?? status?.graceDeadlineAt ?? null,
      contributions: projectedContributions,
      integritySessions: integrityRows.map((row) => ({
        contributionId: row.contributionId,
        source: row.source,
        sourceSessionId: row.sourceSessionId,
        errorClass: row.errorClass,
        repairOutcome: row.repairOutcome,
        updatedAt: row.updatedAt,
      })),
    };
  },
});
