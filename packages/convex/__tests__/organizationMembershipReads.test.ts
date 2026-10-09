import { describe, expect, it } from 'vitest';
import { api, internal } from '../_generated/api';
import { sha256Hex } from '../analystSandboxRun';
import { seedOrganizationMembership, type MembershipWorld } from './organizationMembership.setup';

async function seedOwnerRun({ t, ownerId, orgId, threadId }: MembershipWorld) {
  return t.run(async (ctx) => {
    const runId = await ctx.db.insert('analystSandboxRuns', {
      analystThreadId: threadId,
      creatorUserId: ownerId,
      orgId,
      sandboxId: 'sandbox',
      prompt: 'Summarize costs',
      status: 'completed',
      runTokenHash: 'hash',
      maxRuntimeMs: 60_000,
      updatedAt: 1,
      nextSeq: 1,
      resultText: 'Org-private result',
    });
    await ctx.db.insert('analystSandboxRunEvents', {
      runId,
      analystThreadId: threadId,
      creatorUserId: ownerId,
      orgId,
      seq: 0,
      type: 'status',
      message: 'Org-private event',
      emittedAt: 1,
    });
    return runId;
  });
}

function sandboxRunReads(world: MembershipWorld, runId: Awaited<ReturnType<typeof seedOwnerRun>>) {
  return [
    () => world.owner.query(api.analystSandbox.getSandboxRun, { runId }),
    () => world.owner.query(api.analystSandbox.listSandboxRunEvents, { runId }),
    () => world.owner.query(api.analystSandbox.listSandboxRunRows, { runId }),
  ];
}

describe('organization-scoped direct reads', () => {
  it('lets an active member read their own sandbox runs', async () => {
    const world = await seedOrganizationMembership();
    const runId = await seedOwnerRun(world);
    const [run, events] = await Promise.all(sandboxRunReads(world, runId).map((read) => read()));
    expect(run).toMatchObject({ resultText: 'Org-private result' });
    expect(events).toHaveLength(1);
  });

  it('hides sandbox runs once their creator is removed from the org', async () => {
    const world = await seedOrganizationMembership();
    const runId = await seedOwnerRun(world);
    await world.t.run((ctx) => ctx.db.patch(world.ownerMembershipId, { status: 'removed' }));
    for (const read of sandboxRunReads(world, runId)) {
      await expect(read()).rejects.toThrow('Pi run not found');
    }
  });

  it('hides sandbox runs created in another org after the creator moves', async () => {
    const world = await seedOrganizationMembership();
    const runId = await seedOwnerRun(world);
    await world.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert('organizations', {
        name: 'Other org',
        ownerId: world.ownerId,
        stripeCustomerId: 'cus_other',
        onboardingCompletedAt: 1,
      });
      await ctx.db.patch(world.ownerId, { orgId: otherOrgId });
    });
    for (const read of sandboxRunReads(world, runId)) {
      await expect(read()).rejects.toThrow('Pi run not found');
    }
  });

  it('stops a sandbox from querying data once its creator is removed', async () => {
    const world = await seedOrganizationMembership();
    const token = 'sandbox-token';
    const runId = await world.t.run(async (ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: world.threadId,
        creatorUserId: world.ownerId,
        orgId: world.orgId,
        sandboxId: 'running-sandbox',
        prompt: 'Summarize costs',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        nextSeq: 0,
      }),
    );
    await world.t.run((ctx) => ctx.db.patch(world.ownerMembershipId, { status: 'removed' }));
    await expect(
      world.t.action(api.analystSandbox.executeSandboxToolCall, {
        runId,
        token,
        toolName: 'query_usage',
      }),
    ).rejects.toThrow('Pi run not found');
  });

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
    const read = () => world.member.query(api.auth.users.getUser, { id: world.ownerId });
    await expect(read()).resolves.toMatchObject({ _id: world.ownerId });

    await world.t.run((ctx) => ctx.db.patch(world.memberMembershipId, { status: 'removed' }));
    await expect(read()).resolves.toBeNull();
  });

  it('shows no org members while the org is being deleted', async () => {
    const world = await seedOrganizationMembership();
    await world.t.run((ctx) => ctx.db.patch(world.orgId, { deletionStartedAt: 1 }));
    await expect(
      world.member.query(api.auth.users.getUser, { id: world.ownerId }),
    ).resolves.toBeNull();
  });
});
