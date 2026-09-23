import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { AGENT_SNAPSHOT_TARGETS } from '../snapshot-tinybird';
import { finishSnapshotCopies } from './snapshot-coordinator-helpers';

const env = workerEnv as unknown as AgentConsumerEnv;
const payloadSha256 = 'a'.repeat(64);

async function startSnapshot(orgId: string, deliveryId = crypto.randomUUID()) {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  await coordinator.reserve({
    deliveryId,
    payloadSha256,
    dirtyDays: [new Date().toISOString().slice(0, 10)],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  });
  await coordinator.complete({ deliveryId, payloadSha256 });
  const { generation } = await coordinator.beginSnapshot({ claimId: 'claim-a' });
  return { coordinator, key: { orgId, generation } };
}

describe('SnapshotCapacity', () => {
  it('grants exactly two simultaneous acquisitions', async () => {
    const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(crypto.randomUUID());
    const snapshots = await Promise.all(
      Array.from({ length: 3 }, () => startSnapshot(crypto.randomUUID())),
    );
    const granted = await Promise.all(snapshots.map((snapshot) => capacity.acquire(snapshot.key)));
    expect(granted.filter(Boolean)).toHaveLength(2);
  });

  it('bounds active generations and reaps a finished slot on the next acquisition', async () => {
    const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(crypto.randomUUID());
    const first = await startSnapshot(crypto.randomUUID());
    const second = await startSnapshot(crypto.randomUUID());
    const third = await startSnapshot(crypto.randomUUID());

    await expect(capacity.acquire(first.key)).resolves.toBe(true);
    await expect(capacity.acquire(second.key)).resolves.toBe(true);
    await expect(capacity.acquire(first.key)).resolves.toBe(true);
    await expect(capacity.acquire(third.key)).resolves.toBe(false);

    await capacity.release(first.key);
    await expect(capacity.acquire(third.key)).resolves.toBe(false);

    await runInDurableObject(first.coordinator, (instance) =>
      finishSnapshotCopies(instance, first.key.generation, 'claim-a'),
    );
    await expect(capacity.acquire(first.key)).resolves.toBe(false);
    await expect(capacity.acquire(third.key)).resolves.toBe(true);
    await expect(capacity.acquire(second.key)).resolves.toBe(true);
  });

  it('holds an erasing generation until its Copy intent is settled and snapshot abandoned', async () => {
    const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(crypto.randomUUID());
    const first = await startSnapshot(crypto.randomUUID());
    const second = await startSnapshot(crypto.randomUUID());
    const third = await startSnapshot(crypto.randomUUID());
    await capacity.acquire(first.key);
    await capacity.acquire(second.key);

    const intent = {
      generation: first.key.generation,
      target: AGENT_SNAPSHOT_TARGETS[0],
      copyAttempt: first.key.generation,
    };
    await first.coordinator.recordSnapshotCopyIntent({
      ...intent,
      claimId: 'claim-a',
      copyIndex: 0,
      startedAt: Date.now(),
    });
    await first.coordinator.beginErasure({});
    await capacity.release(first.key);
    await expect(capacity.acquire(third.key)).resolves.toBe(false);

    await first.coordinator.attachErasureSnapshotCopyJob({ ...intent, jobId: 'job-1' });
    await first.coordinator.settleErasureSnapshotCopyIntent({
      ...intent,
      jobId: 'job-1',
      status: 'error',
    });
    await capacity.release(first.key);
    await expect(capacity.acquire(third.key)).resolves.toBe(false);

    await first.coordinator.abandonErasureSnapshot({ generation: first.key.generation });
    await capacity.release(first.key);
    await expect(capacity.acquire(third.key)).resolves.toBe(true);
  });

  it('rejects stale keys and never releases a newer generation by old key', async () => {
    const capacity = env.AGENT_SNAPSHOT_CAPACITY.getByName(crypto.randomUUID());
    const first = await startSnapshot(crypto.randomUUID());
    await expect(
      capacity.acquire({ ...first.key, generation: first.key.generation + 1 }),
    ).resolves.toBe(false);
    await capacity.acquire(first.key);
    await runInDurableObject(first.coordinator, (instance) =>
      finishSnapshotCopies(instance, first.key.generation, 'claim-a'),
    );

    const next = await startSnapshot(first.key.orgId);
    expect(next.key.generation).toBe(first.key.generation + 1);
    await expect(capacity.acquire(next.key)).resolves.toBe(true);
    await capacity.release(first.key);
    await expect(capacity.acquire(next.key)).resolves.toBe(true);
  });
});
