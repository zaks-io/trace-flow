import { type QueryCtx, type MutationCtx, type ActionCtx } from './_generated/server';
import { query } from './_generated/server';

type AuthContext = QueryCtx | MutationCtx | ActionCtx;

export async function requireObserveRole(ctx: AuthContext): Promise<void> {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new Error('Authentication required');
  }

  const roles = ((identity as Record<string, unknown>)['neuron/roles'] as string[]) || [];

  if (!roles.includes('Observe')) {
    throw new Error('Access denied');
  }
}

export const hasObserveRole = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return false;
    }

    const roles = ((identity as Record<string, unknown>)['neuron/roles'] as string[]) || [];
    return roles.includes('Observe');
  },
});
