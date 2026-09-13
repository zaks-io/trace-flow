import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { finishSnapshotCopies } from './snapshot-coordinator-helpers';
import {
  AgentDeliveryCoordinator,
  type AgentDeliveryCoordinatorInstance,
  MAX_AGENT_DELIVERY_RETENTION_MS,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
} from '../agent-delivery-coordinator';

const CLAIM_ID = 'claim-a';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('AgentDeliveryCoordinator dirty day links', () => {
  let storageHost: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    storageHost = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  });

  const withCoordinator = <T>(
    callback: (coordinator: AgentDeliveryCoordinatorInstance) => T | Promise<T>,
  ): Promise<T> =>
    runInDurableObject(storageHost, (_instance, state) =>
      callback(new AgentDeliveryCoordinator(state, {} as AgentConsumerEnv)),
    );

  it('deduplicates undirected links and keeps both correction days in one snapshot', async () => {
    await reserve('delivery-linked', HASH_A, ['2026-09-13']);
    await withCoordinator((coordinator) =>
      coordinator.replaceDirtyDays({
        deliveryId: 'delivery-linked',
        payloadSha256: HASH_A,
        dirtyDays: ['2026-09-01', '2026-09-13'],
      }),
    );
    await expect(
      withCoordinator((coordinator) =>
        coordinator.linkDirtyDays({
          deliveryId: 'delivery-linked',
          payloadSha256: HASH_A,
          links: [
            { oldDay: '2026-09-13', newDay: '2026-09-01' },
            { oldDay: '2026-09-01', newDay: '2026-09-13' },
          ],
        }),
      ),
    ).resolves.toEqual({ linkedEdges: 1 });
    await complete('delivery-linked', HASH_A);
    for (let day = 6; day <= 12; day += 1) {
      const dirtyDay = `2026-09-${String(day).padStart(2, '0')}`;
      await reserve(`delivery-${day}`, HASH_A, [dirtyDay]);
      await complete(`delivery-${day}`, HASH_A);
    }

    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: [
        '2026-09-01',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
        '2026-09-13',
      ],
    });
  });

  it('captures an oversized transitive correction component whole with a renewable lease', async () => {
    const days = Array.from({ length: 32 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 13) - index * 86_400_000).toISOString().slice(0, 10),
    ).sort();
    await reserve('delivery-chain', HASH_A, days);
    await withCoordinator((coordinator) =>
      coordinator.linkDirtyDays({
        deliveryId: 'delivery-chain',
        payloadSha256: HASH_A,
        links: days.slice(1).map((day, index) => ({ oldDay: days[index]!, newDay: day })),
      }),
    );
    await complete('delivery-chain', HASH_A);

    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: days,
    });
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        gateExpiresAtMs: Date.now() + MAX_AGENT_SNAPSHOT_LEASE_MS,
      },
    );
  });

  it('blocks an entire linked component when either endpoint is incomplete', async () => {
    await createCompletedLink('delivery-linked', '2026-09-12', '2026-09-13');
    await reserve('delivery-unaffected', HASH_A, ['2026-09-11']);
    await complete('delivery-unaffected', HASH_A);
    const expiring = await reserve('delivery-expiring', HASH_B, ['2026-09-13']);
    vi.setSystemTime(expiring.expiresAtMs);
    await withCoordinator((coordinator) =>
      coordinator.expire({ deliveryId: 'delivery-expiring', payloadSha256: HASH_B }),
    );

    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: ['2026-09-11'],
    });
  });

  it('deletes captured links only after successful completion', async () => {
    await createCompletedLink('delivery-linked', '2026-09-12', '2026-09-13');
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    await withCoordinator((coordinator) =>
      finishSnapshotCopies(coordinator, snapshot.generation, CLAIM_ID),
    );

    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 0,
        dirtyDayLinks: 0,
      },
    );
  });

  it('preserves links when a snapshot fails', async () => {
    await createCompletedLink('delivery-linked', '2026-09-12', '2026-09-13');
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    await withCoordinator((coordinator) =>
      coordinator.failSnapshot({ generation: snapshot.generation, claimId: CLAIM_ID }),
    );

    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 2,
        dirtyDayLinks: 1,
      },
    );
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: snapshot.generation + 1,
      dirtyDays: ['2026-09-12', '2026-09-13'],
    });
  });

  it('prunes a link when either endpoint leaves the retained fact window', async () => {
    await createCompletedLink('delivery-linked', '2025-09-13', '2026-09-13');
    vi.advanceTimersByTime(86_400_000);

    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 1,
        dirtyDayLinks: 0,
      },
    );
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: ['2026-09-13'],
    });
  });

  async function createCompletedLink(
    deliveryId: string,
    oldDay: string,
    newDay: string,
  ): Promise<void> {
    await reserve(deliveryId, HASH_A, [oldDay, newDay]);
    await withCoordinator((coordinator) =>
      coordinator.linkDirtyDays({
        deliveryId,
        payloadSha256: HASH_A,
        links: [{ oldDay, newDay }],
      }),
    );
    await complete(deliveryId, HASH_A);
  }

  async function reserve(deliveryId: string, payloadSha256: string, dirtyDays: string[]) {
    const input = {
      deliveryId,
      payloadSha256,
      dirtyDays,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
    };
    await withCoordinator((coordinator) => coordinator.reserve(input));
    await withCoordinator((coordinator) => coordinator.acquireWrite({ deliveryId, payloadSha256 }));
    return input;
  }

  async function complete(deliveryId: string, payloadSha256: string): Promise<void> {
    await withCoordinator((coordinator) => coordinator.complete({ deliveryId, payloadSha256 }));
  }
});
