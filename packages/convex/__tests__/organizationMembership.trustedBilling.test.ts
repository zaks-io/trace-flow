import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import { seedOrganizationMembership } from './organizationMembership.setup';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Stripe webhooks call these without an identity and must record billing state
// even after the owner loses access.
it('keeps trusted billing mutations working without a user identity or active members', async () => {
  const world = await seedOrganizationMembership();
  await world.t.run(async (ctx) => {
    await ctx.db.patch(world.ownerId, { enabled: false });
    await ctx.db.patch(world.ownerMembershipId, { status: 'removed' });
    await ctx.db.patch(world.memberMembershipId, { status: 'removed' });
  });

  await world.t.mutation(internal.billing.subscriptions.setTier, {
    orgId: world.orgId,
    tier: 'hobby',
  });
  await world.t.mutation(internal.billing.subscriptions.setStripeCustomerId, {
    orgId: world.orgId,
    stripeCustomerId: 'cus_billing',
  });
  await world.t.mutation(internal.auth.organizations.setStripeCustomerId, {
    orgId: world.orgId,
    stripeCustomerId: 'cus_org',
  });
  await world.t.mutation(internal.billing.subscriptions.upsertStripeSubscriptionState, {
    orgId: world.orgId,
    status: 'grace',
    stripeSubscriptionId: 'sub_service',
    stripePlanItemId: 'item_service',
    currentPeriodStart: 20,
    currentPeriodEnd: 40,
    cancelAtPeriodEnd: true,
  });

  await world.t.run(async (ctx) => {
    expect(await ctx.db.get(world.orgId)).toMatchObject({ stripeCustomerId: 'cus_org' });
    expect(await ctx.db.get(world.subscriptionId)).toMatchObject({
      tier: 'hobby',
      status: 'grace',
      stripeCustomerId: 'cus_billing',
      stripeSubscriptionId: 'sub_service',
      stripePlanItemId: 'item_service',
      currentPeriodStart: 20,
      currentPeriodEnd: 40,
      cancelAtPeriodEnd: true,
    });
  });
});
