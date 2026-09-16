import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDeliveryCoordinator,
  MAX_AGENT_DELIVERY_RETENTION_MS,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
  type AgentDeliveryCoordinatorInstance,
} from '../agent-delivery-coordinator';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { AGENT_SNAPSHOT_TARGETS } from '../snapshot-tinybird';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const payloadSha256 = 'a'.repeat(64);

describe('agent snapshot progress', () => {
  let storageHost: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    storageHost = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  });

  afterEach(() => vi.useRealTimers());

  const withCoordinator = <T>(
    callback: (coordinator: AgentDeliveryCoordinatorInstance) => T | Promise<T>,
  ): Promise<T> =>
    runInDurableObject(storageHost, (_instance, state) =>
      callback(new AgentDeliveryCoordinator(state, {} as AgentConsumerEnv)),
    );

  async function beginSnapshot() {
    await withCoordinator((coordinator) => {
      coordinator.reserve({
        deliveryId: 'delivery-1',
        payloadSha256,
        dirtyDays: ['2026-09-13'],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
      });
      coordinator.complete({ deliveryId: 'delivery-1', payloadSha256 });
    });
    return withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: 'claim-a' }));
  }

  it('returns contention without changing the active claim and permits its owner to renew', async () => {
    const snapshot = await beginSnapshot();
    const progress = await withCoordinator((coordinator) =>
      coordinator.getSnapshotProgress({ generation: snapshot.generation, claimId: 'claim-a' }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.claimSnapshot({ claimId: 'claim-b' })),
    ).resolves.toBeNull();
    await expect(
      withCoordinator((coordinator) =>
        coordinator.getSnapshotProgress({ generation: snapshot.generation, claimId: 'claim-a' }),
      ),
    ).resolves.toEqual(progress);
    await expect(
      withCoordinator((coordinator) => coordinator.claimSnapshot({ claimId: 'claim-a' })),
    ).resolves.toMatchObject({ generation: snapshot.generation, claimId: 'claim-a' });
  });

  it('returns a pending claim across the Durable Object RPC boundary', async () => {
    vi.useRealTimers();
    const coordinator = workerEnv.AGENT_DELIVERY_COORDINATOR.getByName(crypto.randomUUID());
    const delivery = { deliveryId: 'delivery-1', payloadSha256 };
    await coordinator.reserve({
      ...delivery,
      dirtyDays: [new Date().toISOString().slice(0, 10)],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    await coordinator.complete(delivery);
    const snapshot = await coordinator.beginSnapshot({ claimId: 'claim-a' });
    await expect(coordinator.claimSnapshot({ claimId: 'claim-b' })).resolves.toBeNull();
    await expect(
      coordinator.getSnapshotProgress({ generation: snapshot.generation, claimId: 'claim-a' }),
    ).resolves.toMatchObject({ claimId: 'claim-a', nextCopyIndex: 0 });
  });

  it('fences an expired owner and resumes the same cursor under a new claim', async () => {
    const snapshot = await beginSnapshot();
    vi.advanceTimersByTime(MAX_AGENT_SNAPSHOT_LEASE_MS);

    const resumed = await withCoordinator((coordinator) =>
      coordinator.claimSnapshot({ claimId: 'claim-b' }),
    );
    expect(resumed).toMatchObject({
      generation: snapshot.generation,
      nextCopyIndex: 0,
      claimId: 'claim-b',
    });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.recordSnapshotCopyIntent({
          generation: snapshot.generation,
          target: AGENT_SNAPSHOT_TARGETS[0],
          copyAttempt: snapshot.generation,
          copyIndex: 0,
          claimId: 'claim-a',
          startedAt: Date.now(),
        }),
      ),
    ).rejects.toThrow('snapshot claim owner mismatch');
  });

  it('advances the cursor only in the transaction that settles a done job', async () => {
    const snapshot = await beginSnapshot();
    const key = {
      generation: snapshot.generation,
      target: AGENT_SNAPSHOT_TARGETS[0],
      copyAttempt: snapshot.generation,
      copyIndex: 0,
      claimId: 'claim-a',
    };
    await withCoordinator((coordinator) => {
      coordinator.recordSnapshotCopyIntent({ ...key, startedAt: Date.now() });
      coordinator.attachSnapshotCopyJob({ ...key, jobId: 'job-1' });
      coordinator.settleSnapshotCopyIntent({ ...key, jobId: 'job-1', status: 'done' });
    });

    await expect(
      withCoordinator((coordinator) =>
        coordinator.getSnapshotProgress({
          generation: snapshot.generation,
          claimId: 'claim-a',
        }),
      ),
    ).resolves.toMatchObject({ nextCopyIndex: 1 });
    await expect(
      withCoordinator((coordinator) => coordinator.getOutstandingSnapshotCopyIntents({})),
    ).resolves.toEqual([]);
  });

  it('keeps one manifest timestamp across retries of the immutable generation', async () => {
    const snapshot = await beginSnapshot();
    await withCoordinator((coordinator) => settleAllCopies(coordinator, snapshot.generation));
    const first = await withCoordinator((coordinator) =>
      coordinator.prepareSnapshotManifest({
        generation: snapshot.generation,
        claimId: 'claim-a',
      }),
    );
    vi.advanceTimersByTime(1_000);
    const retried = await withCoordinator((coordinator) =>
      coordinator.prepareSnapshotManifest({
        generation: snapshot.generation,
        claimId: 'claim-a',
      }),
    );
    expect(retried.manifestPublishedAtMs).toBe(first.manifestPublishedAtMs);
  });
});

function settleAllCopies(coordinator: AgentDeliveryCoordinatorInstance, generation: number): void {
  for (const [copyIndex, target] of AGENT_SNAPSHOT_TARGETS.entries()) {
    const key = { generation, target, copyAttempt: generation, copyIndex, claimId: 'claim-a' };
    const jobId = `job-${copyIndex}`;
    coordinator.recordSnapshotCopyIntent({ ...key, startedAt: Date.now() });
    coordinator.attachSnapshotCopyJob({ ...key, jobId });
    coordinator.settleSnapshotCopyIntent({ ...key, jobId, status: 'done' });
  }
}
