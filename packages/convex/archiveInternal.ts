import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  archiveLifecycleValidator,
  archiveSessionIntegrityValidator,
  archiveSupportedSourceValidator,
  archiveWriteDenialReasonValidator,
} from './validators';
import {
  ARCHIVE_CAP_BYTES,
  applyCollectorHeartbeat,
  assertArchiveMutationAllowed,
  isOrganizationDeleted,
  isOrganizationDeletionStarted,
  assertVersionedUpdate,
  decideVersionedUpdate,
  decideWriteAuthorization,
  enrollmentAllowsSource,
  ensureArchiveStatusRow,
  getArchiveActivation,
  getArchiveStatusRow,
  getEnrollmentSlot,
  invalidateArchiveEnrollmentsForUser,
  isActiveProSubscription,
  isArchiveServerEnabled,
  pickOldestDocument,
  projectLifecycle,
  resolveServerLifecycle,
  serverStatusPayloadEquals,
  syncArchiveLifecycleForEntitlement,
  type ArchiveSupportedSource,
  type ArchiveWriteDenialReason,
} from './archiveLib';

const archiveWriteAuthorizationResultValidator = v.union(
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
);

const archiveWriteAuthorizationWithTenancyValidator = v.union(
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
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
    collectorCredentialId: v.id('collectorCredentials'),
  }),
  v.object({
    allowed: v.literal(false),
    reason: archiveWriteDenialReasonValidator,
  }),
);

async function authorizeArchiveWriteForCredential(
  ctx: QueryCtx,
  credential: Doc<'collectorCredentials'> | null,
  source: ArchiveSupportedSource,
): Promise<
  | {
      allowed: true;
      enrollmentId: Id<'archiveEnrollments'>;
      contributionId: Id<'archiveContributions'>;
      authorizedSources: Doc<'archiveEnrollments'>['authorizedSources'];
    }
  | { allowed: false; reason: ArchiveWriteDenialReason }
> {
  const org = credential ? await ctx.db.get(credential.orgId) : null;
  if (credential && (isOrganizationDeleted(org) || isOrganizationDeletionStarted(org))) {
    return { allowed: false as const, reason: 'deleting' as const };
  }
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
    source,
  });
  if (!decision.allowed) return decision;
  if (!enrollment) return { allowed: false as const, reason: 'not_enrolled' as const };

  return {
    allowed: true as const,
    enrollmentId: enrollment._id,
    contributionId: enrollment.contributionId,
    authorizedSources: enrollment.authorizedSources,
  };
}

export const authorizeArchiveWrite = internalQuery({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    source: archiveSupportedSourceValidator,
  },
  returns: archiveWriteAuthorizationResultValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    return authorizeArchiveWriteForCredential(ctx, credential, args.source);
  },
});

export const authorizeArchiveWriteByHashedSecret = internalQuery({
  args: {
    hashedSecret: v.string(),
    source: archiveSupportedSourceValidator,
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
  },
  returns: archiveWriteAuthorizationWithTenancyValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query('collectorCredentials')
      .withIndex('by_hashed_secret', (q) => q.eq('hashedSecret', args.hashedSecret))
      .unique();
    if (credential == null) {
      return { allowed: false as const, reason: 'not_enrolled' as const };
    }
    if (
      credential.orgId !== args.orgId ||
      credential.userId !== args.userId ||
      credential.collectorId !== args.collectorId
    ) {
      return { allowed: false as const, reason: 'not_enrolled' as const };
    }

    const decision = await authorizeArchiveWriteForCredential(ctx, credential, args.source);
    if (!decision.allowed) return decision;
    return {
      ...decision,
      orgId: credential.orgId,
      userId: credential.userId,
      collectorId: credential.collectorId,
      collectorCredentialId: credential._id,
    };
  },
});

