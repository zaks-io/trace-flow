import { describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { deleteOrgData, deleteOrgDataScheduled } from '../admin/admin';
import { internal } from '../_generated/api';
import { initConvexTest } from './convexTest.setup';

interface DeleteCounts {
  apiKeys: number;
  collectorCredentials: number;
  usage: number;
  addonPurchases: number;
  membersRemoved: number;
  invites: number;
  alerts: number;
  mcpSessions: number;
  mcpRefreshTokens: number;
}

interface DeleteResult {
  tinybirdResults:
    | { deleted: false; reason: string }
    | { deleted: true; results: Record<string, { success: boolean; error?: string }> };
  convexDeleted: DeleteCounts;
  stripeCanceled: boolean;
}

type DeleteHandler = (
  ctx: ReturnType<typeof makeDeleteCtx>,
  args: { orgId: string },
) => Promise<DeleteResult>;

const emptyCounts = (): DeleteCounts => ({
  apiKeys: 0,
  collectorCredentials: 0,
  usage: 0,
  addonPurchases: 0,
  membersRemoved: 0,
  invites: 0,
  alerts: 0,
  mcpSessions: 0,
  mcpRefreshTokens: 0,
});

function makeDeleteCtx(batchCounts: DeleteCounts[]) {
  let queryCount = 0;
  let batchIndex = 0;
  let mutationIndex = 0;

  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue({ subject: 'admin' }),
    },
    runAction: vi.fn().mockResolvedValue({ deleted: true, results: {} }),
    runQuery: vi.fn().mockImplementation(() => {
      queryCount++;
      if (queryCount === 1) return Promise.resolve({ _id: 'org_1' });
      if (queryCount === 2) return Promise.resolve(null);
      throw new Error(`Unexpected query ${queryCount}`);
    }),
    runMutation: vi.fn().mockImplementation(() => {
      if (mutationIndex++ === 0) return Promise.resolve(null);
      if (batchIndex < batchCounts.length) {
        const counts = batchCounts[batchIndex];
        batchIndex++;
        return Promise.resolve({ counts, hasMore: batchIndex < batchCounts.length });
      }
      return Promise.resolve(null);
    }),
  };
}

const scheduledHandler = (deleteOrgDataScheduled as unknown as { _handler: DeleteHandler })
  ._handler;

