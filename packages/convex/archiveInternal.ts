import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  archiveLifecycleValidator,
  archiveSourceAuthorizationInputValidator,
  archiveSessionIntegrityValidator,
  archiveSupportedSourceValidator,
  archiveWriteDenialReasonValidator,
} from './validators';
import {
  ARCHIVE_CAP_BYTES,
  applyCollectorHeartbeat,
  assertArchiveAuthorityReductionAllowed,
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
  isCollectorCredentialExpired,
  pickOldestDocument,
  projectLifecycle,
  sourceAlreadyAuthorized,
  resolveServerLifecycle,
  serverStatusPayloadEquals,
  syncArchiveLifecycleForEntitlement,
  type ArchiveSupportedSource,
  type ArchiveWriteDenialReason,
} from './archiveLib';
import { activateArchiveCore, addSourceCore, enrollCollectorCore } from './archiveEnrollmentCore';
import {
  repairEnrollmentSlots,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
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

const collectorEnrollmentResultValidator = v.union(
  v.object({
    enrolled: v.literal(true),
    authorizedSources: v.array(
      v.object({
        source: archiveSupportedSourceValidator,
        historyChoice: v.union(v.literal('new_only'), v.literal('all_history')),
        authorizedAt: v.number(),
      }),
    ),
    reason: v.null(),
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
    collectorCredentialId: v.id('collectorCredentials'),
  }),
  v.object({
    enrolled: v.literal(false),
    authorizedSources: v.array(
      v.object({
        source: archiveSupportedSourceValidator,
        historyChoice: v.union(v.literal('new_only'), v.literal('all_history')),
        authorizedAt: v.number(),
      }),
    ),
    reason: archiveWriteDenialReasonValidator,
  }),
);

function enrollmentDenied(reason: ArchiveWriteDenialReason) {
  return { enrolled: false as const, authorizedSources: [], reason };
}

export const enrollCollectorByHashedSecret = internalMutation({
  args: {
    hashedSecret: v.string(),
    authorizedSources: v.array(archiveSourceAuthorizationInputValidator),
    idempotencyKey: v.string(),
    orgId: v.id('organizations'),
    userId: v.id('users'),
    collectorId: v.string(),
    now: v.number(),
  },
  returns: collectorEnrollmentResultValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query('collectorCredentials')
      .withIndex('by_hashed_secret', (q) => q.eq('hashedSecret', args.hashedSecret))
      .unique();
    if (
      credential?.orgId !== args.orgId ||
      credential.userId !== args.userId ||
      credential.collectorId !== args.collectorId
    ) {
      return enrollmentDenied('not_enrolled');
    }
    if (isCollectorCredentialExpired(credential, args.now) || credential.status !== 'active') {
      return enrollmentDenied('credential_revoked');
    }

    const user = await ctx.db.get(credential.userId);
    if (!user?.enabled || user.orgId !== credential.orgId) return enrollmentDenied('not_enrolled');
    const membership = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user_id', (q) => q.eq('userId', credential.userId))
      .filter((q) => q.eq(q.field('orgId'), credential.orgId))
      .first();
    if (membership?.status !== 'active') return enrollmentDenied('not_enrolled');

    if (!isArchiveServerEnabled()) return enrollmentDenied('server_disabled');
    const org = await ctx.db.get(credential.orgId);
    if (!org || org.deletedAt !== undefined || org.deletionStartedAt !== undefined) {
      return enrollmentDenied('deleting');
    }
    let activation = await getArchiveActivation(ctx, credential.orgId);
    if (activation?.status === 'deleting') return enrollmentDenied('deleting');
    if (activation?.status === 'frozen') return enrollmentDenied('frozen');
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', credential.orgId))
      .first();
    if (!isActiveProSubscription(subscription)) return enrollmentDenied('not_pro');

    if (!activation) {
      const ownsOrganization = org.ownerId === credential.userId && membership.role === 'owner';
      if (!ownsOrganization) return enrollmentDenied('not_activated');
      await activateArchiveCore(ctx, {
        orgId: credential.orgId,
        actorUserId: credential.userId,
        now: args.now,
      });
      activation = await getArchiveActivation(ctx, credential.orgId);
      if (!activation) throw new Error('Conversation Archive activation failed');
    }

    const sources = validateAuthorizedSources(args.authorizedSources);
    validateEnrollmentIdempotencyKey(args.idempotencyKey);
    const slot = await repairEnrollmentSlots(ctx, credential.orgId, credential._id);
    let enrollment = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;
    if (enrollment?.status === 'active') {
      for (const source of sources) {
        const existing = enrollment.authorizedSources.find((row) => row.source === source.source);
        if (
          existing?.historyChoice !== undefined &&
          existing.historyChoice !== source.historyChoice
        ) {
          throw new Error('consent_conflict');
        }
        enrollment = await addSourceCore(ctx, {
          enrollment,
          source: source.source,
          historyChoice: source.historyChoice,
          now: args.now,
        });
      }
    } else {
      const result = await enrollCollectorCore(ctx, {
        orgId: credential.orgId,
        userId: credential.userId,
        credential,
        sources,
        idempotencyKey: args.idempotencyKey,
        now: args.now,
      });
      enrollment = await ctx.db.get(result.enrollmentId);
    }
    if (enrollment?.status !== 'active') {
      return enrollmentDenied('enrollment_invalid');
    }
    return {
      enrolled: true as const,
      authorizedSources: enrollment.authorizedSources,
      reason: null,
      orgId: credential.orgId,
      userId: credential.userId,
      collectorId: credential.collectorId,
      collectorCredentialId: credential._id,
    };
  },
});

