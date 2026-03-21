import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';
import type { SubscriptionTier } from '@trace-flow/types';

export const backfillOrgBilling = internalMutation({
  handler: async (ctx) => {
    const users = await ctx.db.query('users').collect();
    const subscriptions = await ctx.db.query('subscriptions').collect();
    let membersCreated = 0;
    let subscriptionsUpdated = 0;

    for (const user of users) {
      if (!user.orgId) continue;
      const existingMembership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', user._id))
        .filter((q) => q.eq(q.field('orgId'), user.orgId!))
        .first();

      if (!existingMembership) {
        const org = await ctx.db.get(user.orgId);
        const isOwner = org?.ownerId === user._id;
        await ctx.db.insert('organizationMembers', {
          orgId: user.orgId,
          userId: user._id,
          role: isOwner ? 'owner' : 'member',
          status: 'active',
          joinedAt: Date.now(),
        });
        membersCreated++;
      }
    }

    for (const subscription of subscriptions) {
      const patch: Record<string, unknown> = {};
      if (!subscription.status) patch.status = 'active';
      if (subscription.autoOverage === undefined) patch.autoOverage = false;
      if (subscription.currentPeriodOverageSpentCents === undefined) {
        patch.currentPeriodOverageSpentCents = 0;
      }
      if (subscription.currentPeriodStart === undefined) patch.currentPeriodStart = 0;
      if (subscription.currentPeriodEnd === undefined) patch.currentPeriodEnd = 0;
      if (subscription.addonPurchaseCount === undefined) patch.addonPurchaseCount = 0;

      // Ensure monthlyUnits matches plan-level config (not seat-multiplied)
      const tierConfig = TIER_CONFIG[subscription.tier as SubscriptionTier];
      if (tierConfig && subscription.monthlyUnits !== tierConfig.monthlyUnits) {
        patch.monthlyUnits = tierConfig.monthlyUnits;
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(subscription._id, patch);
        subscriptionsUpdated++;
      }

      await ctx.scheduler.runAfter(0, internal.integrations.cloudflare.syncSubscriptionToKV, {
        orgId: subscription.orgId,
        tier: subscription.tier,
        monthlyUnits: (patch.monthlyUnits as number | undefined) ?? subscription.monthlyUnits,
        addonUnits: subscription.addonUnits,
        status: (patch.status as string | undefined) ?? subscription.status ?? 'active',
        currentPeriodStart:
          (patch.currentPeriodStart as number | undefined) ?? subscription.currentPeriodStart ?? 0,
        currentPeriodEnd:
          (patch.currentPeriodEnd as number | undefined) ?? subscription.currentPeriodEnd ?? 0,
      });
    }

    return {
      usersScanned: users.length,
      subscriptionsScanned: subscriptions.length,
      membersCreated,
      subscriptionsUpdated,
    };
  },
});
