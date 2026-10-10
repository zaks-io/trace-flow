import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import { getSubscriptionByOrgId, mutationReadCtx } from './currentPeriod';

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
    if (
      [args.periodStart, args.periodEnd, args.subscriptionUnitsUsed, args.addonUnitsUsed].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ) ||
      args.periodEnd <= args.periodStart
    ) {
      throw new Error('Invalid usage snapshot');
    }
    const existing = await ctx.db
      .query('usage')
      .withIndex('by_org_id_period', (q) =>
        q.eq('orgId', args.orgId).eq('periodStart', args.periodStart),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        // Retried or concurrent alarm snapshots may arrive out of order.
        subscriptionUnitsUsed: Math.max(existing.subscriptionUnitsUsed, args.subscriptionUnitsUsed),
        addonUnitsUsed: Math.max(existing.addonUnitsUsed, args.addonUnitsUsed),
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

const AUTO_TOPUP_DEDUP_MS = 15 * 60 * 1000; // 15 minutes

export const checkAutoTopup = internalMutation({
  args: {
    orgId: v.id('organizations'),
    subscriptionUnitsUsed: v.number(),
    addonUnitsUsed: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subscription = await getSubscriptionByOrgId(mutationReadCtx(ctx), args.orgId);
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
