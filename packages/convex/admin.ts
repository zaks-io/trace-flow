import { query } from './_generated/server';
import { requireAdmin } from './users';

export const stats = query({
  args: {},
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