async function authorizeArchiveWriteForCredential(
  ctx: QueryCtx | MutationCtx,
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
    now: v.number(),
  },
  returns: archiveWriteAuthorizationWithTenancyValidator,
  handler: async (ctx, args) => authorizeArchiveWriteByHashedSecretCore(ctx, args),
});

export async function authorizeArchiveWriteByHashedSecretCore(
  ctx: QueryCtx | MutationCtx,
  args: {
    hashedSecret: string;
    source: ArchiveSupportedSource;
    orgId: Id<'organizations'>;
    userId: Id<'users'>;
    collectorId: string;
    now: number;
  },
) {
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
  if (isCollectorCredentialExpired(credential, args.now)) {
    return { allowed: false as const, reason: 'credential_revoked' as const };
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
}

async function applyServerStatusForOrganization(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    revision: number;
    storedBytes?: number;
    lastDurableAcknowledgedAt?: number;
    lifecycle?: 'not_enabled' | 'active' | 'blocked' | 'frozen' | 'deleting';
  },
): Promise<{ revision: number; replay: boolean }> {
  const org = await ctx.db.get(args.orgId);

  const activation = await getArchiveActivation(ctx, args.orgId);
  assertArchiveMutationAllowed({
    org,
    activation,
    serverEnabled: isArchiveServerEnabled(),
  });
  if (!activation) throw new Error('Conversation Archive is not activated');

  const now = Date.now();
  const existing = await getArchiveStatusRow(ctx, args.orgId);
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
  if (decision === 'replay') return { revision: args.revision, replay: true };
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
      orgId: args.orgId,
      lifecycle,
      capBytes: activation.capBytes,
      graceDeadlineAt: activation.graceDeadlineAt,
      now,
    });
    const created = await getArchiveStatusRow(ctx, args.orgId);
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
  return { revision: args.revision, replay: false };
}

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
    await applyServerStatusForOrganization(ctx, {
      orgId: credential.orgId,
      revision: args.revision,
      storedBytes: args.storedBytes,
      lastDurableAcknowledgedAt: args.lastDurableAcknowledgedAt,
      lifecycle: args.lifecycle,
    });
    return null;
  },
});

export const applyServerStatusByOrganization = internalMutation({
  args: {
    orgId: v.id('organizations'),
    revision: v.number(),
    storedBytes: v.number(),
    lastDurableAcknowledgedAt: v.optional(v.number()),
    lifecycle: v.optional(archiveLifecycleValidator),
  },
  returns: v.object({ revision: v.number(), replay: v.boolean() }),
  handler: async (ctx, args) => {
    return await applyServerStatusForOrganization(ctx, args);
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
      if (
        existing.errorClass === args.errorClass &&
        existing.repairOutcome === args.repairOutcome
      ) {
        return {
          contributionId: existing.contributionId,
          source: existing.source,
          sourceSessionId: existing.sourceSessionId,
          errorClass: existing.errorClass,
          repairOutcome: existing.repairOutcome,
          updatedAt: existing.updatedAt,
        };
      }
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

export const applySessionRepairOutcome = internalMutation({
  args: {
    contributionId: v.id('archiveContributions'),
    expectedOrgId: v.id('organizations'),
    expectedUserId: v.id('users'),
    source: archiveSupportedSourceValidator,
    sourceSessionId: v.string(),
    repairOutcome: v.union(v.literal('failure'), v.literal('success')),
  },
  returns: archiveSessionIntegrityValidator,
  handler: async (ctx, args) => {
    const contribution = await ctx.db.get(args.contributionId);
    if (contribution?.orgId !== args.expectedOrgId || contribution.userId !== args.expectedUserId) {
      throw new Error('Archive contribution binding mismatch');
    }
    const org = await ctx.db.get(contribution.orgId);
    const activation = await getArchiveActivation(ctx, contribution.orgId);
    assertArchiveAuthorityReductionAllowed({ org, activation });
    const enrollments = await ctx.db
      .query('archiveEnrollments')
      .withIndex('by_contribution', (q) => q.eq('contributionId', contribution._id))
      .collect();
    if (
      !enrollments.some(
        (enrollment) =>
          enrollment.orgId === contribution.orgId &&
          enrollment.userId === contribution.userId &&
          sourceAlreadyAuthorized(enrollment.authorizedSources, args.source),
      )
    ) {
      throw new Error('Source enrollment not found');
    }

    const now = Date.now();
    const existingRows = await ctx.db
      .query('archiveSessionIntegrity')
      .withIndex('by_org_contribution_session', (q) =>
        q
          .eq('orgId', contribution.orgId)
          .eq('contributionId', contribution._id)
          .eq('source', args.source)
          .eq('sourceSessionId', args.sourceSessionId),
      )
      .collect();
    const existing = pickOldestDocument(existingRows);
    const errorClass = args.repairOutcome === 'success' ? undefined : existing?.errorClass;
    if (existing) {
      if (existing.errorClass === errorClass && existing.repairOutcome === args.repairOutcome) {
        return {
          contributionId: existing.contributionId,
          source: existing.source,
          sourceSessionId: existing.sourceSessionId,
          errorClass: existing.errorClass,
          repairOutcome: existing.repairOutcome,
          updatedAt: existing.updatedAt,
        };
      }
      await ctx.db.patch(existing._id, {
        errorClass,
        repairOutcome: args.repairOutcome,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert('archiveSessionIntegrity', {
        orgId: contribution.orgId,
        contributionId: contribution._id,
        source: args.source,
        sourceSessionId: args.sourceSessionId,
        errorClass,
        repairOutcome: args.repairOutcome,
        updatedAt: now,
      });
    }
    return {
      contributionId: contribution._id,
      source: args.source,
      sourceSessionId: args.sourceSessionId,
      errorClass,
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
