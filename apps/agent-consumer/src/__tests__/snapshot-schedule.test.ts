import { describe, expect, it, vi } from 'vitest';
import type { AgentDeliveryCoordinatorStats } from '../agent-delivery-coordinator-contract';
import { publishAgentSnapshot } from '../snapshot-schedule';

function fixture(overrides: Partial<AgentDeliveryCoordinatorStats>) {
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(async () => 'org-1'),
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (value: number) => {
      alarm = value;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
  } as unknown as DurableObjectStorage;
  const send = vi.fn(async () => undefined);
  const queue = { send } as unknown as Queue<{ type: 'agent-snapshot'; org_id: string }>;
  const stats: AgentDeliveryCoordinatorStats = {
    lastDeliverySequence: 1,
    lastSnapshotGeneration: 1,
    activeDeliveries: 0,
    dirtyDays: 1,
    incompleteDays: 0,
    dirtyDayLinks: 0,
    capturedSnapshotDays: 1,
    gatePhase: 'snapshot',
    activeSnapshotGeneration: 1,
    gateExpiresAtMs: Date.now() - 1,
    erasureStarted: false,
    databaseSizeBytes: 1,
    ...overrides,
  };
  return { storage, queue, send, stats };
}

describe('snapshot recovery alarm', () => {
  it('requeues an active generation whose worker claim expired', async () => {
    const f = fixture({});
    await publishAgentSnapshot(f.storage, f.queue, f.stats);
    expect(f.send).toHaveBeenCalledWith({ type: 'agent-snapshot', org_id: 'org-1' });
  });

  it('does not compete with a live snapshot worker claim', async () => {
    const f = fixture({ gateExpiresAtMs: Date.now() + 60_000 });
    await publishAgentSnapshot(f.storage, f.queue, f.stats);
    expect(f.send).not.toHaveBeenCalled();
  });
});
