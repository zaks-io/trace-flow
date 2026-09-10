import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

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

export async function getActiveOrganizationMembership(ctx: AuthContext, user: Doc<'users'>) {
  if (!user.enabled || !user.orgId) return null;
  const organization = await ctx.db.get(user.orgId);
  if (!isLiveOrganization(organization)) return null;
  const membership = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user_id', (q) => q.eq('userId', user._id))
    .filter((q) => q.eq(q.field('orgId'), user.orgId))
    .first();
  if (membership?.status !== 'active') return null;
  return { user, organization, membership, orgId: user.orgId };
}

export async function requireActiveOrganizationMembership(ctx: AuthContext) {
  const user = await requireEnabledUser(ctx);
  const active = await getActiveOrganizationMembership(ctx, user);
  if (!active) throw new Error('Active organization membership required');
  return active;
}