describe('admin.deleteOrgData', () => {
  it('deletes legacy runtime rows in bounded batches without touching another org', async () => {
    const t = initConvexTest();
    const { orgId, otherRunId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        email: 'legacy@example.com',
        enabled: true,
        tokenIdentifier: 'legacy',
      });
      const orgId = await ctx.db.insert('organizations', { name: 'Retiring', ownerId: userId });
      const otherOrgId = await ctx.db.insert('organizations', {
        name: 'Retained',
        ownerId: userId,
      });
      const threadId = await ctx.db.insert('analystThreads', {
        creatorUserId: userId,
        orgId,
        agentThreadId: 'legacy-thread',
        title: 'Legacy',
        status: 'active',
        updatedAt: 1,
        sandboxBackup: { id: 'snapshots/legacy/backup', dir: '/workspace', updatedAt: 1 },
      });
      const run = {
        analystThreadId: threadId,
        creatorUserId: userId,
        sandboxId: 'legacy',
        prompt: 'Old request',
        status: 'completed' as const,
        runTokenHash: 'legacy-hash',
        maxRuntimeMs: 1,
        updatedAt: 1,
        nextSeq: 0,
      };
      const runId = await ctx.db.insert('analystSandboxRuns', { ...run, orgId });
      const otherRunId = await ctx.db.insert('analystSandboxRuns', { ...run, orgId: otherOrgId });
      for (let seq = 0; seq < 505; seq++) {
        await ctx.db.insert('analystSandboxRunEvents', {
          runId,
          analystThreadId: threadId,
          creatorUserId: userId,
          orgId,
          seq,
          type: 'status',
          emittedAt: 1,
        });
      }
      await ctx.db.insert('analystSandboxRunEvents', {
        runId: otherRunId,
        analystThreadId: threadId,
        creatorUserId: userId,
        orgId: otherOrgId,
        seq: 0,
        type: 'status',
        emittedAt: 1,
      });
      return { orgId, otherRunId };
    });
    const first = await t.mutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });
    expect(first.hasMore).toBe(true);
    expect(await t.run((ctx) => ctx.db.query('analystSandboxRunEvents').collect())).toHaveLength(6);
    const second = await t.mutation(internal.admin.admin.deleteOrgRecordsBatch, { orgId });
    expect(second.hasMore).toBe(false);
    expect(await t.run((ctx) => ctx.db.query('analystSandboxRuns').collect())).toEqual([
      expect.objectContaining({ _id: otherRunId }),
    ]);
    expect(await t.run((ctx) => ctx.db.query('analystSandboxRunEvents').collect())).toEqual([
      expect.objectContaining({ runId: otherRunId }),
    ]);
  });

  it('starts deletion when the retained migration schema field is still present', async () => {
    const t = initConvexTest();
    const orgId = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert('users', {
        email: 'owner@example.com',
        tokenIdentifier: 'deletion-owner',
        enabled: true,
      });
      return ctx.db.insert('organizations', {
        name: 'Deletion',
        ownerId,
        agentIngestionMigrationId: 'bounded-agent-ingestion-v1',
      });
    });

    await t.mutation(internal.admin.admin.beginOrgDeletion, { orgId });
    const organization = await t.run((ctx) => ctx.db.get(orgId));

    expect(organization?.deletionStartedAt).toEqual(expect.any(Number));
    expect(organization?.agentIngestionMigrationId).toBe('bounded-agent-ingestion-v1');
  });

  it('reports zero Collector Credentials when scheduled deletion finds an already-deleted org', async () => {
    const ctx = makeDeleteCtx([]);
    ctx.runQuery.mockResolvedValueOnce(null);

    const result = await scheduledHandler(ctx, { orgId: 'org_1' });

    expect(result.convexDeleted.collectorCredentials).toBe(0);
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it('accumulates Collector Credential counts across deletion batches', async () => {
    const firstBatch = { ...emptyCounts(), apiKeys: 498, collectorCredentials: 2 };
    const secondBatch = { ...emptyCounts(), collectorCredentials: 3, usage: 4 };
    const ctx = makeDeleteCtx([firstBatch, secondBatch]);

    const result = await scheduledHandler(ctx, { orgId: 'org_1' });

    expect(result.convexDeleted).toEqual({
      ...emptyCounts(),
      apiKeys: 498,
      collectorCredentials: 5,
      usage: 4,
    });
  });

  it('reports Collector Credential counts from the public admin action', async () => {
    const ctx = makeDeleteCtx([{ ...emptyCounts(), collectorCredentials: 2 }]);
    ctx.runQuery.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(null);
    const handler = (deleteOrgData as unknown as { _handler: DeleteHandler })._handler;

    const result = await handler(ctx, { orgId: 'org_1' });

    expect(result.convexDeleted.collectorCredentials).toBe(2);
  });

  it('starts organization deletion before the ingestion erasure action', async () => {
    const ctx = makeDeleteCtx([emptyCounts()]);
    const handler = (deleteOrgData as unknown as { _handler: DeleteHandler })._handler;

    await handler(ctx, { orgId: 'org_1' });

    expect(ctx.runMutation.mock.calls[0]?.[1]).toEqual({ orgId: 'org_1' });
    expect(ctx.runMutation.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runAction.mock.invocationCallOrder[0]!,
    );
  });

  it('drains agent ingestion before deleting Tinybird data', async () => {
    const ctx = makeDeleteCtx([emptyCounts()]);
    const handler = (deleteOrgData as unknown as { _handler: DeleteHandler })._handler;
    await handler(ctx, { orgId: 'org_1' });
    expect(ctx.runAction.mock.calls.map((call) => getFunctionName(call[0]))).toEqual([
      'agentIngestionErasure:eraseOrganization',
      'integrations/tinybird:deleteOrgTraces',
    ]);
    expect(ctx.runMutation.mock.invocationCallOrder[1]).toBeGreaterThan(
      ctx.runAction.mock.invocationCallOrder[1]!,
    );
  });

  it('does not delete analytics or finalize the organization while ingestion is still writing', async () => {
    const ctx = makeDeleteCtx([emptyCounts()]);
    ctx.runAction.mockRejectedValueOnce(new Error('Outstanding ingestion writes'));
    await expect(scheduledHandler(ctx, { orgId: 'org_1' })).rejects.toThrow(
      'Outstanding ingestion writes',
    );
    expect(ctx.runAction).toHaveBeenCalledTimes(1);
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });
});
