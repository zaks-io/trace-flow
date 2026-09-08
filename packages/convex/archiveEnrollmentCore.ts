import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import {
  activationOperationId,
  appendArchiveAuditEvent,
  enrollmentOperationId,
} from './archiveAuditLib';
import {
  ARCHIVE_CAP_BYTES,
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
  refreshArchiveStatusCounts,
  repairEnrollmentSlots,
  sourceAlreadyAuthorized,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
  type ArchiveHistoryChoice,
  type ArchiveSourceAuthorizationInput,
  type ArchiveSupportedSource,
} from './archiveLib';

export async function activateArchiveCore(
  ctx: MutationCtx,
  args: { orgId: Id<'organizations'>; actorUserId: Id<'users'>; now: number },
) {
  const existing = await getArchiveActivation(ctx, args.orgId);
  if (existing) return { activationId: existing._id, created: false };

  const insertedId = await ctx.db.insert('archiveActivations', {
    orgId: args.orgId,
    activatedByUserId: args.actorUserId,
    activatedAt: args.now,
    capBytes: ARCHIVE_CAP_BYTES,
    status: 'active',
  });
  const winner = await claimArchiveActivation(ctx, args.orgId);
  const activationId = winner?._id ?? insertedId;
  if (activationId !== insertedId) return { activationId, created: false };

  await ensureArchiveStatusRow(ctx, {
    orgId: args.orgId,
    lifecycle: 'active',
    capBytes: ARCHIVE_CAP_BYTES,
    now: args.now,
  });
  await appendArchiveAuditEvent(ctx, {
    orgId: args.orgId,
    actorKind: 'user',
    actorUserId: args.actorUserId,
    action: 'activation',
    outcome: 'success',
    operationId: activationOperationId(args.orgId),
    targetKind: 'activation',
    targetId: activationId,
    activationId,
    now: args.now,
  });
  return { activationId, created: true };
}

export async function enrollCollectorCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<'organizations'>;
    userId: Id<'users'>;
    credential: Doc<'collectorCredentials'>;
    sources: ArchiveSourceAuthorizationInput[];
    idempotencyKey: string;
    now: number;
  },
) {
  const sources = validateAuthorizedSources(args.sources);
  const idempotencyKey = validateEnrollmentIdempotencyKey(args.idempotencyKey);
  const existingByKey = await getEnrollmentByIdempotencyKey(ctx, args.orgId, idempotencyKey);
  const slot = await repairEnrollmentSlots(ctx, args.orgId, args.credential._id);
  const current = slot ? await ctx.db.get(slot.currentEnrollmentId) : null;
  const decision = decideEnrollmentAction({
    existingByKey,
    currentEnrollment: current,
    request: {
      userId: args.userId,
      collectorCredentialId: args.credential._id,
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
      (existingByKey.userId !== args.userId ||
        existingByKey.collectorCredentialId !== args.credential._id)
    ) {
      throw new Error('Enrollment idempotency key is already bound to another Collector');
    }
    throw new Error('Enrollment idempotency key does not match the original consent');
  }
  if (decision === 'already_enrolled') throw new Error('Collector is already enrolled');

  const contribution = await claimContributionForUser(ctx, args.orgId, args.userId, args.now);
  const enrollmentId = await ctx.db.insert('archiveEnrollments', {
    orgId: args.orgId,
    userId: args.userId,
    collectorCredentialId: args.credential._id,
    collectorId: args.credential.collectorId,
    contributionId: contribution._id,
    idempotencyKey,
    consentSources: sources,
    authorizedSources: sources.map((source) => ({ ...source, authorizedAt: args.now })),
    status: 'active',
    createdAt: args.now,
  });

  const claimedByKey = await claimEnrollmentByIdempotencyKey(
    ctx,
    args.orgId,
    idempotencyKey,
    enrollmentId,
  );
  if (!claimedByKey.created) {
    if (
      claimedByKey.enrollment.userId !== args.userId ||
      claimedByKey.enrollment.collectorCredentialId !== args.credential._id
    ) {
      throw new Error('Enrollment idempotency key is already bound to another Collector');
    }
    if (!consentSourcesMatch(claimedByKey.enrollment.consentSources, sources)) {
      throw new Error('Enrollment idempotency key does not match the original consent');
    }
    await refreshArchiveStatusCounts(ctx, args.orgId, args.now);
    return {
      enrollmentId: claimedByKey.enrollment._id,
      contributionId: claimedByKey.enrollment.contributionId,
      created: false,
    };
  }

  if (slot) {
    await ctx.db.patch(slot._id, { currentEnrollmentId: enrollmentId });
  } else {
    const claimed = await claimEnrollmentSlot(ctx, args.orgId, args.credential._id, enrollmentId);
    if (!claimed.created) {
      const winner = await ctx.db.get(claimed.enrollmentId);
      if (!winner) throw new Error('Enrollment not found');
      if (winner.idempotencyKey !== idempotencyKey) {
        await ctx.db.delete(enrollmentId);
        throw new Error('Collector is already enrolled');
      }
      await refreshArchiveStatusCounts(ctx, args.orgId, args.now);
      return {
        enrollmentId: winner._id,
        contributionId: winner.contributionId,
        created: false,
      };
    }
  }

  const status = await getArchiveStatusRow(ctx, args.orgId);
  if (status) {
    await refreshArchiveStatusCounts(ctx, args.orgId, args.now);
  } else {
    await ensureArchiveStatusRow(ctx, {
      orgId: args.orgId,
      lifecycle: 'active',
      capBytes: ARCHIVE_CAP_BYTES,
      now: args.now,
    });
  }
  await appendArchiveAuditEvent(ctx, {
    orgId: args.orgId,
    actorKind: 'user',
    actorUserId: args.userId,
    action: 'enrollment',
    outcome: 'success',
    operationId: await enrollmentOperationId(args.orgId, idempotencyKey),
    targetKind: 'enrollment',
    targetId: enrollmentId,
    enrollmentId,
    contributionId: contribution._id,
    now: args.now,
  });
  return { enrollmentId, contributionId: contribution._id, created: true };
}

export async function addSourceCore(
  ctx: MutationCtx,
  args: {
    enrollment: Doc<'archiveEnrollments'>;
    source: ArchiveSupportedSource;
    historyChoice: ArchiveHistoryChoice;
    now: number;
  },
) {
  validateAuthorizedSources([{ source: args.source, historyChoice: args.historyChoice }]);
  const existing = args.enrollment.authorizedSources.find((row) => row.source === args.source);
  if (existing) return args.enrollment;
  if (sourceAlreadyAuthorized(args.enrollment.authorizedSources, args.source)) {
    return args.enrollment;
  }

  await ctx.db.patch(args.enrollment._id, {
    authorizedSources: [
      ...args.enrollment.authorizedSources,
      { source: args.source, historyChoice: args.historyChoice, authorizedAt: args.now },
    ],
  });
  const updated = await ctx.db.get(args.enrollment._id);
  if (!updated) throw new Error('Enrollment not found');
  return updated;
}
