import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ANALYST_PRO_REQUIRED_MESSAGE } from '../analyst';
import { sha256Hex } from '../analystSandboxRun';
import {
  SANDBOX_MAX_CHECKPOINTS,
  SANDBOX_INFERENCE_MAX_OUTPUT_TOKENS_PER_REQUEST,
  SANDBOX_INFERENCE_MAX_REQUESTS,
} from '../analystSandboxPolicy';
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
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      status: 'active',
      joinedAt: 1,
    });

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
      world.t.action(api.analystSandboxInference.authorizeSandboxInference, {
        runId,
        token,
        requestedOutputTokens: SANDBOX_INFERENCE_MAX_OUTPUT_TOKENS_PER_REQUEST,
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
      world.t.action(api.analystSandboxInference.authorizeSandboxInference, {
        runId,
        token,
        requestedOutputTokens: SANDBOX_INFERENCE_MAX_OUTPUT_TOKENS_PER_REQUEST,
      }),
    ).resolves.toMatchObject({ ok: true, status: 'running', model: 'z-ai/glm-5.2' });

    await world.t.run((ctx) =>
      ctx.db.patch(runId, {
        inferenceRequestCount: SANDBOX_INFERENCE_MAX_REQUESTS,
      }),
    );
    await expect(
      world.t.action(api.analystSandboxInference.authorizeSandboxInference, {
        runId,
        token,
        requestedOutputTokens: 1,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'quota_exceeded', model: null });
  });

  it('rejects provider inference after the run creator is disabled', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'disabled-creator-token';
    const runId = await world.t.run(async (ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'disabled-creator-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now(),
        nextSeq: 0,
      }),
    );

    await world.t.run((ctx) => ctx.db.patch(world.userId, { enabled: false }));

    await expect(
      world.t.action(api.analystSandboxInference.authorizeSandboxInference, {
        runId,
        token,
        requestedOutputTokens: 1,
      }),
    ).rejects.toThrow('User account is not enabled');

    const run = await world.t.run((ctx) => ctx.db.get(runId));
    expect(run?.inferenceRequestCount).toBeUndefined();
    expect(run?.inferenceReservedOutputTokens).toBeUndefined();
  });

  it('atomically rejects an inference reservation after its creator changes organizations', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'moved-creator-token';
    const tokenHash = await sha256Hex(token);
    const runId = await world.t.run((ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'moved-creator-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: tokenHash,
        maxRuntimeMs: 60_000,
        updatedAt: Date.now(),
        startedAt: Date.now(),
        nextSeq: 0,
      }),
    );

    await world.t.run((ctx) => ctx.db.patch(world.userId, { orgId: undefined }));

    await expect(
      world.t.mutation(internal.analystSandboxStore.reserveSandboxInference, {
        runId,
        tokenHash,
        requestedOutputTokens: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unauthorized', status: null });
  });

  it.each(['deletionStartedAt', 'deletedAt'] as const)(
    'rejects inference authorization and atomic reservation after %s is set',
    async (deletionField) => {
      const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
      const threadId = await insertAnalystThread(world);
      const token = `deleting-org-${deletionField}`;
      const tokenHash = await sha256Hex(token);
      const runId = await world.t.run(async (ctx) => {
        const runId = await ctx.db.insert('analystSandboxRuns', {
          analystThreadId: threadId,
          creatorUserId: world.userId,
          orgId: world.orgId,
          sandboxId: 'deleting-org-sandbox',
          prompt: 'Analyze my usage',
          status: 'running',
          runTokenHash: tokenHash,
          maxRuntimeMs: 60_000,
          updatedAt: Date.now(),
          startedAt: Date.now(),
          nextSeq: 0,
        });
        await ctx.db.patch(
          world.orgId,
          deletionField === 'deletionStartedAt'
            ? { deletionStartedAt: Date.now() }
            : { deletedAt: Date.now() },
        );
        return runId;
      });

      await expect(
        world.t.action(api.analystSandboxInference.authorizeSandboxInference, {
          runId,
          token,
          requestedOutputTokens: 1,
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'unauthorized', model: null });
      await expect(
        world.t.mutation(internal.analystSandboxStore.reserveSandboxInference, {
          runId,
          tokenHash,
          requestedOutputTokens: 1,
        }),
      ).resolves.toEqual({ ok: false, reason: 'unauthorized', status: null });

      const run = await world.t.run((ctx) => ctx.db.get(runId));
      expect(run?.inferenceRequestCount).toBeUndefined();
      expect(run?.inferenceReservedOutputTokens).toBeUndefined();
    },
  );

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

  it('binds checkpoints to the stored sandbox and caps snapshot reservations', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'checkpoint-token';
    const runId = await world.t.run(async (ctx) =>
      ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'stored-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        nextSeq: 0,
      }),
    );

    const first = await world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, {
      runId,
      token,
    });
    expect(first).toMatchObject({ ok: true, sandboxId: 'stored-sandbox', reservation: 1 });
    await expect(
      world.t.action(api.analystSandbox.checkpointSandboxRun, {
        runId,
        token,
        sandboxId: 'attacker-selected-sandbox',
        reservation: 1,
        backup: { id: 'bad-backup', dir: '/workspace' },
      }),
    ).rejects.toThrow('Pi checkpoint reservation not found');
    await expect(
      world.t.action(api.analystSandbox.checkpointSandboxRun, {
        runId,
        token,
        sandboxId: 'stored-sandbox',
        reservation: 1,
        backup: { id: 'good-backup', dir: '/workspace' },
      }),
    ).resolves.toMatchObject({ ok: true, replayed: false });

    for (let reservation = 2; reservation <= SANDBOX_MAX_CHECKPOINTS; reservation += 1) {
      await expect(
        world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, { runId, token }),
      ).resolves.toMatchObject({ ok: true, reservation });
    }
    await expect(
      world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, { runId, token }),
    ).resolves.toMatchObject({ ok: false, reason: 'quota_exceeded' });
  });

  it('rechecks live membership after checkpoint streaming and rejects both backup objects', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'checkpoint-revocation-token';
    const runId = await world.t.run(async (ctx) => {
      await ctx.db.patch(threadId, {
        sandboxBackup: { id: 'prior-backup', dir: '/workspace', updatedAt: 1 },
      });
      return ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'revoked-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        nextSeq: 0,
      });
    });
    const reservation = await world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, {
      runId,
      token,
    });
    await world.t.run(async (ctx) => {
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', world.userId))
        .first();
      await ctx.db.patch(membership!._id, { status: 'removed', removedAt: Date.now() });
    });

    await expect(
      world.t.action(api.analystSandbox.checkpointSandboxRun, {
        runId,
        token,
        sandboxId: 'revoked-sandbox',
        reservation: reservation.reservation!,
        backup: { id: 'new-backup', dir: '/workspace' },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'unauthorized',
      backupIdsToDelete: ['new-backup', 'prior-backup'],
    });
    const [thread, run] = await world.t.run((ctx) =>
      Promise.all([ctx.db.get(threadId), ctx.db.get(runId)]),
    );
    expect(thread?.sandboxBackup).toBeUndefined();
    expect(run?.checkpointReservation).toBeUndefined();
  });

  it('returns the replaced checkpoint object for immediate R2 cleanup', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'checkpoint-replacement-token';
    const runId = await world.t.run(async (ctx) => {
      await ctx.db.patch(threadId, {
        sandboxBackup: { id: 'prior-backup', dir: '/workspace', updatedAt: 1 },
      });
      return ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'replacement-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        nextSeq: 0,
      });
    });
    const reservation = await world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, {
      runId,
      token,
    });

    await expect(
      world.t.action(api.analystSandbox.checkpointSandboxRun, {
        runId,
        token,
        sandboxId: 'replacement-sandbox',
        reservation: reservation.reservation!,
        backup: { id: 'new-backup', dir: '/workspace' },
      }),
    ).resolves.toEqual({
      ok: true,
      replayed: false,
      backupIdsToDelete: ['prior-backup'],
    });
    await world.t.run(async (ctx) => {
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', world.userId))
        .first();
      await ctx.db.patch(membership!._id, { status: 'removed', removedAt: Date.now() });
    });
    await expect(
      world.t.action(api.analystSandbox.authorizeSandboxCheckpoint, { runId, token }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unauthorized',
      backupIdsToDelete: ['prior-backup'],
    });
    await world.t.action(api.analystSandbox.acknowledgeSandboxBackupCleanup, {
      runId,
      token,
      backupIds: ['prior-backup'],
    });
    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.sandboxBackup?.id).toBe('new-backup');
  });

  it('does not let terminal callback retries replace the final backup', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'completion-token';
    const runId = await world.t.run(async (ctx) => {
      await ctx.db.patch(threadId, {
        sandboxBackup: { id: 'prior-backup', dir: '/workspace', updatedAt: 1 },
      });
      return ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'completion-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        nextSeq: 0,
      });
    });

    const authorization = await world.t.action(api.analystSandbox.authorizeSandboxCompletion, {
      runId,
      token,
      status: 'completed',
    });
    expect(authorization).toMatchObject({
      ok: true,
      sandboxId: 'completion-sandbox',
      reservation: 1,
      allowSnapshot: true,
    });
    await expect(
      world.t.action(api.analystSandbox.authorizeSandboxCompletion, {
        runId,
        token,
        status: 'completed',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'in_progress' });
    await expect(
      world.t.action(api.analystSandbox.completeSandboxRun, {
        runId,
        token,
        sandboxId: authorization.sandboxId!,
        reservation: authorization.reservation,
        status: 'completed',
        backup: { id: 'final-backup', dir: '/workspace' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      transitioned: true,
      backupIdsToDelete: ['prior-backup'],
    });
    const replay = await world.t.action(api.analystSandbox.authorizeSandboxCompletion, {
      runId,
      token,
      status: 'completed',
    });
    expect(replay).toMatchObject({
      ok: true,
      terminalReplay: true,
      allowSnapshot: false,
      backupIdsToDelete: ['prior-backup'],
    });
    await expect(
      world.t.action(api.analystSandbox.completeSandboxRun, {
        runId,
        token,
        sandboxId: replay.sandboxId!,
        status: 'completed',
        backup: { id: 'final-backup', dir: '/workspace' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      transitioned: false,
      backupAccepted: true,
      backupIdsToDelete: ['prior-backup'],
    });
    await world.t.action(api.analystSandbox.acknowledgeSandboxBackupCleanup, {
      runId,
      token,
      backupIds: ['prior-backup'],
    });
    await expect(
      world.t.action(api.analystSandbox.authorizeSandboxCompletion, {
        runId,
        token,
        status: 'completed',
      }),
    ).resolves.toMatchObject({ backupIdsToDelete: [] });
    await expect(
      world.t.action(api.analystSandbox.completeSandboxRun, {
        runId,
        token,
        sandboxId: replay.sandboxId!,
        status: 'completed',
        resultText: 'retry',
        backup: { id: 'late-backup', dir: '/workspace' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      transitioned: false,
      backupIdsToDelete: ['late-backup'],
    });

    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.sandboxBackup?.id).toBe('final-backup');
    await expect(
      world.t.action(api.analystSandbox.receiveSandboxEvents, {
        runId,
        token,
        events: [{ type: 'stdout', message: 'late event' }],
      }),
    ).rejects.toThrow('Pi run is completed');
  });

  it('does not commit a completion snapshot after membership revocation', async () => {
    const world = await seedAnalystWorld({ tier: 'pro', status: 'active' });
    const threadId = await insertAnalystThread(world);
    const token = 'completion-revocation-token';
    const runId = await world.t.run(async (ctx) => {
      await ctx.db.patch(threadId, {
        sandboxBackup: { id: 'prior-backup', dir: '/workspace', updatedAt: 1 },
      });
      return ctx.db.insert('analystSandboxRuns', {
        analystThreadId: threadId,
        creatorUserId: world.userId,
        orgId: world.orgId,
        sandboxId: 'completion-revoked-sandbox',
        prompt: 'Analyze my usage',
        status: 'running',
        runTokenHash: await sha256Hex(token),
        maxRuntimeMs: 60_000,
        updatedAt: 1,
        startedAt: 1,
        nextSeq: 0,
      });
    });
    const authorization = await world.t.action(api.analystSandbox.authorizeSandboxCompletion, {
      runId,
      token,
      status: 'completed',
    });
    await world.t.run(async (ctx) => {
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user_id', (q) => q.eq('userId', world.userId))
        .first();
      await ctx.db.patch(membership!._id, { status: 'removed', removedAt: Date.now() });
    });

    await expect(
      world.t.action(api.analystSandbox.completeSandboxRun, {
        runId,
        token,
        sandboxId: authorization.sandboxId!,
        reservation: authorization.reservation,
        status: 'completed',
        backup: { id: 'new-backup', dir: '/workspace' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      transitioned: true,
      backupAccepted: false,
      backupIdsToDelete: ['new-backup', 'prior-backup'],
    });
    const thread = await world.t.run((ctx) => ctx.db.get(threadId));
    expect(thread?.sandboxBackup).toBeUndefined();
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
