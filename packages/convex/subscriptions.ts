import { query, mutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { getCurrentUser, requireEnabledUser } from './users';
import { internal } from './_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import type { SubscriptionTier } from '@trace-flow/types';

export const getForCurrentUser = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;

    return await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();
  },
});

export const setTier = mutation({
  args: {
    orgId: v.id('organizations'),
    tier: v.union(v.literal('hobby'), v.literal('pro')),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);
    if (user.orgId !== args.orgId) throw new Error('Organization mismatch');

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();

    if (!subscription) throw new Error('Subscription not found');

    const config = TIER_CONFIG[args.tier as SubscriptionTier];
    await ctx.db.patch(subscription._id, {
      tier: args.tier,
      monthlyUnits: config.monthlyUnits,
    });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: args.tier,
      monthlyUnits: config.monthlyUnits,
      addonUnits: subscription.addonUnits,
    });
  },
});

// TODO: Gate behind payment flow
export const addAddonUnits = mutation({
  args: {
    orgId: v.id('organizations'),
    units: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTraceFlowRole(ctx);
    const user = await requireEnabledUser(ctx);
    if (user.orgId !== args.orgId) throw new Error('Organization mismatch');
    if (args.units <= 0) throw new Error('Units must be positive');

    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();

    if (!subscription) throw new Error('Subscription not found');

    const newAddonUnits = subscription.addonUnits + args.units;
    await ctx.db.patch(subscription._id, { addonUnits: newAddonUnits });

    await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
      orgId: args.orgId,
      tier: subscription.tier,
      monthlyUnits: subscription.monthlyUnits,
      addonUnits: newAddonUnits,
    });
  },
});

export const getByOrgId = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
  },
});
