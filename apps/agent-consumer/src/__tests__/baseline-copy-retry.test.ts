import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { TraceRecovery } from '../index';
import type { RetryBaselineCopyInput } from '../baseline-copy-contract';

const proof: RetryBaselineCopyInput = {
  category: 'tool_events',
  expectedJobId: 'job-failed',
  expectedCopyAttempt: 10,
  nextCopyAttempt: 11,
  observedAt: 11,
  providerErrorSha256: 'a'.repeat(64),
  journalSha256: 'b'.repeat(64),
};

const emptyStats = {
  lastDeliverySequence: 1,
  lastSnapshotGeneration: 0,
  activeDeliveries: 0,
  dirtyDays: 0,
  incompleteDays: 0,
  dirtyDayLinks: 0,
  capturedSnapshotDays: 0,
  gatePhase: 'open' as const,
  activeSnapshotGeneration: null,
  gateExpiresAtMs: null,
  erasureStarted: false,
  databaseSizeBytes: 1,
};

describe('baseline Copy retry service guard', () => {
  it('checks the organization coordinator before mutating the separate baseline checkpoint', async () => {
    const fixture = serviceFixture();

    await expect(fixture.recovery.retryBaselineCopy('org-1', proof)).resolves.toEqual({
      armed: true,
    });
    expect(fixture.names).toEqual(['org:org-1', 'baseline:org-1']);
    expect(fixture.retry).toHaveBeenCalledWith(proof);
  });

  it('rejects a seeded migration without touching the baseline checkpoint', async () => {
    const fixture = serviceFixture({
      migration: { proofSha256: 'c'.repeat(64), complete: false },
    });

    await expect(fixture.recovery.retryBaselineCopy('org-1', proof)).rejects.toThrow(
      'forbidden after migration seed',
    );
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it('rejects nonquiescent or unfrozen organization state', async () => {
    const active = serviceFixture({ stats: { ...emptyStats, activeDeliveries: 1 } });
    await expect(active.recovery.retryBaselineCopy('org-1', proof)).rejects.toThrow(
      'empty organization coordinator',
    );
    expect(active.retry).not.toHaveBeenCalled();

    const unfrozen = serviceFixture({ legacyMigrationId: null });
    await expect(unfrozen.recovery.retryBaselineCopy('org-1', proof)).rejects.toThrow(
      'frozen, drained legacy ingestion',
    );
    expect(unfrozen.retry).not.toHaveBeenCalled();
  });
});

function serviceFixture(
  overrides: {
    migration?: { proofSha256: string; complete: boolean } | null;
    stats?: typeof emptyStats;
    legacyMigrationId?: string | null;
  } = {},
) {
  const retry = vi.fn(async () => ({ armed: true }));
  const names: string[] = [];
  const organization = {
    getIngestionMigrationState: vi.fn(async () => overrides.migration ?? null),
    getStats: vi.fn(async () => overrides.stats ?? emptyStats),
  };
  const baseline = { retryBaselineCopy: retry };
  const env = {
    AGENT_DELIVERY_COORDINATOR: {
      getByName(name: string) {
        names.push(name);
        return name.startsWith('org:') ? organization : baseline;
      },
    },
    AGENT_FACT_BATCHER: {
      getByName() {
        return {
          getIngestionMigrationState: vi.fn(async () => ({
            migrationId:
              overrides.legacyMigrationId === undefined
                ? 'bounded-agent-ingestion-v1'
                : overrides.legacyMigrationId,
            queuedRows: 0,
            flushing: false,
          })),
        };
      },
    },
  } as unknown as AgentConsumerEnv;
  return {
    retry,
    names,
    recovery: new TraceRecovery(createExecutionContext(), env),
  };
}
