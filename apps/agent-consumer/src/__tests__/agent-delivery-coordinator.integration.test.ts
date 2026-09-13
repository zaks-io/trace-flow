import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { finishSnapshotCopies } from './snapshot-coordinator-helpers';
import {
  AgentDeliveryCoordinatorRetryableError,
  type AgentDeliveryCoordinatorInstance,
  MAX_ACTIVE_AGENT_DELIVERIES,
  MAX_AGENT_DELIVERY_RETENTION_MS,
  MAX_AGENT_DIRTY_DAYS,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
  MAX_AGENT_SNAPSHOT_DAYS,
} from '../agent-delivery-coordinator';

const CLAIM_ID = 'claim-a';

const env = workerEnv as unknown as AgentConsumerEnv;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('AgentDeliveryCoordinator', () => {
  let storageHost: DurableObjectStub<AgentDeliveryCoordinatorInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    storageHost = env.AGENT_DELIVERY_COORDINATOR.get(env.AGENT_DELIVERY_COORDINATOR.newUniqueId());
  });

  const withCoordinator = <T>(
    callback: (
      coordinator: AgentDeliveryCoordinatorInstance,
      state: DurableObjectState,
    ) => T | Promise<T>,
  ): Promise<T> => runInDurableObject(storageHost, (instance, state) => callback(instance, state));

  it('allocates monotonic sequences and supports an explicit migration bootstrap', async () => {
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        lastDeliverySequence: 1,
      },
    );
    await expect(
      withCoordinator((coordinator) => coordinator.bootstrapSequence({ lastAssignedSequence: 1 })),
    ).resolves.toEqual({ nextDeliverySequence: 2 });

    const first = await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-1', HASH_A, ['2026-09-13'])),
    );
    const second = await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-2', HASH_B, ['2026-09-12'])),
    );

    expect(first).toEqual({ status: 'reserved', deliverySequence: 2 });
    expect(second).toEqual({ status: 'reserved', deliverySequence: 3 });
    await expect(
      withCoordinator((coordinator) => coordinator.bootstrapSequence({ lastAssignedSequence: 1 })),
    ).rejects.toThrow('requires an empty coordinator');
  });

  it('returns the same reservation only for an exact idempotent retry', async () => {
    const input = reservation('delivery-1', HASH_A, ['2026-09-12', '2026-09-13']);
    const created = await withCoordinator((coordinator) => coordinator.reserve(input));
    const retried = await withCoordinator((coordinator) =>
      coordinator.reserve({ ...input, dirtyDays: [...input.dirtyDays].reverse() }),
    );

    expect(retried).toEqual({ status: 'existing', deliverySequence: created.deliverySequence });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-1', HASH_B, input.dirtyDays)),
      ),
    ).rejects.toThrow('payload hash mismatch');
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-1', HASH_A, ['2026-09-13'])),
      ),
    ).rejects.toThrow('dirty days mismatch');
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve({ ...input, expiresAtMs: input.expiresAtMs - 1 }),
      ),
    ).rejects.toThrow('retention metadata mismatch');

    await expect(
      withCoordinator((coordinator) => coordinator.getReservation({ deliveryId: 'delivery-1' })),
    ).resolves.toEqual({
      deliveryId: 'delivery-1',
      payloadSha256: HASH_A,
      deliverySequence: created.deliverySequence,
      dirtyDays: ['2026-09-12', '2026-09-13'],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
    });
  });

  it('caps active delivery metadata without evicting reservations', async () => {
    for (let index = 0; index < MAX_ACTIVE_AGENT_DELIVERIES; index += 1) {
      await withCoordinator((coordinator) =>
        coordinator.reserve(reservation(`delivery-${index}`, HASH_A, ['2026-09-13'])),
      );
    }

    const error = await withCoordinator((coordinator) => {
      try {
        coordinator.reserve(reservation('delivery-over-cap', HASH_A, ['2026-09-13']));
      } catch (caught) {
        return caught;
      }
      return null;
    });
    expect(error).toBeInstanceOf(AgentDeliveryCoordinatorRetryableError);
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { activeDeliveries: MAX_ACTIVE_AGENT_DELIVERIES },
    );
  });

  it('moves days to the dirty set atomically and rejects duplicate completion', async () => {
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-1', HASH_A, ['2026-09-13', '2026-09-12'])),
    );
    await expect(
      withCoordinator((coordinator) =>
        coordinator.complete({ deliveryId: 'delivery-1', payloadSha256: HASH_B }),
      ),
    ).rejects.toThrow('payload hash mismatch');

    await expect(
      withCoordinator((coordinator) =>
        coordinator.complete({ deliveryId: 'delivery-1', payloadSha256: HASH_A }),
      ),
    ).resolves.toEqual({ deliverySequence: 2, dirtyDays: ['2026-09-12', '2026-09-13'] });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.complete({ deliveryId: 'delivery-1', payloadSha256: HASH_A }),
      ),
    ).rejects.toThrow('unknown active delivery');
  });

  it('serializes canonical writes in accepted delivery order', async () => {
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-1', HASH_A, ['2026-09-12'])),
    );
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-2', HASH_B, ['2026-09-13'])),
    );

    await expect(
      withCoordinator((coordinator) =>
        coordinator.acquireWrite({ deliveryId: 'delivery-1', payloadSha256: HASH_A }),
      ),
    ).resolves.toBe(true);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.acquireWrite({ deliveryId: 'delivery-2', payloadSha256: HASH_B }),
      ),
    ).resolves.toBe(false);

    await withCoordinator((coordinator) =>
      coordinator.complete({ deliveryId: 'delivery-1', payloadSha256: HASH_A }),
    );
    await expect(
      withCoordinator((coordinator) =>
        coordinator.acquireWrite({ deliveryId: 'delivery-2', payloadSha256: HASH_B }),
      ),
    ).resolves.toBe(true);
  });

  it('gates reservations until a successful snapshot clears captured days', async () => {
    await completeOne('delivery-1', ['2026-09-11', '2026-09-13']);
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    expect(snapshot).toEqual({ generation: 1, dirtyDays: ['2026-09-11', '2026-09-13'] });

    const blocked = await withCoordinator((coordinator) => {
      try {
        coordinator.reserve(reservation('delivery-2', HASH_B, ['2026-09-13']));
      } catch (error) {
        return error;
      }
      return null;
    });
    expect(blocked).toBeInstanceOf(AgentDeliveryCoordinatorRetryableError);

    await expect(
      withCoordinator((coordinator) => finishSnapshotCopies(coordinator, 1, CLAIM_ID)),
    ).resolves.toEqual({ generation: 1, clearedDirtyDays: 2 });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-2', HASH_B, ['2026-09-13'])),
      ),
    ).resolves.toEqual({ status: 'reserved', deliverySequence: 3 });
  });

  it('drains existing work while blocking a continuous stream of new reservations', async () => {
    await completeOne('delivery-dirty', ['2026-09-12']);
    const active = reservation('delivery-active', HASH_B, ['2026-09-13']);
    const reserved = await withCoordinator((coordinator) => coordinator.reserve(active));

    await expect(
      withCoordinator((coordinator) => coordinator.requestSnapshot({})),
    ).resolves.toEqual({ status: 'draining', activeDeliveries: 1 });
    await expect(withCoordinator((coordinator) => coordinator.reserve(active))).resolves.toEqual({
      status: 'existing',
      deliverySequence: reserved.deliverySequence,
    });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-new', HASH_A, ['2026-09-13'])),
      ),
    ).rejects.toBeInstanceOf(AgentDeliveryCoordinatorRetryableError);
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).rejects.toBeInstanceOf(AgentDeliveryCoordinatorRetryableError);

    await withCoordinator((coordinator) =>
      coordinator.complete({ deliveryId: active.deliveryId, payloadSha256: active.payloadSha256 }),
    );
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: ['2026-09-12', '2026-09-13'],
    });
    await withCoordinator((coordinator) => finishSnapshotCopies(coordinator, 1, CLAIM_ID));
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-new', HASH_A, ['2026-09-13'])),
      ),
    ).resolves.toMatchObject({ status: 'reserved' });
  });

  it('retains dirty days after failure and uses a new generation on retry', async () => {
    await completeOne('delivery-1', ['2026-09-13']);
    expect(
      await withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).toMatchObject({
      generation: 1,
    });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.failSnapshot({ generation: 1, claimId: CLAIM_ID }),
      ),
    ).resolves.toEqual({ generation: 1, retainedDirtyDays: 1 });

    expect(await withCoordinator((coordinator) => coordinator.getStats({}))).toMatchObject({
      activeSnapshotGeneration: null,
      gatePhase: 'open',
      dirtyDays: 1,
      capturedSnapshotDays: 0,
    });
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 2,
      dirtyDays: ['2026-09-13'],
    });
    await expect(
      withCoordinator((coordinator) => finishSnapshotCopies(coordinator, 1, CLAIM_ID)),
    ).rejects.toThrow('snapshot claim is not active');
  });

  it('captures the newest seven days and leaves older work for the next generation', async () => {
    const newestFirst = Array.from({ length: 15 }, (_, index) =>
      new Date(Date.UTC(2026, 8, 13) - index * 86_400_000).toISOString().slice(0, 10),
    );
    await completeOne('delivery-many-days', newestFirst);

    const first = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    expect(first.dirtyDays).toEqual([...newestFirst.slice(0, MAX_AGENT_SNAPSHOT_DAYS)].sort());
    await withCoordinator((coordinator) =>
      finishSnapshotCopies(coordinator, first.generation, CLAIM_ID),
    );
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 15 - MAX_AGENT_SNAPSHOT_DAYS,
      },
    );

    const second = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    expect(second).toEqual({
      generation: first.generation + 1,
      dirtyDays: [
        ...newestFirst.slice(MAX_AGENT_SNAPSHOT_DAYS, MAX_AGENT_SNAPSHOT_DAYS * 2),
      ].sort(),
    });
  });

  it('keeps the dirty set bounded across the full retention window', async () => {
    vi.setSystemTime(new Date('2024-09-13T12:00:00.000Z'));
    const days = Array.from({ length: MAX_AGENT_DIRTY_DAYS }, (_, index) => {
      const day = new Date(Date.UTC(2024, 8, 13) - index * 86_400_000);
      return day.toISOString().slice(0, 10);
    });
    await withCoordinator((coordinator) => {
      for (const [index, day] of days.entries()) {
        const deliveryId = `delivery-${index}`;
        coordinator.reserve(reservation(deliveryId, HASH_A, [day]));
        coordinator.complete({ deliveryId, payloadSha256: HASH_A });
      }
    });
    await completeOne('delivery-repeat', [days[0]!]);

    const stats = await withCoordinator((coordinator) => coordinator.getStats({}));
    expect(stats).toMatchObject({
      activeDeliveries: 0,
      dirtyDays: MAX_AGENT_DIRTY_DAYS,
      lastDeliverySequence: MAX_AGENT_DIRTY_DAYS + 2,
    });
    expect(stats.databaseSizeBytes).toBeGreaterThan(0);

    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('too-old', HASH_A, ['2023-09-12'])),
      ),
    ).rejects.toThrow('outside the retained fact window');
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('future', HASH_A, ['2024-09-14'])),
      ),
    ).rejects.toThrow('outside the retained fact window');

    vi.setSystemTime(new Date('2025-09-14T12:00:00.000Z'));
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 0,
        incompleteDays: 0,
      },
    );
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('next-year', HASH_A, ['2025-09-14'])),
      ),
    ).resolves.toMatchObject({ status: 'reserved' });
  });

  it('expires a delivery only after its explicit retention deadline', async () => {
    const input = reservation('delivery-expiring', HASH_A, ['2026-09-13']);
    await withCoordinator((coordinator) => coordinator.reserve(input));

    await expect(
      withCoordinator((coordinator) =>
        coordinator.expire({ deliveryId: input.deliveryId, payloadSha256: input.payloadSha256 }),
      ),
    ).rejects.toThrow('has not expired');

    vi.setSystemTime(input.expiresAtMs);
    await expect(withCoordinator((coordinator) => coordinator.reserve(input))).resolves.toEqual({
      status: 'existing',
      deliverySequence: 2,
    });
    await expect(
      withCoordinator((coordinator) =>
        coordinator.expire({ deliveryId: input.deliveryId, payloadSha256: input.payloadSha256 }),
      ),
    ).resolves.toEqual({ deliverySequence: 2, dirtyDays: ['2026-09-13'] });
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { activeDeliveries: 0, dirtyDays: 1, incompleteDays: 1 },
    );

    vi.setSystemTime(input.expiresAtMs + 366 * 86_400_000);
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        dirtyDays: 0,
        incompleteDays: 0,
      },
    );
  });

  it('snapshots unaffected days while incomplete days await explicit recovery', async () => {
    await completeOne('delivery-complete', ['2026-09-12']);
    const expiring = reservation('delivery-incomplete', HASH_B, ['2026-09-13']);
    await withCoordinator((coordinator) => coordinator.reserve(expiring));
    vi.setSystemTime(expiring.expiresAtMs);
    await withCoordinator((coordinator) =>
      coordinator.expire({
        deliveryId: expiring.deliveryId,
        payloadSha256: expiring.payloadSha256,
      }),
    );

    await withCoordinator((coordinator) => coordinator.requestSnapshot({}));
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 1,
      dirtyDays: ['2026-09-12'],
    });
    await withCoordinator((coordinator) => finishSnapshotCopies(coordinator, 1, CLAIM_ID));
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { dirtyDays: 1, incompleteDays: 1, gatePhase: 'open' },
    );

    await withCoordinator((coordinator) => coordinator.requestSnapshot({}));
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).rejects.toThrow('no complete dirty days; recovery is required');
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { dirtyDays: 1, incompleteDays: 1, gatePhase: 'open' },
    );

    await expect(
      withCoordinator((coordinator) =>
        coordinator.resolveIncompleteDays({ dirtyDays: ['2026-09-13'] }),
      ),
    ).resolves.toEqual({ resolvedDirtyDays: 1 });
    await expect(
      withCoordinator((coordinator) => coordinator.beginSnapshot({ claimId: CLAIM_ID })),
    ).resolves.toEqual({
      generation: 2,
      dirtyDays: ['2026-09-13'],
    });
  });

  it('rejects retention windows longer than four days before admission', async () => {
    const input = reservation('delivery-too-long', HASH_A, ['2026-09-13']);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve({
          ...input,
          expiresAtMs: input.expiresAtMs + 1,
        }),
      ),
    ).rejects.toThrow('retention exceeds four days');
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { activeDeliveries: 0, lastDeliverySequence: 1 },
    );
  });

  it('resumes an expired snapshot claim without changing its generation or cursor', async () => {
    await completeOne('delivery-dirty', ['2026-09-13']);
    const first = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );
    await expect(
      withCoordinator((coordinator) =>
        coordinator.assertSnapshotActive({ generation: first.generation, claimId: CLAIM_ID }),
      ),
    ).resolves.toEqual({
      generation: first.generation,
      expiresAtMs: Date.now() + MAX_AGENT_SNAPSHOT_LEASE_MS,
    });

    vi.advanceTimersByTime(MAX_AGENT_SNAPSHOT_LEASE_MS);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.assertSnapshotActive({ generation: first.generation, claimId: CLAIM_ID }),
      ),
    ).rejects.toThrow('snapshot claim is not active');
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        gatePhase: 'snapshot',
        activeSnapshotGeneration: first.generation,
        capturedSnapshotDays: 1,
        dirtyDays: 1,
      },
    );
    await expect(
      withCoordinator((coordinator) => coordinator.claimSnapshot({ claimId: 'claim-b' })),
    ).resolves.toMatchObject({
      generation: first.generation,
      dirtyDays: ['2026-09-13'],
      nextCopyIndex: 0,
      claimId: 'claim-b',
    });
  });

  it('abandons a snapshot whose oldest partition ages out before publication', async () => {
    vi.setSystemTime(new Date('2026-09-13T23:58:00.000Z'));
    await completeOne('delivery-oldest', ['2025-09-13']);
    const snapshot = await withCoordinator((coordinator) =>
      coordinator.beginSnapshot({ claimId: CLAIM_ID }),
    );

    vi.advanceTimersByTime(3 * 60 * 1000);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.assertSnapshotActive({ generation: snapshot.generation, claimId: CLAIM_ID }),
      ),
    ).rejects.toThrow('snapshot contains days outside retention');
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        gatePhase: 'snapshot',
        dirtyDays: 1,
        capturedSnapshotDays: 1,
      },
    );
    await withCoordinator((coordinator) =>
      coordinator.failSnapshot({ generation: snapshot.generation, claimId: CLAIM_ID }),
    );
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      { gatePhase: 'open', dirtyDays: 0, capturedSnapshotDays: 0 },
    );
  });

  it('recovers an abandoned draining gate before admitting new work', async () => {
    await completeOne('delivery-dirty', ['2026-09-12']);
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-active', HASH_A, ['2026-09-13'])),
    );
    await withCoordinator((coordinator) => coordinator.requestSnapshot({}));
    vi.advanceTimersByTime(MAX_AGENT_SNAPSHOT_LEASE_MS);

    await expect(
      withCoordinator((coordinator) =>
        coordinator.reserve(reservation('delivery-new', HASH_B, ['2026-09-13'])),
      ),
    ).resolves.toMatchObject({ status: 'reserved' });
    await expect(withCoordinator((coordinator) => coordinator.getStats({}))).resolves.toMatchObject(
      {
        gatePhase: 'open',
        activeDeliveries: 2,
        dirtyDays: 1,
      },
    );
  });

  it('expands dirty days only for the write permit holder and enforces the union cap', async () => {
    vi.setSystemTime(new Date('2024-09-13T12:00:00.000Z'));
    const days = Array.from({ length: MAX_AGENT_DIRTY_DAYS }, (_, index) =>
      new Date(Date.UTC(2024, 8, 13) - index * 86_400_000).toISOString().slice(0, 10),
    );
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-owner', HASH_A, days)),
    );
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation('delivery-waiting', HASH_B, ['2024-09-13'])),
    );

    await expect(
      withCoordinator((coordinator) =>
        coordinator.expandDirtyDays({
          deliveryId: 'delivery-waiting',
          payloadSha256: HASH_B,
          dirtyDays: ['2024-09-12'],
        }),
      ),
    ).rejects.toBeInstanceOf(AgentDeliveryCoordinatorRetryableError);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.expandDirtyDays({
          deliveryId: 'delivery-owner',
          payloadSha256: HASH_A,
          dirtyDays: [days[0]!, days[0]!],
        }),
      ),
    ).resolves.toEqual({ dirtyDays: [...days].sort() });

    vi.advanceTimersByTime(86_400_000);
    await expect(
      withCoordinator((coordinator) =>
        coordinator.expandDirtyDays({
          deliveryId: 'delivery-owner',
          payloadSha256: HASH_A,
          dirtyDays: ['2024-09-14'],
        }),
      ),
    ).rejects.toThrow('dirty day limit reached');
    await expect(
      withCoordinator((coordinator) =>
        coordinator.getReservation({ deliveryId: 'delivery-owner' }),
      ),
    ).resolves.toMatchObject({ dirtyDays: [...days].sort() });
  });

  async function completeOne(deliveryId: string, dirtyDays: string[]): Promise<void> {
    await withCoordinator((coordinator) =>
      coordinator.reserve(reservation(deliveryId, HASH_A, dirtyDays)),
    );
    await withCoordinator((coordinator) =>
      coordinator.complete({ deliveryId, payloadSha256: HASH_A }),
    );
  }
});

function reservation(deliveryId: string, payloadSha256: string, dirtyDays: string[]) {
  return {
    deliveryId,
    payloadSha256,
    dirtyDays,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + MAX_AGENT_DELIVERY_RETENTION_MS,
  };
}
