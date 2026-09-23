import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';
import type * as SentryCloudflare from '@sentry/cloudflare';

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryCloudflare>()),
  instrumentDurableObjectWithSentry: <T>(_options: unknown, DurableObjectClass: T): T =>
    DurableObjectClass,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
import type { AgentConsumerEnv } from '../context';
import type { AgentDeliveryCoordinatorInstance } from '../agent-delivery-coordinator';
import { AgentDeliveryCoordinator } from '../agent-delivery-coordinator';
import { MAX_AGENT_DELIVERY_RETENTION_MS } from '../agent-delivery-coordinator-contract';
import { runAgentSnapshot } from '../snapshot-runner';

export async function makeSnapshotRunner(dirtyDays = [new Date().toISOString().slice(0, 10)]) {
  const orgId = `snapshot-${crypto.randomUUID()}`;
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const capacity = {
    acquire: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const host = workerEnv.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
  const bindings = {
    ...workerEnv,
    AGENT_SNAPSHOT_QUEUE: { send: queueSend },
  } as unknown as AgentConsumerEnv;
  // Real SQLite coordinator state survives every runner invocation; only external services are fake.
  const coordinator = new Proxy({} as DurableObjectStub<AgentDeliveryCoordinatorInstance>, {
    get(_target, name) {
      return (...args: unknown[]) =>
        runInDurableObject(host, async (_instance, state) => {
          const instance = new AgentDeliveryCoordinator(state, bindings);
          const method = instance[name as keyof AgentDeliveryCoordinatorInstance] as (
            ...input: unknown[]
          ) => unknown;
          try {
            return await method.apply(instance, args);
          } finally {
            await state.storage.deleteAlarm();
          }
        });
    },
  });
  const env = {
    ...bindings,
    AGENT_DELIVERY_COORDINATOR: { getByName: () => coordinator },
    AGENT_SNAPSHOT_CAPACITY: { getByName: () => capacity },
  } as unknown as AgentConsumerEnv;
  const delivery = { deliveryId: 'delivery-1', payloadSha256: 'a'.repeat(64) };
  await coordinator.reserve({
    ...delivery,
    dirtyDays,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
  });
  if (dirtyDays.length > 1) {
    await coordinator.linkDirtyDays({
      ...delivery,
      links: dirtyDays.slice(1).map((newDay, index) => ({ oldDay: dirtyDays[index]!, newDay })),
    });
  }
  await coordinator.complete(delivery);
  const wake = async () => {
    const schedule = await coordinator.getSnapshotSchedule({});
    if (schedule.wakeAtMs !== null && schedule.wakeAtMs > Date.now())
      vi.setSystemTime(schedule.wakeAtMs);
    return runAgentSnapshot(env, orgId);
  };
  const finish = async () => {
    for (let i = 0; i < 150; i++) {
      const result = await wake();
      if (result.status === 'complete' || result.status === 'blocked') return result;
    }
    throw new Error('Snapshot did not settle within its test budget');
  };
  return { coordinator, env, orgId, queueSend, capacity, wake, finish };
}
