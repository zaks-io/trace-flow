import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';

export async function requireEnabledActionUser(ctx: ActionCtx): Promise<Doc<'users'>> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Authentication required');

  const user = await ctx.runQuery(internal.auth.users.getUserByTokenIdentifier, {
    tokenIdentifier: identity.tokenIdentifier,
  });
  if (!user) throw new Error('User not found. Please log in again.');
  if (!user.enabled) {
    throw new Error('User account is not enabled. Please contact support.');
  }
  return user;
}
