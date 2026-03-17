import { query } from './_generated/server';
import { v } from 'convex/values';
import { getCurrentUser } from './users';

export const sessionContext = query({
  args: {},
  returns: v.object({
    hasRole: v.boolean(),
    user: v.union(
      v.object({
        _id: v.id('users'),
        _creationTime: v.number(),
        tokenIdentifier: v.string(),
        email: v.string(),
        name: v.optional(v.string()),
        picture: v.optional(v.string()),
        enabled: v.boolean(),
        orgId: v.optional(v.id('organizations')),
        inviteId: v.optional(v.id('invites')),
        isAdmin: v.optional(v.boolean()),
      }),
      v.null(),
    ),
    isAdmin: v.boolean(),
    subscription: v.union(
      v.object({
        _id: v.id('subscriptions'),
        _creationTime: v.number(),
        orgId: v.id('organizations'),
        tier: v.union(v.literal('hobby'), v.literal('pro')),
        status: v.union(
          v.literal('active'),
          v.literal('grace'),
          v.literal('suspended'),
          v.literal('canceled'),
        ),
        monthlyUnits: v.number(),
        addonUnits: v.number(),
        currentPeriodStart: v.number(),
        currentPeriodEnd: v.number(),
        currentPeriodOverageSpentCents: v.number(),
        addonPurchaseCount: v.number(),
        stripeCustomerId: v.optional(v.string()),
        stripeSubscriptionId: v.optional(v.string()),
        stripePlanItemId: v.optional(v.string()),
        cancelAtPeriodEnd: v.optional(v.boolean()),
        autoOverage: v.optional(v.boolean()),
        overageCapCents: v.optional(v.number()),
        gracePeriodSchedulerId: v.optional(v.id('_scheduled_functions')),
        autoTopupPendingSince: v.optional(v.number()),
      }),
      v.null(),
    ),
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
    if (user?.orgId) {
      subscription = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
        .first();
    }

    return { hasRole, user, isAdmin, subscription };
  },
});
