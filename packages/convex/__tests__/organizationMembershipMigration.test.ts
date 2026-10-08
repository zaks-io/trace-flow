import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { initConvexTest, type ConvexTest } from './convexTest.setup';
import { seedOrganizationMembership } from './organizationMembership.setup';
import { api } from '../_generated/api';

type Table = 'users' | 'organizationMembers' | 'organizations';
interface Counts {
  scanned: number;
  ownerRolesToRepair: number;
  nonOwnerRolesToRepair: number;
  ownerMembershipsToCreate: number;
  usersWithoutActiveMembership: number;
  missingOwnerUsers: number;
  orphanMemberships: number;
}
const repair = makeFunctionReference<
  'mutation',
  { table: Table; dryRun?: boolean; paginationOpts: { cursor: string | null; numItems: number } },
  Counts & { continueCursor: string; isDone: boolean }
>('migrations/repairOrganizationMemberships:repairOrganizationMemberships');

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function runAll(t: ConvexTest, dryRun?: boolean) {
  const totals: Counts = {
    scanned: 0,
    ownerRolesToRepair: 0,
    nonOwnerRolesToRepair: 0,
    ownerMembershipsToCreate: 0,
    usersWithoutActiveMembership: 0,
    missingOwnerUsers: 0,
    orphanMemberships: 0,
  };
  let pages = 0;
  for (const table of ['users', 'organizationMembers', 'organizations'] as const) {
    let cursor: string | null = null;
    for (;;) {
      const result: Counts & { continueCursor: string; isDone: boolean } = await t.mutation(
        repair,
        {
          table,
          ...(dryRun === undefined ? {} : { dryRun }),
          paginationOpts: { cursor, numItems: 1 },
        },
      );
      pages++;
      expect(Object.keys(result).sort()).toEqual(
        [...Object.keys(totals), 'continueCursor', 'isDone'].sort(),
      );
      for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += result[key];
      if (result.isDone) break;
      cursor = result.continueCursor;
      if (pages > 100) throw new Error('Migration did not finish');
    }
  }
  return { totals, pages };
}

describe('organization membership repair migration', () => {
  it('defaults to a dry-run, repairs roles and missing owner rows, and never fixes stale user associations', async () => {
    const world = await seedOrganizationMembership();
    const { t } = world;
    const extra = await t.run(async (ctx) => {
      const missingOwnerId = await ctx.db.insert('users', {
        tokenIdentifier: 'missing-owner',
        email: 'missing@example.com',
        enabled: true,
      });
      const missingOrgId = await ctx.db.insert('organizations', {
        name: 'Missing membership',
        ownerId: missingOwnerId,
      });
      await ctx.db.patch(missingOwnerId, { orgId: missingOrgId });
      const staleUserId = await ctx.db.insert('users', {
        tokenIdentifier: 'stale-member',
        email: 'stale@example.com',
        enabled: true,
        orgId: world.orgId,
      });
      const removedOwnerId = await ctx.db.insert('users', {
        tokenIdentifier: 'removed-owner',
        email: 'removed@example.com',
        enabled: true,
      });
      const removedOrgId = await ctx.db.insert('organizations', {
        name: 'Removed owner',
        ownerId: removedOwnerId,
      });
      await ctx.db.patch(removedOwnerId, { orgId: removedOrgId });
      const removedMembershipId = await ctx.db.insert('organizationMembers', {
        orgId: removedOrgId,
        userId: removedOwnerId,
        role: 'member',
        status: 'removed',
        removedAt: 1,
      });
      const otherOrgId = await ctx.db.insert('organizations', {
        name: 'Other organization',
        ownerId: world.ownerId,
      });
      const crossOrgMembershipId = await ctx.db.insert('organizationMembers', {
        orgId: otherOrgId,
        userId: world.memberId,
        role: 'owner',
        status: 'removed',
        removedAt: 1,
      });
      return {
        missingOwnerId,
        missingOrgId,
        staleUserId,
        removedMembershipId,
        crossOrgMembershipId,
        otherOrgId,
      };
    });
    const before = await t.run(async (ctx) => ({
      users: await ctx.db.query('users').collect(),
      members: await ctx.db.query('organizationMembers').collect(),
    }));
    const dryRun = await runAll(t);
    expect(dryRun.pages).toBeGreaterThan(3);
    expect(dryRun.totals).toMatchObject({
      ownerRolesToRepair: 2,
      nonOwnerRolesToRepair: 2,
      ownerMembershipsToCreate: 2,
      usersWithoutActiveMembership: 3,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query('users').collect()).toEqual(before.users);
      expect(await ctx.db.query('organizationMembers').collect()).toEqual(before.members);
    });
    expect((await runAll(t, false)).totals).toEqual(dryRun.totals);
    await t.run(async (ctx) => {
      expect(await ctx.db.query('users').collect()).toEqual(before.users);
      expect((await ctx.db.get(world.ownerMembershipId))?.role).toBe('owner');
      expect((await ctx.db.get(world.memberMembershipId))?.role).toBe('member');
      expect(await ctx.db.get(extra.removedMembershipId)).toMatchObject({
        role: 'owner',
        status: 'removed',
        removedAt: 1,
      });
      expect(await ctx.db.get(extra.crossOrgMembershipId)).toMatchObject({
        role: 'member',
        status: 'removed',
        removedAt: 1,
      });
      const newOwner = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', extra.missingOwnerId))
        .first();
      expect(newOwner).toMatchObject({
        orgId: extra.missingOrgId,
        role: 'owner',
        status: 'active',
      });
      const staleMembership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', extra.staleUserId))
        .first();
      expect(staleMembership).toBeNull();
    });
    const rerun = await runAll(t, false);
    expect(rerun.totals).toMatchObject({
      ownerRolesToRepair: 0,
      nonOwnerRolesToRepair: 0,
      ownerMembershipsToCreate: 0,
      usersWithoutActiveMembership: 2,
    });
    const rowsAfterApply = await t.run((ctx) => ctx.db.query('organizationMembers').collect());
    await runAll(t, false);
    expect(await t.run((ctx) => ctx.db.query('organizationMembers').collect())).toEqual(
      rowsAfterApply,
    );
  });

  it('reports dangling references without inventing users or organizations', async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        tokenIdentifier: 'orphan',
        email: 'orphan@example.com',
        enabled: true,
      });
      const orgId = await ctx.db.insert('organizations', { ownerId: userId, name: 'Orphan' });
      await ctx.db.insert('organizationMembers', {
        userId,
        orgId,
        role: 'owner',
        status: 'active',
      });
      await ctx.db.delete(orgId);
      await ctx.db.insert('organizations', { ownerId: userId, name: 'Missing owner user' });
      await ctx.db.delete(userId);
    });
    expect((await runAll(t, false)).totals).toMatchObject({
      missingOwnerUsers: 1,
      orphanMemberships: 1,
      ownerMembershipsToCreate: 0,
    });
  });

  it('does not revive a removed owner through the rollout exception or migration', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.patch(world.ownerMembershipId, { status: 'removed' }));
    await runAll(world.t, false);
    await expect(
      world.owner.mutation(api.auth.organizations.rename, { name: 'Denied' }),
    ).rejects.toThrow('Active organization membership required');
    expect((await world.t.run((ctx) => ctx.db.get(world.ownerMembershipId)))?.status).toBe(
      'removed',
    );
  });

  it.each([0, 101, 1.5])('rejects page size %s', async (numItems) => {
    await expect(
      initConvexTest().mutation(repair, {
        table: 'users',
        paginationOpts: { cursor: null, numItems },
      }),
    ).rejects.toThrow();
  });
});
