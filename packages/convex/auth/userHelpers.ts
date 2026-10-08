import {
  internalQuery,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';

type AuthContext = QueryCtx | MutationCtx;

export async function getCurrentUser(ctx: AuthContext): Promise<Doc<'users'> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }

  return await ctx.db
    .query('users')
    .withIndex('by_token_identifier', (q) => q.eq('tokenIdentifier', identity.tokenIdentifier))
    .first();
}

/** Preserve bootstrap's null state while refusing product data to disabled accounts. */
export async function getCurrentEnabledUser(ctx: AuthContext): Promise<Doc<'users'> | null> {
  const user = await getCurrentUser(ctx);
  if (user && !user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  return user;
}

export async function requireEnabledUser(ctx: AuthContext): Promise<Doc<'users'>> {
  const user = await getCurrentEnabledUser(ctx);
  if (!user) {
    throw new Error('User not found. Please log in again.');
  }
  return user;
}

export function isLiveOrganization(
  organization: Doc<'organizations'> | null,
): organization is Doc<'organizations'> {
  return Boolean(
    organization &&
    organization.deletionStartedAt === undefined &&
    organization.deletedAt === undefined,
  );
}

export async function getActiveOrganizationMembership(ctx: AuthContext, user: Doc<'users'> | null) {
  if (!user?.enabled || !user.orgId) return null;
  const organization = await ctx.db.get(user.orgId);
  if (!isLiveOrganization(organization)) return null;
  const membership = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .filter((q) => q.eq(q.field('orgId'), user.orgId))
    .first();
  // Legacy owners can lack a row until the post-deploy migration. A removed row still denies access.
  if (membership ? membership.status !== 'active' : organization.ownerId !== user._id) return null;
  return { user: { ...user, orgId: user.orgId }, organization, membership, orgId: user.orgId };
}

type ActiveMembership = NonNullable<Awaited<ReturnType<typeof getActiveOrganizationMembership>>>;

const membershipForAction = makeFunctionReference<
  'query',
  { ownerOnly: boolean; userId?: Id<'users'> },
  ActiveMembership
>('auth/userHelpers:requireMembershipForAction');

export async function requireActiveOrganizationMembership(
  ctx: AuthContext | ActionCtx,
): Promise<ActiveMembership> {
  if (!('db' in ctx)) return ctx.runQuery(membershipForAction, { ownerOnly: false });
  const user = await requireEnabledUser(ctx);
  const active = await getActiveOrganizationMembership(ctx, user);
  if (!active) throw new Error('Active organization membership required');
  return active;
}

export async function requireOrganizationOwner(
  ctx: AuthContext | ActionCtx,
): Promise<ActiveMembership> {
  if (!('db' in ctx)) return ctx.runQuery(membershipForAction, { ownerOnly: true });
  const active = await requireActiveOrganizationMembership(ctx);
  if (active.organization.ownerId !== active.user._id) {
    throw new Error('Only the organization owner can manage the organization');
  }
  return active;
}

export const requireMembershipForAction = internalQuery({
  args: { ownerOnly: v.boolean(), userId: v.optional(v.id('users')) },
  handler: async (ctx, args): Promise<ActiveMembership> => {
    if (args.userId) {
      const user = await ctx.db.get(args.userId);
      const active = await getActiveOrganizationMembership(ctx, user);
      if (!active) throw new Error('Active organization membership required');
      return active;
    }
    return args.ownerOnly
      ? requireOrganizationOwner(ctx)
      : requireActiveOrganizationMembership(ctx);
  },
});
