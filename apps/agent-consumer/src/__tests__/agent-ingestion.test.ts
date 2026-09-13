import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ACTIVE_AGENT_DELIVERIES } from '../agent-delivery-coordinator-contract';
import type { AgentConsumerEnv } from '../context';
import { AgentIngestion } from '../index';

const OPEN_STATS = {
  gatePhase: 'open',
  activeDeliveries: 0,
  erasureStarted: false,
} as const;

function service(
  stats: {
    gatePhase: 'open' | 'draining' | 'snapshot';
    activeDeliveries: number;
    erasureStarted: boolean;
  },
  migration: { complete: boolean } | null,
) {
  const getStats = vi.fn(async () => stats);
  const getIngestionMigrationState = vi.fn(async () => migration);
  const getByName = vi.fn(() => ({ getStats, getIngestionMigrationState }));
  const entrypoint = new AgentIngestion(createExecutionContext(), {
    AGENT_DELIVERY_COORDINATOR: { getByName },
  } as unknown as AgentConsumerEnv);
  return { entrypoint, getByName };
}

describe('AgentIngestion delivery admission', () => {
  it.each([
    { stats: OPEN_STATS, migration: null, accepted: true },
    { stats: OPEN_STATS, migration: { complete: true }, accepted: true },
    { stats: { ...OPEN_STATS, erasureStarted: true }, migration: null, accepted: false },
    { stats: { ...OPEN_STATS, gatePhase: 'draining' as const }, migration: null, accepted: false },
    {
      stats: { ...OPEN_STATS, activeDeliveries: MAX_ACTIVE_AGENT_DELIVERIES },
      migration: null,
      accepted: false,
    },
    { stats: OPEN_STATS, migration: { complete: false }, accepted: false },
  ])(
    'returns $accepted for $stats and migration $migration',
    async ({ stats, migration, accepted }) => {
      const { entrypoint, getByName } = service(stats, migration);

      await expect(entrypoint.canAcceptDeliveries('org-1')).resolves.toBe(accepted);
      expect(getByName).toHaveBeenCalledWith('org:org-1');
    },
  );

  it('rejects invalid organization identifiers before coordinator access', async () => {
    const { entrypoint, getByName } = service(OPEN_STATS, null);

    await expect(entrypoint.canAcceptDeliveries('org:1')).rejects.toThrow('agent shardId');
    expect(getByName).not.toHaveBeenCalled();
  });
});
