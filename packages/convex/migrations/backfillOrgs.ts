import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { TIER_CONFIG } from '@trace-flow/types';

export const backfillOrgs = internalMutation({
  handler: async (ctx) => {
    const users = await ctx.db.query('users').collect();
    let migrated = 0;

    for (const user of users) {
      if (user.orgId) continue;

      const orgId = await ctx.db.insert('organizations', {
        name: `${user.name ?? 'My'}'s Org`,
        ownerId: user._id,
      });

      await ctx.db.patch(user._id, { orgId });

      const hobbyConfig = TIER_CONFIG.hobby;
      const now = Date.now();
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: 'hobby',
        status: 'active',
        monthlyUnits: hobbyConfig.monthlyUnits,
        addonUnits: 0,
        seatQuantity: 1,
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 0,
      });

      // Re-sync all API keys for this user with orgId
      const userKeys = await ctx.db
        .query('apiKeys')
        .withIndex('by_user_id', (q) => q.eq('userId', user._id))
        .collect();

      for (const key of userKeys) {
        await ctx.db.patch(key._id, { orgId });
        await ctx.scheduler.runAfter(0, internal.cloudflare.syncKeyToKV, {
          key: key.key,
          expiresAt: key.expiresAt,
          orgId,
        });
      }

      await ctx.scheduler.runAfter(0, internal.cloudflare.syncSubscriptionToKV, {
        orgId,
        tier: 'hobby',
        monthlyUnits: hobbyConfig.monthlyUnits,
        addonUnits: 0,
        status: 'active',
        seatQuantity: 1,
        currentPeriodStart: now,
        currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      });

      migrated++;
    }

    return { migrated, total: users.length };
  },
});
