import { describe, expect, it } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../_generated/dataModel';
import { asUser, seedWorld } from './archiveControlPlaneTest.setup';

describe('archive export authorization', () => {
  const authorize = makeFunctionReference<
    'query',
    {
      scope?: 'organization';
      targets?: {
        contributionId: Id<'archiveContributions'>;
        source: 'claude' | 'codex';
        sourceSessionId: string;
      }[];
    }
  >('archiveExport:authorize');
  it('authorizes organization scope only for the current owner', async () => {
    const world = await seedWorld();
    await expect(
      asUser(world, world.owner).query(authorize, { scope: 'organization', targets: undefined }),
    ).resolves.toMatchObject({
      orgId: world.owner.orgId,
      actorUserId: world.owner._id,
      exportScope: 'organization',
    });
    await expect(
      asUser(world, world.member).query(authorize, {
        scope: 'organization',
        targets: undefined,
      }),
    ).rejects.toThrow('Only the organization owner');
  });
  it('allows the current owner to export a retained contribution after subscription loss', async () => {
    const world = await seedWorld('pro', 'canceled');
    const contributionId = await world.t.run((ctx) =>
      ctx.db.insert('archiveContributions', {
        orgId: world.owner.orgId,
        userId: world.member._id,
        createdAt: 1,
        status: 'member_removed',
      }),
    );
    await expect(
      asUser(world, world.owner).query(authorize, {
        targets: [{ contributionId, source: 'claude', sourceSessionId: 'session-1' }],
      }),
    ).resolves.toMatchObject({
      orgId: world.owner.orgId,
      actorUserId: world.owner._id,
      targets: [{ contributionId, userId: world.member._id }],
    });
  });

  it('rejects members and cross-organization contributions', async () => {
    const world = await seedWorld();
    const contributionId = await world.t.run((ctx) =>
      ctx.db.insert('archiveContributions', {
        orgId: world.owner.orgId,
        userId: world.owner._id,
        createdAt: 1,
        status: 'active',
      }),
    );
    await expect(
      asUser(world, world.member).query(authorize, {
        targets: [{ contributionId, source: 'claude', sourceSessionId: 'session-1' }],
      }),
    ).rejects.toThrow('Only the organization owner');

    const foreignContribution = await world.t.run((ctx) =>
      ctx.db.insert('archiveContributions', {
        orgId: world.otherOwner.orgId,
        userId: world.otherOwner._id,
        createdAt: 1,
        status: 'active',
      }),
    );
    await expect(
      asUser(world, world.owner).query(authorize, {
        targets: [
          { contributionId: foreignContribution, source: 'codex', sourceSessionId: 'session-2' },
        ],
      }),
    ).rejects.toThrow('Archive export target not found');
  });
});
