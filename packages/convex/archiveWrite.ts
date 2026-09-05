import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  activationOperationId,
  appendArchiveAuditEvent,
  enrollmentOperationId,
} from './archiveAuditLib';
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
  getOrgSubscription,
  invalidateArchiveEnrollment,
  isActiveProSubscription,
  isArchiveServerEnabled,
  refreshArchiveStatusCounts,
  repairEnrollmentSlots,
  sourceAlreadyAuthorized,
  validateAuthorizedSources,
  validateEnrollmentIdempotencyKey,
} from './archiveLib';

type OrgUser = Doc<'users'> & { orgId: Id<'organizations'> };

export async function requireArchiveWritable(ctx: MutationCtx, orgId: Id<'organizations'>) {
  if (!isArchiveServerEnabled()) {
    throw new Error('Conversation Archive is not enabled');
  }
  const activation = await getArchiveActivation(ctx, orgId);
  const org = await ctx.db.get(orgId);
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
  const subscription = await getOrgSubscription(ctx, orgId);
  if (!isActiveProSubscription(subscription)) {
    throw new Error('Active Pro entitlement is required');
  }
  return { activation, subscription };
}

export async function activateArchiveForOwner(
  ctx: MutationCtx,
  user: OrgUser,
  org: Doc<'organizations'>,
  membership: { role: string },
) {
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
}

export async function enrollArchiveForUser(
  ctx: MutationCtx,
  user: OrgUser,
  credential: Doc<'collectorCredentials'>,
  authorizedSources: {
    source: 'claude' | 'codex';
    historyChoice: 'new_only' | 'all_history';
  }[],
  rawIdempotencyKey: string,
) {
  await requireArchiveWritable(ctx, user.orgId);
  const sources = validateAuthorizedSources(authorizedSources);
  const idempotencyKey = validateEnrollmentIdempotencyKey(rawIdempotencyKey);
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
      (existingByKey.userId !== user._id || existingByKey.collectorCredentialId !== credential._id)
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
}

export async function addAuthorizedArchiveSource(
  ctx: MutationCtx,
  user: OrgUser,
  enrollmentId: Id<'archiveEnrollments'>,
  source: 'claude' | 'codex',
  historyChoice: 'new_only' | 'all_history',
) {
  await requireArchiveWritable(ctx, user.orgId);
  const enrollment = await ctx.db.get(enrollmentId);
  if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
    throw new Error('Enrollment not found');
  }
  if (enrollment.status !== 'active') {
    throw new Error('Enrollment is not active');
  }
  validateAuthorizedSources([{ source, historyChoice }]);
  if (sourceAlreadyAuthorized(enrollment.authorizedSources, source)) {
    return enrollment;
  }
  const now = Date.now();
  await ctx.db.patch(enrollment._id, {
    authorizedSources: [
      ...enrollment.authorizedSources,
      { source, historyChoice, authorizedAt: now },
    ],
  });
  const updated = await ctx.db.get(enrollment._id);
  if (!updated) throw new Error('Enrollment not found');
  return updated;
}

export async function unenrollArchiveForUser(
  ctx: MutationCtx,
  user: OrgUser,
  enrollmentId: Id<'archiveEnrollments'>,
) {
  const enrollment = await ctx.db.get(enrollmentId);
  if (enrollment?.orgId !== user.orgId || enrollment.userId !== user._id) {
    throw new Error('Enrollment not found');
  }
  await invalidateArchiveEnrollment(ctx, enrollment, 'user_unenrolled', Date.now(), user._id);
}

export async function revokeArchiveEnrollmentForOwner(
  ctx: MutationCtx,
  user: OrgUser,
  org: Doc<'organizations'>,
  membership: { role: string },
  enrollmentId: Id<'archiveEnrollments'>,
) {
  if (org.ownerId !== user._id || membership.role !== 'owner') {
    throw new Error('Only the organization owner can revoke enrollments');
  }
  const enrollment = await ctx.db.get(enrollmentId);
  if (enrollment?.orgId !== user.orgId) {
    throw new Error('Enrollment not found');
  }
  await invalidateArchiveEnrollment(ctx, enrollment, 'owner_revoked', Date.now(), user._id);
}
