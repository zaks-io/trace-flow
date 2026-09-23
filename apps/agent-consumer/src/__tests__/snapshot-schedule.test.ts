import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeliveryCoordinatorInstance } from '../agent-delivery-coordinator';
import type { AgentDeliveryCoordinatorStats } from '../agent-delivery-coordinator-contract';
import type { AgentConsumerEnv } from '../context';
import {
  publishAgentSnapshot,
  scheduleAgentSnapshot,
  scheduleAgentSnapshotContinuation,
} from '../snapshot-schedule';

const env = workerEnv as unknown as AgentConsumerEnv;
const START = Date.now() + 24 * 60 * 60_000;

function stats(
  overrides: Partial<AgentDeliveryCoordinatorStats> = {},
): AgentDeliveryCoordinatorStats {
  return {
    lastDeliverySequence: 1,
    lastSnapshotGeneration: 1,
    activeDeliveries: 0,
    dirtyDays: 1,
    incompleteDays: 0,
    dirtyDayLinks: 0,
    capturedSnapshotDays: 1,
    gatePhase: 'snapshot',
    activeSnapshotGeneration: 1,
    gateExpiresAtMs: START - 1,
    erasureStarted: false,
    databaseSizeBytes: 1,
    ...overrides,
  };
}

describe('snapshot recovery alarm', () => {
  let host: DurableObjectStub<AgentDeliveryCoordinatorInstance>;
  let send: ReturnType<typeof vi.fn>;
  let queue: Queue<{ type: 'agent-snapshot'; org_id: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    host = env.AGENT_DELIVERY_COORDINATOR.get(env.AGENT_DELIVERY_COORDINATOR.newUniqueId());
    send = vi.fn(async () => undefined);
    queue = { send } as unknown as typeof queue;
  });

  afterEach(() => vi.useRealTimers());

  const withStorage = <T>(
    callback: (storage: DurableObjectStorage) => T | Promise<T>,
  ): Promise<T> => runInDurableObject(host, (_instance, state) => callback(state.storage));

  it('debounces the first dispatch and retains a wake-up after a queue send', async () => {
    await withStorage((storage) => scheduleAgentSnapshot(storage, 'org-1'));
    expect(await withStorage((storage) => storage.getAlarm())).toBe(START + 60_000);
    expect(send).not.toHaveBeenCalled();

    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gatePhase: 'open' })),
    );
    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 59_999);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gatePhase: 'open' })),
    );
    expect(send).not.toHaveBeenCalled();

    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 60_000);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gatePhase: 'open' })),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'agent-snapshot', org_id: 'org-1' });
    expect(await withStorage((storage) => storage.getAlarm())).toBe(Date.now() + 60_000);
  });

  it('suppresses a duplicate while a claim is live, then dispatches for crash recovery', async () => {
    await withStorage((storage) => scheduleAgentSnapshotContinuation(storage, 'org-1'));
    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 15_000);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gateExpiresAtMs: START + 300_000 })),
    );
    expect(send).not.toHaveBeenCalled();
    expect(await withStorage((storage) => storage.getAlarm())).toBe(START + 300_000);

    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 300_000);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gateExpiresAtMs: START + 300_000 })),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'agent-snapshot', org_id: 'org-1' });
    expect(await withStorage((storage) => storage.getAlarm())).toBe(START + 360_000);

    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 360_000);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gateExpiresAtMs: START + 300_000 })),
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('clears an idle alarm without dispatching', async () => {
    await withStorage((storage) => scheduleAgentSnapshot(storage, 'org-1'));
    await withStorage((storage) => storage.deleteAlarm());
    vi.setSystemTime(START + 60_000);
    await withStorage((storage) =>
      publishAgentSnapshot(storage, queue, stats({ gatePhase: 'open', dirtyDays: 0 })),
    );
    expect(send).not.toHaveBeenCalled();
    expect(await withStorage((storage) => storage.getAlarm())).toBeNull();
  });
});
