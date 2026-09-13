import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_SNAPSHOT_TARGETS, snapshotCopyAttempt } from '../snapshot-tinybird';
import type { AgentConsumerEnv } from '../context';
import {
  MAX_AGENT_DELIVERY_RETENTION_MS,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
  type AgentDeliveryCoordinatorInstance,
} from '../agent-delivery-coordinator';

const CLAIM_ID = 'claim-a';

const env = workerEnv as unknown as AgentConsumerEnv;
const PAYLOAD_SHA256 = 'a'.repeat(64);
const MIGRATION_PROOF_SHA256 = 'b'.repeat(64);

describe('agent ingestion erasure fence', () => {
  let storageHost: DurableObjectStub<AgentDeliveryCoordinatorInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    storageHost = env.AGENT_DELIVERY_COORDINATOR.get(env.AGENT_DELIVERY_COORDINATOR.newUniqueId());
  });

  afterEach(() => vi.useRealTimers());

  const withCoordinator = <T>(
    callback: (
      coordinator: AgentDeliveryCoordinatorInstance,
      state: DurableObjectState,
    ) => T | Promise<T>,
  ): Promise<T> => runInDurableObject(storageHost, (instance, state) => callback(instance, state));

  it('permanently blocks new work while an existing reservation drains', async () => {
    const input = reservation('delivery-active');
    const reserved = await withCoordinator((coordinator) => coordinator.reserve(input));
    await withCoordinator((coordinator) => coordinator.scheduleSnapshot({ orgId: 'org-1' }));

    const started = await withCoordinator((coordinator) => coordinator.beginErasure({}));
    expect(started).toMatchObject({
      erasureStarted: true,
      activeDeliveries: 1,
      incompleteDays: 0,
      activeSnapshotGeneration: null,
      outstandingCopyIntents: 0,
      ready: false,
    });
    await expect(
      withCoordinator((_coordinator, state) => state.storage.getAlarm()),
    ).resolves.toBeNull();
    await expect(
      withCoordinator((_coordinator, state) => state.storage.get('snapshot_org_id')),
    ).resolves.toBeUndefined();
    await expect(withCoordinator((coordinator) => coordinator.reserve(input))).resolves.toEqual({
      status: 'existing',
      deliverySequence: reserved.deliverySequence,
    });
    await expect(
      withCoordinator((coordinator) => coordinator.reserve(reservation('delivery-new'))),
    ).rejects.toThrow('erasure has started');
    await expect(withCoordinator((coordinator) => coordinator.requestSnapshot({}))).rejects.toThrow(
      'erasure has started',
    );
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).rejects.toThrow('erasure has started');

    await withCoordinator((coordinator) =>
      coordinator.complete({ deliveryId: input.deliveryId, payloadSha256: input.payloadSha256 }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.scheduleSnapshot({ orgId: 'org-1' })),
    ).resolves.toEqual({ scheduled: false });
    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toEqual({ ...started, activeDeliveries: 0, ready: true });
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { erasureStarted: true, dirtyDays: 0, dirtyDayLinks: 0, capturedSnapshotDays: 0 },
    );
    await expect(withCoordinator((coordinator) => coordinator.beginErasure({}))).resolves.toEqual({
      ...started,
      activeDeliveries: 0,
      ready: true,
    });
  });

  it('keeps the completed migration routing fence after erasure becomes ready', async () => {
    await withCoordinator((coordinator) => {
      coordinator.seedIngestionMigration({
        proofSha256: MIGRATION_PROOF_SHA256,
        dirtyDays: [],
      });
      coordinator.completeIngestionMigration({ proofSha256: MIGRATION_PROOF_SHA256 });
    });

    await expect(
      withCoordinator((coordinator) => coordinator.beginErasure({})),
    ).resolves.toMatchObject({ ready: true });
    await expect(
      withCoordinator((coordinator) => coordinator.getIngestionMigrationState()),
    ).resolves.toEqual({ proofSha256: MIGRATION_PROOF_SHA256, complete: true });
    await expect(
      withCoordinator((coordinator) => coordinator.beginErasure({})),
    ).resolves.toMatchObject({ ready: true });
  });

  it('discards incomplete analytics after failed deliveries drain under the erasure fence', async () => {
    const first = reservation('delivery-expired');
    const second = reservation('delivery-still-active');
    await withCoordinator((coordinator) => coordinator.reserve(first));
    await withCoordinator((coordinator) => coordinator.reserve(second));
    await withCoordinator((coordinator) => coordinator.beginErasure({}));
    vi.advanceTimersByTime(MAX_AGENT_DELIVERY_RETENTION_MS);
    await withCoordinator((coordinator) =>
      coordinator.expire({ deliveryId: first.deliveryId, payloadSha256: first.payloadSha256 }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toMatchObject({ activeDeliveries: 1, incompleteDays: 1, ready: false });
    await withCoordinator((coordinator) =>
      coordinator.expire({ deliveryId: second.deliveryId, payloadSha256: second.payloadSha256 }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toMatchObject({ activeDeliveries: 0, incompleteDays: 0, ready: true });
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { erasureStarted: true, dirtyDays: 0, incompleteDays: 0 },
    );
    await expect(
      withCoordinator((coordinator) => coordinator.reserve(reservation('new-delivery'))),
    ).rejects.toThrow('erasure has started');
  });

  it('waits for a known Copy job to report terminal before becoming ready', async () => {
    await completeDelivery();
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    const key = copyKey(snapshot.generation, AGENT_SNAPSHOT_TARGETS[0]);
    await withCoordinator((coordinator) =>
      coordinator.recordSnapshotCopyIntent({
        ...key,
        claimId: CLAIM_ID,
        copyIndex: 0,
        startedAt: Date.now(),
      }),
    );
    await withCoordinator((coordinator) =>
      coordinator.attachSnapshotCopyJob({
        ...key,
        claimId: CLAIM_ID,
        copyIndex: 0,
        jobId: 'job-1',
      }),
    );
    await withCoordinator((coordinator) => coordinator.beginErasure({}));

    await expect(
      withCoordinator((coordinator) =>
        coordinator.recordSnapshotCopyIntent({
          ...copyKey(snapshot.generation, AGENT_SNAPSHOT_TARGETS[1]),
          claimId: CLAIM_ID,
          copyIndex: 1,
          startedAt: Date.now(),
        }),
      ),
    ).rejects.toThrow('erasure has started');
    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toMatchObject({
      activeSnapshotGeneration: snapshot.generation,
      outstandingCopyIntents: 1,
      ready: false,
    });
    await expect(
      withCoordinator((coordinator) => coordinator.getOutstandingSnapshotCopyIntents({})),
    ).resolves.toEqual([{ ...key, startedAt: Date.now(), jobId: 'job-1' }]);

    await withCoordinator((coordinator) =>
      coordinator.settleErasureSnapshotCopyIntent({
        ...key,
        jobId: 'job-1',
        status: 'done',
      }),
    );
    await withCoordinator((coordinator) =>
      coordinator.abandonErasureSnapshot({ generation: snapshot.generation }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toMatchObject({ outstandingCopyIntents: 0, ready: true });
  });

  it('retains an unknown Copy start across snapshot failure and lease expiry', async () => {
    await completeDelivery();
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    const intent = {
      ...copyKey(snapshot.generation, AGENT_SNAPSHOT_TARGETS[0]),
      claimId: CLAIM_ID,
      copyIndex: 0,
      startedAt: Date.now(),
    };
    await withCoordinator((coordinator) => coordinator.recordSnapshotCopyIntent(intent));
    await withCoordinator((coordinator) => coordinator.beginErasure({}));
    await expect(
      withCoordinator((coordinator) =>
        coordinator.failSnapshot({ generation: snapshot.generation, claimId: CLAIM_ID }),
      ),
    ).rejects.toThrow('outstanding Copy intents');
    vi.advanceTimersByTime(MAX_AGENT_SNAPSHOT_LEASE_MS * 2);

    await expect(
      withCoordinator((coordinator) => coordinator.getErasureState({})),
    ).resolves.toMatchObject({
      activeSnapshotGeneration: snapshot.generation,
      outstandingCopyIntents: 1,
      ready: false,
    });
    await expect(
      withCoordinator((coordinator) => coordinator.getOutstandingSnapshotCopyIntents({})),
    ).resolves.toEqual([
      {
        generation: intent.generation,
        target: intent.target,
        copyAttempt: intent.copyAttempt,
        startedAt: intent.startedAt,
      },
    ]);
  });

  it('accepts only the deterministic Copy key at the current cursor', async () => {
    await completeDelivery();
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    const target = AGENT_SNAPSHOT_TARGETS[0];
    const copyAttempt = snapshotCopyAttempt(snapshot.generation);

    await expect(
      withCoordinator((coordinator) =>
        coordinator.recordSnapshotCopyIntent({
          generation: snapshot.generation,
          target,
          copyAttempt,
          claimId: CLAIM_ID,
          copyIndex: 0,
          startedAt: Date.now(),
        }),
      ),
    ).resolves.toMatchObject({ generation: snapshot.generation, target, copyAttempt });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.recordSnapshotCopyIntent({
          generation: snapshot.generation,
          target,
          copyAttempt: copyAttempt + 1,
          claimId: CLAIM_ID,
          copyIndex: 0,
          startedAt: Date.now(),
        }),
      ),
    ).rejects.toThrow('does not match its cursor');
  });

  async function completeDelivery(): Promise<void> {
    const input = reservation('delivery-dirty');
    await withCoordinator((coordinator) => coordinator.reserve(input));
    await withCoordinator((coordinator) =>
      coordinator.complete({ deliveryId: input.deliveryId, payloadSha256: input.payloadSha256 }),
    );
  }
});

function reservation(deliveryId: string) {
  return {
    deliveryId,
    payloadSha256: PAYLOAD_SHA256,
    dirtyDays: ['2026-09-13'],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
  };
}

function copyKey(generation: number, target: (typeof AGENT_SNAPSHOT_TARGETS)[number]) {
  return { generation, target, copyAttempt: generation };
}
