import { query } from './_generated/server';
import { v } from 'convex/values';
import { requireAdmin } from './users';

export const stats = query({
  args: {},
  returns: v.object({
    userCount: v.number(),
    orgCount: v.number(),
    apiKeyCount: v.number(),
    modelPricingCount: v.number(),
    subscriptionCount: v.number(),
    tierBreakdown: v.object({
      hobby: v.number(),
      pro: v.number(),
    }),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);

    const [users, orgs, apiKeys, modelPricing, subscriptions] = await Promise.all([
      ctx.db.query('users').collect(),
      ctx.db.query('organizations').collect(),
      ctx.db.query('apiKeys').collect(),
      ctx.db.query('modelPricing').collect(),
      ctx.db.query('subscriptions').collect(),
    ]);

    const tierBreakdown = { hobby: 0, pro: 0 };
    for (const sub of subscriptions) {
      if (sub.tier === 'hobby' || sub.tier === 'pro') {
        tierBreakdown[sub.tier]++;
      }
    }

    return {
      userCount: users.length,
      orgCount: orgs.length,
      apiKeyCount: apiKeys.length,
      modelPricingCount: modelPricing.length,
      subscriptionCount: subscriptions.length,
      tierBreakdown,
    };
  },
});
