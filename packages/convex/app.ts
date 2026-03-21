import { query } from './_generated/server';
import { v } from 'convex/values';
import { getCurrentUser } from './auth/users';
import { userValidator, subscriptionValidator } from './validators';

export const sessionContext = query({
  args: {},
  returns: v.object({
    hasRole: v.boolean(),
    user: v.union(userValidator, v.null()),
    isAdmin: v.boolean(),
    subscription: v.union(subscriptionValidator, v.null()),
    onboardingCompletedAt: v.optional(v.number()),
  }),
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
    let onboardingCompletedAt: number | undefined;
    if (user?.orgId) {
      const [sub, org] = await Promise.all([
        ctx.db
          .query('subscriptions')
          .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
          .first(),
        ctx.db.get(user.orgId),
      ]);
      subscription = sub;
      onboardingCompletedAt = org?.onboardingCompletedAt;
    }

    return { hasRole, user, isAdmin, subscription, onboardingCompletedAt };
  },
});
