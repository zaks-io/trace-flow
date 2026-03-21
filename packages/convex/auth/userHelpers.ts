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

export async function requireEnabledUser(ctx: AuthContext): Promise<Doc<'users'>> {
  const user = await getCurrentUser(ctx);
  if (!user) {
    throw new Error('User not found. Please log in again.');
  }
  if (!user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  return user;
}
