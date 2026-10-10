import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../_generated/api';
import { seedOrganizationMembership, type MembershipWorld } from './organizationMembership.setup';

const mocks = vi.hoisted(() => ({ flag: vi.fn(), portal: vi.fn(), retrieve: vi.fn() }));
vi.mock('@splitch/convex', () => ({
  Splitch: class {
    peekDetails(...args: unknown[]) {
      return mocks.flag(...args);
    }
  },
}));
vi.mock('../billing/stripe', () => ({
  appUrl: 'https://trace-flow.example',
  getProPriceId: () => 'price_pro',
  getStripeClient: () => ({
    billingPortal: { sessions: { create: mocks.portal } },
    subscriptions: { retrieve: mocks.retrieve },
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.flag.mockReset().mockResolvedValue({ value: true, reason: 'TARGETING_MATCH' });
  mocks.portal.mockReset().mockResolvedValue({ url: 'https://billing.example/session' });
  mocks.retrieve.mockReset();
});
afterEach(() => vi.useRealTimers());

async function expectNoOrganizationData(world: MembershipWorld, disabled = false) {
  const { owner } = world;
  const reads = [
    [() => owner.query(api.auth.organizations.get, {}), null],
    [() => owner.query(api.auth.organizations.getMembers, {}), []],
    [() => owner.query(api.billing.subscriptions.getBillingSummaryForCurrentUser, {}), null],
    [
      () => owner.query(api.costAlerts.listForCurrentOrg, {}),
      { rules: [], channels: [], states: [], apiKeys: [], isOwner: false },
    ],
    [
      () =>
        owner.query(api.costAlerts.listDeliveries, {
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      { page: [], isDone: true, continueCursor: '' },
    ],
  ] as const;
  for (const [read, empty] of reads) {
    if (disabled) await expect(read()).rejects.toThrow('User account is not enabled');
    else await expect(read()).resolves.toEqual(empty);
  }
  const session = await owner.query(api.app.sessionContext, {});
  expect(session.subscription).toBeNull();
  expect(session.onboardingCompletedAt).toBeUndefined();
  await expect(owner.query(api.integrations.splitch.proSubscriptionEnabled, {})).resolves.toBe(
    false,
  );
  expect(mocks.flag).not.toHaveBeenCalled();
  const error = disabled
    ? 'User account is not enabled'
    : 'Active organization membership required';
  await expect(owner.query(api.analyst.listThreads, {})).rejects.toThrow(error);
  await expect(owner.action(api.analyst.sendMessage, { prompt: 'Costs?' })).rejects.toThrow(error);
  await expect(
    owner.action(api.billing.subscriptions.createBillingPortalSession, {}),
  ).rejects.toThrow(error);
  expect(mocks.portal).not.toHaveBeenCalled();
  await expect(owner.mutation(api.auth.organizations.rename, { name: 'Denied' })).rejects.toThrow(
    error,
  );
  await expect(owner.mutation(api.auth.organizations.completeOnboarding, {})).rejects.toThrow(
    error,
  );
  await expect(
    owner.mutation(api.auth.invites.createOrgInvite, { email: 'new@example.com' }),
  ).rejects.toThrow(error);
  await expect(
    owner.mutation(api.billing.subscriptions.updateAutoOverageSettings, { autoOverage: true }),
  ).rejects.toThrow(error);
  await expect(
    owner.mutation(api.costAlerts.createChannel, {
      name: 'Denied',
      config: { type: 'email', recipients: ['ops@example.com'] },
    }),
  ).rejects.toThrow(error);
  await expect(
    owner.mutation(api.auth.users.removeMember, { memberId: world.memberMembershipId }),
  ).rejects.toThrow(error);
}

describe('organization membership authorization across public handlers', () => {
  it.each(['removed', 'disabled', 'deleting', 'deleted', 'missing organization'] as const)(
    'denies a %s owner across all S1 files',
    async (state) => {
      const world = await seedOrganizationMembership();
      await world.t.run(async (ctx) => {
        if (state === 'removed') await ctx.db.patch(world.ownerMembershipId, { status: 'removed' });
        if (state === 'disabled') await ctx.db.patch(world.ownerId, { enabled: false });
        if (state === 'deleting') await ctx.db.patch(world.orgId, { deletionStartedAt: 1 });
        if (state === 'deleted') await ctx.db.patch(world.orgId, { deletedAt: 1 });
        if (state === 'missing organization') await ctx.db.delete(world.orgId);
      });
      await expectNoOrganizationData(world, state === 'disabled');
      await world.t.run(async (ctx) => {
        expect((await ctx.db.get(world.memberMembershipId))?.status).toBe('active');
        expect((await ctx.db.get(world.subscriptionId))?.autoOverage).toBeUndefined();
        expect(await ctx.db.query('invites').collect()).toEqual([]);
        expect(await ctx.db.query('costAlertChannels').collect()).toEqual([]);
      });
    },
  );

  it('ignores a non-owner role marked owner for display and owner-only operations', async () => {
    const world = await seedOrganizationMembership();
    await expect(
      world.member.query(api.billing.subscriptions.getBillingSummaryForCurrentUser, {}),
    ).resolves.toMatchObject({ role: 'member' });
    const members = await world.member.query(api.auth.organizations.getMembers, {});
    expect(members.find((row) => row.userId === world.ownerId)?.role).toBe('owner');
    expect(members.find((row) => row.userId === world.memberId)?.role).toBe('member');
    const error = 'Only the organization owner';
    await expect(
      world.member.mutation(api.auth.organizations.rename, { name: 'Denied' }),
    ).rejects.toThrow(error);
    await expect(
      world.member.mutation(api.auth.invites.createOrgInvite, { email: 'new@example.com' }),
    ).rejects.toThrow(error);
    await expect(
      world.member.mutation(api.billing.subscriptions.updateAutoOverageSettings, {
        autoOverage: true,
      }),
    ).rejects.toThrow(error);
    await expect(
      world.member.mutation(api.costAlerts.createChannel, {
        name: 'Denied',
        config: { type: 'email', recipients: ['ops@example.com'] },
      }),
    ).rejects.toThrow(error);
    await expect(
      world.member.mutation(api.auth.users.removeMember, { memberId: world.ownerMembershipId }),
    ).rejects.toThrow(error);
    await expect(
      world.member.action(api.billing.subscriptions.createBillingPortalSession, {}),
    ).rejects.toThrow(error);
    expect(mocks.portal).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'allows the live owner when the owner membership is missing: %s',
    async (missing) => {
      const world = await seedOrganizationMembership();
      if (missing) await world.t.run((ctx) => ctx.db.delete(world.ownerMembershipId));
      await expect(world.owner.query(api.auth.organizations.get, {})).resolves.toMatchObject({
        _id: world.orgId,
      });
      await expect(
        world.owner.query(api.billing.subscriptions.getBillingSummaryForCurrentUser, {}),
      ).resolves.toMatchObject({ role: 'owner' });
      await expect(world.owner.query(api.app.sessionContext, {})).resolves.toMatchObject({
        subscription: { _id: world.subscriptionId },
        onboardingCompletedAt: 1,
      });
      await expect(
        world.owner.query(api.integrations.splitch.proSubscriptionEnabled, {}),
      ).resolves.toBe(true);
      expect(mocks.flag).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ attributes: expect.objectContaining({ tier: 'pro' }) }),
        false,
      );
      await expect(world.owner.query(api.analyst.listThreads, {})).resolves.toMatchObject([
        { _id: world.threadId },
      ]);
      await expect(world.owner.query(api.costAlerts.listForCurrentOrg, {})).resolves.toMatchObject({
        isOwner: true,
      });
      await world.owner.mutation(api.auth.organizations.rename, { name: 'Updated' });
      await world.owner.mutation(api.auth.invites.createOrgInvite, { email: 'new@example.com' });
      await world.owner.mutation(api.billing.subscriptions.updateAutoOverageSettings, {
        autoOverage: true,
      });
      await world.owner.mutation(api.costAlerts.createChannel, {
        name: 'Ops',
        config: { type: 'email', recipients: ['ops@example.com'] },
      });
      await expect(
        world.owner.action(api.billing.subscriptions.createBillingPortalSession, {}),
      ).resolves.toEqual({ url: 'https://billing.example/session' });
      await world.owner.mutation(api.auth.users.removeMember, {
        memberId: world.memberMembershipId,
      });
      await world.t.run(async (ctx) => {
        expect((await ctx.db.get(world.orgId))?.name).toBe('Updated');
        expect((await ctx.db.get(world.memberMembershipId))?.status).toBe('removed');
        expect((await ctx.db.get(world.subscriptionId))?.autoOverage).toBe(true);
        expect(await ctx.db.query('costAlertChannels').collect()).toHaveLength(1);
      });
    },
  );

  it.each(['disabled', 'deleting'] as const)(
    'denies a %s owner even when the membership row is absent',
    async (state) => {
      const world = await seedOrganizationMembership();
      await world.t.run(async (ctx) => {
        await ctx.db.delete(world.ownerMembershipId);
        if (state === 'disabled') await ctx.db.patch(world.ownerId, { enabled: false });
        else await ctx.db.patch(world.orgId, { deletionStartedAt: 1 });
      });
      await expectNoOrganizationData(world, state === 'disabled');
    },
  );

  it.each(['removed', 'disabled', 'deleting'] as const)(
    'rechecks a %s owner in the billing write after the Stripe read',
    async (state) => {
      const world = await seedOrganizationMembership();
      await world.t.run((ctx) =>
        ctx.db.patch(world.subscriptionId, { stripeSubscriptionId: 'sub_test' }),
      );
      mocks.retrieve.mockImplementationOnce(async () => {
        await world.t.run(async (ctx) => {
          if (state === 'removed')
            await ctx.db.patch(world.ownerMembershipId, { status: 'removed' });
          if (state === 'disabled') await ctx.db.patch(world.ownerId, { enabled: false });
          if (state === 'deleting') await ctx.db.patch(world.orgId, { deletionStartedAt: 1 });
        });
        return {
          id: 'sub_test',
          status: 'past_due',
          customer: 'cus_test',
          items: { data: [] },
          cancel_at_period_end: false,
        };
      });
      await expect(
        world.owner.action(api.billing.subscriptions.reconcileCurrentOrgWithStripe, {}),
      ).rejects.toThrow(
        state === 'disabled'
          ? 'User account is not enabled'
          : 'Active organization membership required',
      );
      expect(mocks.retrieve).toHaveBeenCalledOnce();
      expect(await world.t.run((ctx) => ctx.db.get(world.subscriptionId))).toMatchObject({
        tier: 'pro',
        status: 'active',
      });
    },
  );

  it('reconciles billing for an active owner through the transactional write checks', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) =>
      ctx.db.patch(world.subscriptionId, { stripeSubscriptionId: 'sub_test' }),
    );
    mocks.retrieve.mockResolvedValue({
      id: 'sub_test',
      status: 'past_due',
      customer: 'cus_test',
      items: {
        data: [
          {
            id: 'item_test',
            price: { id: 'price_pro' },
            current_period_start: 1,
            current_period_end: 60,
          },
        ],
      },
      cancel_at_period_end: false,
    });
    await expect(
      world.owner.action(api.billing.subscriptions.reconcileCurrentOrgWithStripe, {}),
    ).resolves.toEqual({ reconciled: true });
    expect(await world.t.run((ctx) => ctx.db.get(world.subscriptionId))).toMatchObject({
      tier: 'pro',
      status: 'grace',
    });
  });

  it('does not admit a non-owner without a membership row', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.delete(world.memberMembershipId));
    await expect(world.member.query(api.auth.organizations.get, {})).resolves.toBeNull();
    await expect(
      world.member.mutation(api.auth.organizations.completeOnboarding, {}),
    ).rejects.toThrow('Active organization membership required');
  });
});
