import { describe, expect, it, vi } from 'vitest';
import { deleteOrgData, deleteOrgDataScheduled } from '../admin/admin';

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
});
