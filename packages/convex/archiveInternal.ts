import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import {
  archiveLifecycleValidator,
  archiveSessionIntegrityValidator,
  archiveSupportedSourceValidator,
  archiveWriteDenialReasonValidator,
} from './validators';
import {
  ARCHIVE_CAP_BYTES,
  decideWriteAuthorization,
  ensureArchiveStatusRow,
  getArchiveActivation,
  getArchiveStatusRow,
  getEnrollmentSlot,
  invalidateArchiveEnrollmentsForUser,
  isActiveProSubscription,
  isArchiveServerEnabled,
  projectLifecycle,
  syncArchiveLifecycleForEntitlement,
} from './archiveLib';

export const authorizeArchiveWrite = internalQuery({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    source: v.optional(archiveSupportedSourceValidator),
  },
  returns: v.union(
    v.object({
      allowed: v.literal(true),
      enrollmentId: v.id('archiveEnrollments'),
      contributionId: v.id('archiveContributions'),
      authorizedSources: v.array(
        v.object({
          source: archiveSupportedSourceValidator,
          historyChoice: v.union(v.literal('new_only'), v.literal('all_history')),
          authorizedAt: v.number(),
        }),
      ),
    }),
    v.object({
      allowed: v.literal(false),
      reason: archiveWriteDenialReasonValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    const activation = credential ? await getArchiveActivation(ctx, credential.orgId) : null;
    const subscription = credential
      ? await ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', credential.orgId))
          .first()
      : null;
    const slot =
      credential && activation
        ? await getEnrollmentSlot(ctx, credential.orgId, credential._id)
        : null;
    const enrollment = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;

    const decision = decideWriteAuthorization({
      serverEnabled: isArchiveServerEnabled(),
      activation: activation ? { status: activation.status } : null,
      subscription,
      credential,
      enrollment,
      source: args.source,
    });
    if (!decision.allowed) return decision;
    if (!enrollment) return { allowed: false as const, reason: 'not_enrolled' as const };

    return {
      allowed: true as const,
      enrollmentId: enrollment._id,
      contributionId: enrollment.contributionId,
      authorizedSources: enrollment.authorizedSources,
    };
  },
});

export const applyServerStatus = internalMutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    storedBytes: v.optional(v.number()),
    lastDurableAcknowledgedAt: v.optional(v.number()),
    lifecycle: v.optional(archiveLifecycleValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    if (!credential) throw new Error('Collector Credential not found');

    const activation = await getArchiveActivation(ctx, credential.orgId);
    if (!activation) throw new Error('Conversation Archive is not activated');

    const now = Date.now();
    const existing = await getArchiveStatusRow(ctx, credential.orgId);
    const storedBytes = args.storedBytes ?? existing?.storedBytes ?? 0;
    const lifecycle =
      args.lifecycle ??
      projectLifecycle({
        activation: { status: activation.status },
        storedBytes,
        capBytes: activation.capBytes,
      });

    if (existing) {
      await ctx.db.patch(existing._id, {
        storedBytes,
        lastDurableAcknowledgedAt:
          args.lastDurableAcknowledgedAt ?? existing.lastDurableAcknowledgedAt,
        lifecycle,
        capBytes: activation.capBytes,
        graceDeadlineAt: activation.graceDeadlineAt,
        updatedAt: now,
      });
    } else {
      await ensureArchiveStatusRow(ctx, {
        orgId: credential.orgId,
        lifecycle,
        capBytes: activation.capBytes,
        graceDeadlineAt: activation.graceDeadlineAt,
        now,
      });
      const created = await getArchiveStatusRow(ctx, credential.orgId);
      if (
        created &&
        (args.storedBytes !== undefined || args.lastDurableAcknowledgedAt !== undefined)
      ) {
        await ctx.db.patch(created._id, {
          storedBytes,
          lastDurableAcknowledgedAt: args.lastDurableAcknowledgedAt,
          lifecycle,
          updatedAt: now,
        });
      }
    }

    if (lifecycle === 'deleting' && activation.status !== 'deleting') {
      await ctx.db.patch(activation._id, { status: 'deleting' });
    }
    return null;
  },
});

export const reportCollectorHeartbeat = internalMutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    pendingSpoolBytes: v.number(),
    localError: v.optional(v.string()),
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    if (!credential) throw new Error('Collector Credential not found');
    const slot = await getEnrollmentSlot(ctx, credential.orgId, credential._id);
    if (!slot) throw new Error('Enrollment not found');
    const enrollment = await ctx.db.get(slot.currentEnrollmentId);
    if (enrollment?.collectorCredentialId !== credential._id) {
      throw new Error('Enrollment not found');
    }
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }

    await ctx.db.patch(enrollment._id, {
      pendingSpoolBytes: args.pendingSpoolBytes,
      localError: args.localError,
      localObservedAt: args.observedAt,
    });
    return null;
  },
});

export const upsertSessionIntegrity = internalMutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    source: archiveSupportedSourceValidator,
    sourceSessionId: v.string(),
    errorClass: v.optional(v.string()),
    repairOutcome: v.optional(v.string()),
  },
  returns: archiveSessionIntegrityValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    if (!credential) throw new Error('Collector Credential not found');
    const slot = await getEnrollmentSlot(ctx, credential.orgId, credential._id);
    const enrollment = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;
    if (!enrollment) throw new Error('Enrollment not found');

    const now = Date.now();
    const existing = await ctx.db
      .query('archiveSessionIntegrity')
      .withIndex('by_org_session', (q) =>
        q
          .eq('orgId', credential.orgId)
          .eq('source', args.source)
          .eq('sourceSessionId', args.sourceSessionId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        contributionId: enrollment.contributionId,
        errorClass: args.errorClass,
        repairOutcome: args.repairOutcome,
        updatedAt: now,
      });
      return {
        source: args.source,
        sourceSessionId: args.sourceSessionId,
        errorClass: args.errorClass,
        repairOutcome: args.repairOutcome,
        updatedAt: now,
      };
    }

    await ctx.db.insert('archiveSessionIntegrity', {
      orgId: credential.orgId,
      contributionId: enrollment.contributionId,
      source: args.source,
      sourceSessionId: args.sourceSessionId,
      errorClass: args.errorClass,
      repairOutcome: args.repairOutcome,
      updatedAt: now,
    });
    return {
      source: args.source,
      sourceSessionId: args.sourceSessionId,
      errorClass: args.errorClass,
      repairOutcome: args.repairOutcome,
      updatedAt: now,
    };
  },
});

export const syncLifecycleForOrg = internalMutation({
  args: { orgId: v.id('organizations') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    await syncArchiveLifecycleForEntitlement(ctx, args.orgId, subscription, Date.now());
    return null;
  },
});

export const invalidateEnrollmentsForRemovedUser = internalMutation({
  args: {
    orgId: v.id('organizations'),
    userId: v.id('users'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await invalidateArchiveEnrollmentsForUser(ctx, {
      orgId: args.orgId,
      userId: args.userId,
      reason: 'member_removed',
    });
    return null;
  },
});

export const getCapMetadata = internalQuery({
  args: { orgId: v.id('organizations') },
  returns: v.object({
    capBytes: v.number(),
    graceDeadlineAt: v.union(v.number(), v.null()),
    entitled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const activation = await getArchiveActivation(ctx, args.orgId);
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    return {
      capBytes: activation?.capBytes ?? ARCHIVE_CAP_BYTES,
      graceDeadlineAt: activation?.graceDeadlineAt ?? null,
      entitled: isActiveProSubscription(subscription),
    };
  },
});
