import { query } from './_generated/server';
import { v } from 'convex/values';
import { getCurrentUser, getActiveOrganizationMembership } from './auth/userHelpers';
import { userValidator, subscriptionValidator } from './validators';

export const sessionContext = query({
  args: {},
  returns: v.object({
    user: v.union(userValidator, v.null()),
    isAdmin: v.boolean(),
    subscription: v.union(subscriptionValidator, v.null()),
    onboardingCompletedAt: v.optional(v.number()),
  }),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return { user: null, isAdmin: false, subscription: null };
    }

    const user = await getCurrentUser(ctx);
    const isEnabled = user?.enabled === true;
    const isAdmin = isEnabled && user?.isAdmin === true;

    let subscription = null;
    let onboardingCompletedAt: number | undefined;
    const active = await getActiveOrganizationMembership(ctx, user);
    if (active) {
      subscription = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', active.orgId))
        .first();
      onboardingCompletedAt = active.organization.onboardingCompletedAt;
    }

    return { user, isAdmin, subscription, onboardingCompletedAt };
  },
});