export const applyServerStatus = internalMutation({
  args: {
    collectorCredentialId: v.id('collectorCredentials'),
    revision: v.number(),
    storedBytes: v.optional(v.number()),
    lastDurableAcknowledgedAt: v.optional(v.number()),
    lifecycle: v.optional(archiveLifecycleValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get(args.collectorCredentialId);
    if (!credential) throw new Error('Collector Credential not found');
    const org = await ctx.db.get(credential.orgId);

    const activation = await getArchiveActivation(ctx, credential.orgId);
    assertArchiveMutationAllowed({
      org,
      activation,
      serverEnabled: isArchiveServerEnabled(),
    });
    if (!activation) throw new Error('Conversation Archive is not activated');

    const now = Date.now();
    const existing = await getArchiveStatusRow(ctx, credential.orgId);
    const storedBytes = args.storedBytes ?? existing?.storedBytes ?? 0;
    const lastDurableAcknowledgedAt =
      args.lastDurableAcknowledgedAt ?? existing?.lastDurableAcknowledgedAt;
    const requested =
      args.lifecycle ??
      projectLifecycle({
        activation: { status: activation.status },
        storedBytes,
        capBytes: activation.capBytes,
      });
    const lifecycle = resolveServerLifecycle(activation.status, requested);
    const incoming = { storedBytes, lastDurableAcknowledgedAt, lifecycle };
    const decision = decideVersionedUpdate({
      storedVersion: existing?.serverRevision,
      incomingVersion: args.revision,
      payloadEquals: existing ? serverStatusPayloadEquals(existing, incoming) : false,
    });
    if (decision === 'replay') return null;
    assertVersionedUpdate(decision, 'server_status');

    if (existing) {
      await ctx.db.patch(existing._id, {
        storedBytes,
        lastDurableAcknowledgedAt,
        lifecycle,
        capBytes: activation.capBytes,
        graceDeadlineAt: activation.graceDeadlineAt,
        serverRevision: args.revision,
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
      if (created) {
        await ctx.db.patch(created._id, {
          storedBytes,
          lastDurableAcknowledgedAt,
          lifecycle,
          serverRevision: args.revision,
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
    if (credential.status !== 'active') {
      throw new Error('Collector Credential is not active');
    }
    const org = await ctx.db.get(credential.orgId);
    const activation = await getArchiveActivation(ctx, credential.orgId);
    assertArchiveMutationAllowed({
      org,
      activation,
      serverEnabled: isArchiveServerEnabled(),
    });
    const slot = await getEnrollmentSlot(ctx, credential.orgId, credential._id);
    if (!slot) throw new Error('Enrollment not found');
    const enrollment = await ctx.db.get(slot.currentEnrollmentId);
    if (enrollment?.collectorCredentialId !== credential._id) {
      throw new Error('Enrollment not found');
    }
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }

    await applyCollectorHeartbeat(ctx, enrollment, args);
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
    if (credential.status !== 'active') {
      throw new Error('Collector Credential is not active');
    }
    const org = await ctx.db.get(credential.orgId);
    const activation = await getArchiveActivation(ctx, credential.orgId);
    assertArchiveMutationAllowed({
      org,
      activation,
      serverEnabled: isArchiveServerEnabled(),
    });
    const slot = await getEnrollmentSlot(ctx, credential.orgId, credential._id);
    const enrollment = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;
    if (!enrollment) throw new Error('Enrollment not found');
    if (enrollment.status !== 'active') {
      throw new Error('Enrollment is not active');
    }
    if (!enrollmentAllowsSource(enrollment, args.source)) {
      throw new Error('Source is not authorized');
    }

    const now = Date.now();
    const existingRows = await ctx.db
      .query('archiveSessionIntegrity')
      .withIndex('by_org_contribution_session', (q) =>
        q
          .eq('orgId', credential.orgId)
          .eq('contributionId', enrollment.contributionId)
          .eq('source', args.source)
          .eq('sourceSessionId', args.sourceSessionId),
      )
      .collect();
    const existing = pickOldestDocument(existingRows);

    if (existing) {
      await ctx.db.patch(existing._id, {
        errorClass: args.errorClass,
        repairOutcome: args.repairOutcome,
        updatedAt: now,
      });
      return {
        contributionId: existing.contributionId,
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
      contributionId: enrollment.contributionId,
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
    const org = await ctx.db.get(args.orgId);
    if (!org || isOrganizationDeleted(org) || isOrganizationDeletionStarted(org)) return null;

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
