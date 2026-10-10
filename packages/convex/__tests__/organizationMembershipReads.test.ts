import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import { seedOrganizationMembership } from './organizationMembership.setup';

describe('organization-scoped direct reads', () => {
  it('resolves a tool call thread only for an active member of its org', async () => {
    const world = await seedOrganizationMembership();
    const lookup = () =>
      world.t.query(internal.analyst.getThreadByAgentThreadIdForAction, {
        agentThreadId: 'agent-thread',
        userId: world.ownerId,
      });
    await expect(lookup()).resolves.toMatchObject({ _id: world.threadId });

    await world.t.run((ctx) => ctx.db.patch(world.ownerMembershipId, { status: 'removed' }));
    await expect(lookup()).resolves.toBeNull();
  });

  it('shows org members to an active member only', async () => {
    const world = await seedOrganizationMembership();
    const read = () => world.member.query(api.auth.organizations.getMembers, {});
    await expect(read()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: world.ownerId })]),
    );

    await world.t.run((ctx) => ctx.db.patch(world.memberMembershipId, { status: 'removed' }));
    await expect(read()).resolves.toEqual([]);
  });

  it('shows no org members while the org is being deleted', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.patch(world.orgId, { deletionStartedAt: 1 }));
    await expect(world.member.query(api.auth.organizations.getMembers, {})).resolves.toEqual([]);
  });
});
