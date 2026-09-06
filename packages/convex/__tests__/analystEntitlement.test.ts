import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ANALYST_PRO_REQUIRED_MESSAGE } from '../analyst';
import { sha256Hex } from '../analystSandboxRun';
import { initConvexTest, type ArchiveTestConvex } from './convexTest.setup';

interface AnalystWorld {
  t: ArchiveTestConvex;
  userId: Id<'users'>;
  orgId: Id<'organizations'>;
  tokenIdentifier: string;
}

async function seedAnalystWorld(subscription?: {
  tier: 'hobby' | 'pro';
  status: 'active' | 'grace' | 'suspended' | 'canceled';
}): Promise<AnalystWorld> {
  const t = initConvexTest();
  const tokenIdentifier = 'https://auth.example/|auth0|analyst-entitlement';
  const { userId, orgId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      tokenIdentifier,
      email: 'analyst@example.com',
      enabled: true,
      isAdmin: true,
    });
    const orgId = await ctx.db.insert('organizations', { name: 'Analyst org', ownerId: userId });
    await ctx.db.patch(userId, { orgId });

    if (subscription) {
      await ctx.db.insert('subscriptions', {
        orgId,
        tier: subscription.tier,
        status: subscription.status,
        monthlyUnits: 1_000,
        addonUnits: 0,
        currentPeriodStart: 1,
        currentPeriodEnd: 2,
        currentPeriodOverageSpentCents: 0,
        addonPurchaseCount: 0,
      });
    }

    return { userId, orgId };
  });
  return { t, userId, orgId, tokenIdentifier };
}

async function insertAnalystThread(world: AnalystWorld) {
  return world.t.run((ctx) =>
    ctx.db.insert('analystThreads', {
      creatorUserId: world.userId,
      orgId: world.orgId,
      agentThreadId: 'agent-thread',
      title: 'Entitlement test',
      status: 'active',
      updatedAt: 1,
      lastMessageAt: 1,
    }),
  );
}

describe('Analyst Pro entitlement', () => {
  it.each([
    ['a missing subscription', undefined],
    ['Hobby', { tier: 'hobby' as const, status: 'active' as const }],
    ['inactive Pro', { tier: 'pro' as const, status: 'grace' as const }],
  ])('denies sendMessage before creating work for %s', async (_label, subscription) => {
    const world = await seedAnalystWorld(subscription);
    const asUser = world.t.withIdentity({ tokenIdentifier: world.tokenIdentifier });

    await expect(
      asUser.action(api.analyst.sendMessage, { prompt: 'Analyze my usage' }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    const threadCount = await world.t.run(
      async (ctx) => (await ctx.db.query('analystThreads').collect()).length,
    );
    expect(threadCount).toBe(0);
  });

  it('allows active Pro to create and schedule an Analyst conversation', async () => {
    vi.useFakeTimers();
    try {
      const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
      const asUser = world.t.withIdentity({ tokenIdentifier: world.tokenIdentifier });
      const result = await asUser.action(api.analyst.sendMessage, { prompt: 'Analyze my usage' });

      expect(result.threadId).toBeDefined();
      const thread = await world.t.run((ctx) => ctx.db.get(result.threadId));
      expect(thread).toMatchObject({ creatorUserId: world.userId, orgId: world.orgId });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('blocks a scheduled Analyst inference after the organization downgrades', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);

    await expect(
      world.t.action(internal.analyst.streamMessage, {
        threadId,
        userId: world.userId,
        prompt: 'Scheduled before downgrade',
      }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.lastMessageAt).toBe(1);
  });

  it('blocks a completed sandbox continuation after the organization downgrades', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const runId = await world.t.run((ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'completed-sandbox',
        prompt: 'Analyze my usage',
        status: 'completed',
        runTokenHash: 'run-token-hash',
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        completedAt: 1,
        nextSeq: 0,
        resultText: 'Completed analysis',
      }),
    );

    await expect(
      world.t.action(internal.analystSandbox.continueAfterSandboxRun, { runId }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.lastMessageAt).toBe(1);
  });

  it('blocks new data tool work from a sandbox that outlived the Pro entitlement', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'sandbox-token';
    const runId = await world.t.run(async (ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'active-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now(),
        nextSeq: 0,
      }),
    );

    await expect(
      world.t.action(api.analystSandbox.executeSandboxToolCall, {
        runId,
        token,
        toolName: 'query_usage',
      }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);
  });

  it('keeps callback authorization after downgrade but gates provider inference', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'provider-proxy-token';
    const runId = await world.t.run(async (ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'provider-proxy-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now(),
        nextSeq: 0,
      }),
    );

    await expect(
      world.t.action(api.analystSandbox.verifySandboxRunToken, { runId, token }),
    ).resolves.toEqual({ ok: true, status: 'running' });
    await expect(
      world.t.action(api.analystSandbox.verifySandboxRunToken, {
        runId,
        token,
        purpose: 'inference',
      }),
    ).rejects.toThrow(ANALYST_PRO_REQUIRED_MESSAGE);

    await world.t.run(async (ctx) => {
      const subscription = await ctx.db
        .query('subscriptions')
        .withIndex('by_org_id', (q) => q.eq('orgId', world.orgId))
        .unique();
      if (!subscription) throw new Error('Subscription not found');
      await ctx.db.patch(subscription._id, { tier: 'pro', status: 'active' });
    });

    await expect(
      world.t.action(api.analystSandbox.verifySandboxRunToken, { runId, token }),
    ).resolves.toEqual({ ok: true, status: 'running' });
    await expect(
      world.t.action(api.analystSandbox.verifySandboxRunToken, {
        runId,
        token,
        purpose: 'inference',
      }),
    ).resolves.toEqual({ ok: true, status: 'running' });
  });

  it('keeps cancellation available after the organization downgrades', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const runId = await world.t.run((ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'sandbox-to-cancel',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: 'run-token-hash',
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now(),
        nextSeq: 0,
      }),
    );
    const asUser = world.t.withIdentity({ tokenIdentifier: world.tokenIdentifier });

    const result = await asUser.action(api.analystSandbox.cancelSandboxRun, { runId });

    expect(result.action).toBe('cancel');
    const run = await world.t.run((ctx) => ctx.db.get(runId));
    expect(run?.status).toBe('cancelled');
  });

  it('does not launch a replacement sandbox after the organization downgrades', async () => {
    const world = await seedAnalystWorld({ tier: 'hobby', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const runId = await world.t.run((ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'sandbox-before-downgrade',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: 'run-token-hash',
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        lastEventAt: 1,
        nextSeq: 0,
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await world.t.action(internal.analystSandbox.resumeOrFailStaleSandboxRun, { runId });
    } finally {
      errorSpy.mockRestore();
    }

    const runs = await world.t.run((ctx) => ctx.db.query('analystSandboxRuns').collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ _id: runId, status: 'timed_out' });
  });
});
