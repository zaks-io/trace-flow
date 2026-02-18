import { internalMutation } from '../_generated/server';

export const backfillStripeCustomerIdToOrgs = internalMutation({
  handler: async (ctx) => {
    const subscriptions = await ctx.db.query('subscriptions').collect();
    let migrated = 0;

    for (const sub of subscriptions) {
      if (!sub.stripeCustomerId) continue;
      const org = await ctx.db.get(sub.orgId);
      if (!org) continue;
      if (org.stripeCustomerId) continue;

      await ctx.db.patch(org._id, { stripeCustomerId: sub.stripeCustomerId });
      migrated++;
    }

    return { migrated, total: subscriptions.length };
  },
});
