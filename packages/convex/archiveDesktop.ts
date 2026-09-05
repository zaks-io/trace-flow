import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import {
  archiveHistoryChoiceValidator,
  archiveSourceAuthorizationInputValidator,
  archiveSupportedSourceValidator,
} from './validators';
import {
  getArchiveActivation,
  getOrgSubscription,
  isArchiveServerEnabled,
  requireActiveMembership,
} from './archiveLib';
import {
  activateArchiveForOwner,
  addAuthorizedArchiveSource,
  enrollArchiveForUser,
  revokeArchiveEnrollmentForOwner,
  unenrollArchiveForUser,
} from './archiveWrite';

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

function planStatusOf(
  subscription: { status: string } | null,
): 'active' | 'inactive' | 'canceled' | 'none' {
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
    const activationState = !activation
      ? ('not_enabled' as const)
      : activation.status === 'frozen'
        ? ('frozen' as const)
        : activation.status === 'deleting'
          ? ('deleting' as const)
          : ('active' as const);
    return {
      userId: user._id,
      orgId: user.orgId,
      role:
        org.ownerId === user._id && membership.role === 'owner'
          ? ('owner' as const)
          : ('member' as const),
      plan: subscription?.tier === 'pro' ? ('pro' as const) : ('hobby' as const),
      planStatus: planStatusOf(subscription),
      serverEnabled: isArchiveServerEnabled(),
      activation: activationState,
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
    return await activateArchiveForOwner(ctx, user, org, membership);
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
    const { user } = await loadOrgUser(ctx, args.userId);
    const credential = await findCollectorCredential(ctx, user, args.collectorId);
    return await enrollArchiveForUser(
      ctx,
      user,
      credential,
      args.authorizedSources,
      args.idempotencyKey,
    );
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
    const { user } = await loadOrgUser(ctx, args.userId);
    await addAuthorizedArchiveSource(ctx, user, args.enrollmentId, args.source, args.historyChoice);
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
    await unenrollArchiveForUser(ctx, user, args.enrollmentId);
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
    await revokeArchiveEnrollmentForOwner(ctx, user, org, membership, args.enrollmentId);
    return null;
  },
});
