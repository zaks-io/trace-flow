import { type QueryCtx, type MutationCtx, type ActionCtx } from '../_generated/server';

type AuthContext = QueryCtx | MutationCtx | ActionCtx;

/** Requires a valid Convex auth session (Auth0 identity). Product access is not gated on custom JWT roles. */
export async function requireAuthenticated(ctx: AuthContext): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new Error('Authentication required');
  }
}
