import { initConvexTest } from './convexTest.setup';

export async function seedOrganizationMembership() {
  const t = initConvexTest();
  const ownerIdentity = {
    tokenIdentifier: 'https://auth.example/|auth0|owner',
    email: 'owner@example.com',
    emailVerified: true,
  };
  const memberIdentity = {
    tokenIdentifier: 'https://auth.example/|auth0|member',
    email: 'member@example.com',
    emailVerified: true,
  };
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      tokenIdentifier: ownerIdentity.tokenIdentifier,
      email: ownerIdentity.email,
      enabled: true,
    });
    const memberId = await ctx.db.insert('users', {
      tokenIdentifier: memberIdentity.tokenIdentifier,
      email: memberIdentity.email,
      enabled: true,
    });
    const orgId = await ctx.db.insert('organizations', {
      name: 'Membership org',
      ownerId,
      stripeCustomerId: 'cus_test',
      onboardingCompletedAt: 1,
    });
    await ctx.db.patch(ownerId, { orgId });
    await ctx.db.patch(memberId, { orgId });
    const ownerMembershipId = await ctx.db.insert('organizationMembers', {
      orgId,
      userId: ownerId,
      role: 'member',
      status: 'active',
      joinedAt: 1,
    });
    const memberMembershipId = await ctx.db.insert('organizationMembers', {
      orgId,
      userId: memberId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });
    const subscriptionId = await ctx.db.insert('subscriptions', {
      orgId,
      tier: 'pro',
      status: 'active',
      monthlyUnits: 1000,
      addonUnits: 0,
      currentPeriodStart: 1,
      currentPeriodEnd: Date.now() + 60_000,
      currentPeriodOverageSpentCents: 0,
      addonPurchaseCount: 0,
    });
    const usageId = await ctx.db.insert('usage', {
      orgId,
      periodStart: 1,
      periodEnd: Date.now() + 60_000,
      subscriptionUnitsUsed: 10,
      addonUnitsUsed: 0,
    });
    const threadId = await ctx.db.insert('analystThreads', {
      creatorUserId: ownerId,
      orgId,
      agentThreadId: 'agent-thread',
      title: 'Membership conversation',
      status: 'active',
      updatedAt: 1,
      lastMessageAt: 1,
    });
    return {
      ownerId,
      memberId,
      orgId,
      ownerMembershipId,
      memberMembershipId,
      subscriptionId,
      usageId,
      threadId,
    };
  });
  return {
    t,
    ...ids,
    ownerIdentity,
    memberIdentity,
    owner: t.withIdentity(ownerIdentity),
    member: t.withIdentity(memberIdentity),
  };
}

export type MembershipWorld = Awaited<ReturnType<typeof seedOrganizationMembership>>;
