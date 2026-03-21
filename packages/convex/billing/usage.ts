import { query, internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import { requireTraceFlowRole } from '../auth/auth';
import { getCurrentUser } from '../auth/users';
import { internal } from '../_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';

const usageDocValidator = v.union(
  v.object({
    _id: v.id('usage'),
    _creationTime: v.number(),
    orgId: v.id('organizations'),
    periodStart: v.number(),
    periodEnd: v.number(),
    subscriptionUnitsUsed: v.number(),
    addonUnitsUsed: v.number(),
  }),
  v.null(),
);

export const getCurrentUsage = query({
  args: {},
  returns: usageDocValidator,
  handler: async (ctx) => {
    await requireTraceFlowRole(ctx);
    const user = await getCurrentUser(ctx);
    if (!user?.orgId) return null;
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', user.orgId!))
      .first();
    if (!subscription) return null;
    return await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', user.orgId!).eq('periodStart', subscription.currentPeriodStart),
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
  returns: v.null(),
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
  returns: usageDocValidator,
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return null;

    return await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', args.orgId).eq('periodStart', subscription.currentPeriodStart),
      )
      .first();
  },
});

const AUTO_TOPUP_DEDUP_MS = 15 * 60 * 1000; // 15 minutes

export const checkAutoTopup = internalMutation({
  args: {
    orgId: v.id('organizations'),
    subscriptionUnitsUsed: v.number(),
    addonUnitsUsed: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query('subscriptions')
      .withIndex('by_org_id', (q) => q.eq('orgId', args.orgId))
      .first();
    if (!subscription) return;
    if (subscription.tier !== 'pro') return;
    if (!subscription.autoOverage) return;

    // Dedup: skip if a topup was recently triggered
    if (
      subscription.autoTopupPendingSince &&
      Date.now() - subscription.autoTopupPendingSince < AUTO_TOPUP_DEDUP_MS
    ) {
      return;
    }

    const totalUsed = args.subscriptionUnitsUsed + args.addonUnitsUsed;
    const totalAvailable = subscription.monthlyUnits + subscription.addonUnits;
    if (totalAvailable <= 0) return;

    const usageRatio = totalUsed / totalAvailable;
    if (usageRatio < 0.9) return;

    // Check cap before scheduling
    const cap = subscription.overageCapCents;
    const addonAmountCents = TIER_CONFIG.pro.overagePer100kCents;
    if (cap !== undefined && subscription.currentPeriodOverageSpentCents + addonAmountCents > cap)
      return;

    await ctx.db.patch(subscription._id, {
      autoTopupPendingSince: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.billing.subscriptions.triggerAutoTopup, {
      orgId: args.orgId,
      quantity: 1,
      amountCents: addonAmountCents,
      reason: 'usage_threshold',
    });
  },
});
