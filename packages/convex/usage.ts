import { query, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from './auth';
import { getCurrentUser } from './users';
import { computePeriod } from '@trace-flow/utils';

export const getCurrentUsage = query({
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;

    const { periodStart } = computePeriod(new Date());

    return await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', user.orgId!).eq('periodStart', periodStart),
      )
      .first();
  },
});

export const recordUsage = internalMutation({
  args: {
    orgId: v.id('organizations'),
    periodStart: v.number(),
    periodEnd: v.number(),
    subscriptionUnitsUsed: v.number(),
    addonUnitsUsed: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', args.orgId).eq('periodStart', args.periodStart),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        subscriptionUnitsUsed: args.subscriptionUnitsUsed,
        addonUnitsUsed: args.addonUnitsUsed,
        periodEnd: args.periodEnd,
      });
    } else {
      await ctx.db.insert('usage', {
        orgId: args.orgId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        subscriptionUnitsUsed: args.subscriptionUnitsUsed,
        addonUnitsUsed: args.addonUnitsUsed,
      });
    }
  },
});

export const getForOrgInternal = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, args) => {
    const { periodStart } = computePeriod(new Date());

    return await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', args.orgId).eq('periodStart', periodStart),
      )
      .first();
  },
});
