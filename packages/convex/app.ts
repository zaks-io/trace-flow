import { query } from './_generated/server';
import { getCurrentUser } from './users';

export const sessionContext = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return { hasRole: false, user: null, isAdmin: false, subscription: null };
    }

    const roles = ((identity as Record<string, unknown>)['neuron/roles'] as string[]) || [];
    const hasRole = roles.includes('Trace Flow');

    const user = await getCurrentUser(ctx);
    const isAdmin = user?.isAdmin === true;

    let subscription = null;
    if (user?.orgId) {
      subscription = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
        .first();
    }

    return { hasRole, user, isAdmin, subscription };
  },
});
