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

function service(stats: {
  gatePhase: 'open' | 'draining' | 'snapshot';
  activeDeliveries: number;
  erasureStarted: boolean;
}) {
  const getStats = vi.fn(async () => stats);
  const getByName = vi.fn(() => ({ getStats }));
  const entrypoint = new AgentIngestion(createExecutionContext(), {
    AGENT_DELIVERY_COORDINATOR: { getByName },
  } as unknown as AgentConsumerEnv);
  return { entrypoint, getByName };
}

describe('AgentIngestion delivery admission', () => {
  it.each([
    { stats: OPEN_STATS, accepted: true },
    { stats: { ...OPEN_STATS, erasureStarted: true }, accepted: false },
    { stats: { ...OPEN_STATS, gatePhase: 'draining' as const }, accepted: false },
    {
      stats: { ...OPEN_STATS, activeDeliveries: MAX_ACTIVE_AGENT_DELIVERIES },
      accepted: false,
    },
  ])('returns $accepted for $stats', async ({ stats, accepted }) => {
    const { entrypoint, getByName } = service(stats);

    await expect(entrypoint.canAcceptDeliveries('org-1')).resolves.toBe(accepted);
    expect(getByName).toHaveBeenCalledWith('org:org-1');
  });

  it('rejects invalid organization identifiers before coordinator access', async () => {
    const { entrypoint, getByName } = service(OPEN_STATS);

    await expect(entrypoint.canAcceptDeliveries('org:1')).rejects.toThrow('agent shardId');
    expect(getByName).not.toHaveBeenCalled();
  });
});
