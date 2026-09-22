import { describe, expect, it, vi } from 'vitest';
import type { ArchiveApiEnv } from '../context';
import {
  listArchiveSessionCatalog,
  registerCommittedArchiveLedgers,
} from '../archive-session-catalog';

const orgId = 'k57axc8sefsfp6k28nx6c481js806pwv';
const committed = {
  scope: {
    orgId,
    userId: 'j57axc8sefsfp6k28nx6c481js806pwv',
    contributionId: 'n57axc8sefsfp6k28nx6c481js806pwv',
    source: 'claude' as const,
    sourceSessionId: 'session-1',
  },
  keyVersion: 1,
  elementCount: 2,
  recordCount: 1,
  chainHead: `sha256:${'1'.repeat(64)}`,
  generation: 1,
  manifestKey: 'manifest-key',
  manifestHeadPageKey: 'manifest-page-key',
};

function environment(snapshots: Record<string, unknown>) {
  const registerLedger = vi.fn(async () => undefined);
  const listArchiveLedgersForOrganization = vi.fn(async () => ({
    ledgerIds: Object.keys(snapshots),
  }));
  const env = {
    ARCHIVE_SESSION_LEDGER: {
      idFromString: vi.fn((id: string) => ({ id }) as unknown as DurableObjectId),
      get: vi.fn((id: { id: string }) => ({
        exportCatalogEntry: async () => snapshots[id.id],
      })),
    },
    STORAGE_BUDGET: {
      getByName: vi.fn(() => ({ registerLedger, listArchiveLedgersForOrganization })),
    },
  } as unknown as ArchiveApiEnv;
  return { env, registerLedger, listArchiveLedgersForOrganization };
}

describe('archive session catalog', () => {
  it('lists only committed registry entries with their pinned scope and manifest', async () => {
    const { env } = environment({ ['a'.repeat(64)]: committed, ['b'.repeat(64)]: null });
    await expect(listArchiveSessionCatalog(env, orgId)).resolves.toEqual({
      sessions: [
        {
          ledgerId: 'a'.repeat(64),
          userId: committed.scope.userId,
          contributionId: committed.scope.contributionId,
          source: 'claude',
          sourceSessionId: 'session-1',
          manifestKey: 'manifest-key',
          manifestHeadPageKey: 'manifest-page-key',
          generation: 1,
          elementCount: 2,
          recordCount: 1,
          chainHead: committed.chainHead,
        },
      ],
    });
  });

  it('backfills only Durable Objects with committed ledger state', async () => {
    const ledgerId = 'a'.repeat(64);
    const { env, registerLedger } = environment({ [ledgerId]: committed, ['b'.repeat(64)]: null });
    await expect(registerCommittedArchiveLedgers(env, [ledgerId, 'b'.repeat(64)])).resolves.toEqual(
      { inspected: 2, committed: 1, registered: 1 },
    );
    expect(registerLedger).toHaveBeenCalledWith({ orgId, ledgerId });
  });
});
