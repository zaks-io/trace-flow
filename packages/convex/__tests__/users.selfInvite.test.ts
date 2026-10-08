import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../_generated/api';
import { seedOrganizationMembership } from './organizationMembership.setup';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('owner self-invite', () => {
  it('keeps the owner role after accepting and repeatedly initializing, including member removal', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.patch(world.ownerMembershipId, { role: 'owner' }));
    const inviteId = await world.owner.mutation(api.auth.invites.createOrgInvite, {
      email: world.ownerIdentity.email,
    });
    const invite = await world.t.run((ctx) => ctx.db.get(inviteId));
    if (!invite) throw new Error('Invite was not created');
    await world.owner.mutation(api.auth.invites.acceptInvite, { token: invite.token });
    await world.owner.mutation(api.auth.users.initializeUser, {});
    await world.owner.mutation(api.auth.users.initializeUser, {});
    await world.t.run(async (ctx) => {
      expect(await ctx.db.get(world.ownerId)).toMatchObject({ orgId: world.orgId, inviteId });
      expect(await ctx.db.get(world.orgId)).toMatchObject({ ownerId: world.ownerId });
      expect(await ctx.db.get(world.ownerMembershipId)).toMatchObject({
        role: 'owner',
        status: 'active',
      });
    });
    await expect(
      world.owner.query(api.billing.subscriptions.getBillingSummaryForCurrentUser, {}),
    ).resolves.toMatchObject({ role: 'owner' });
    const members = await world.owner.query(api.auth.organizations.getMembers, {});
    expect(members.find((row) => row.userId === world.ownerId)?.role).toBe('owner');
    await world.owner.mutation(api.auth.organizations.rename, { name: 'Owner retained' });
    await world.owner.mutation(api.billing.subscriptions.updateAutoOverageSettings, {
      autoOverage: true,
    });
    await world.owner.mutation(api.costAlerts.createChannel, {
      name: 'Ops',
      config: { type: 'email', recipients: ['ops@example.com'] },
    });
    await expect(
      world.owner.mutation(api.auth.users.removeMember, { memberId: world.ownerMembershipId }),
    ).rejects.toThrow('Cannot remove the organization owner');
    await world.owner.mutation(api.auth.users.removeMember, { memberId: world.memberMembershipId });
    expect((await world.t.run((ctx) => ctx.db.get(world.memberMembershipId)))?.status).toBe(
      'removed',
    );
  });

  it('preserves a legacy owner association across initialization while its membership is missing', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.delete(world.ownerMembershipId));
    await world.owner.mutation(api.auth.users.initializeUser, {});
    expect((await world.t.run((ctx) => ctx.db.get(world.ownerId)))?.orgId).toBe(world.orgId);
    await expect(
      world.owner.mutation(api.auth.organizations.rename, { name: 'Still owned' }),
    ).resolves.toBeNull();
  });
});
