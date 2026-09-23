import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDeliveryCoordinator,
  type AgentDeliveryCoordinatorInstance,
} from '../agent-delivery-coordinator';
import type { AgentConsumerEnv } from '../context';
import { SNAPSHOT_FIRST_CHECK_MS, readSnapshotCheck } from '../snapshot-checks';
import { AGENT_SNAPSHOT_TARGETS } from '../snapshot-tinybird';

const env = workerEnv as unknown as AgentConsumerEnv;
const START = Date.now() + 24 * 60 * 60_000;
const CLAIM_ID = 'claim-a';
const HASH = 'a'.repeat(64);

describe('durable snapshot checks', () => {
  let host: DurableObjectStub<AgentDeliveryCoordinatorInstance>;
  let orgId: string;
  let generation: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    host = env.AGENT_DELIVERY_COORDINATOR.get(env.AGENT_DELIVERY_COORDINATOR.newUniqueId());
    orgId = crypto.randomUUID();
    await withCoordinator((coordinator) => {
      coordinator.reserve({
        deliveryId: crypto.randomUUID(),
        payloadSha256: HASH,
        dirtyDays: [new Date(START).toISOString().slice(0, 10)],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      });
      const reservation = coordinator.getNextDelivery()!;
      coordinator.complete({ deliveryId: reservation.deliveryId, payloadSha256: HASH });
      generation = coordinator.beginSnapshot({ claimId: CLAIM_ID }).generation;
      coordinator.recordSnapshotCopyIntent({
        generation,
        target: AGENT_SNAPSHOT_TARGETS[0],
        copyAttempt: generation,
        copyIndex: 0,
        claimId: CLAIM_ID,
        startedAt: Date.now(),
      });
    });
  });

  afterEach(() => vi.useRealTimers());

  function withCoordinator<T>(
    callback: (
      coordinator: AgentDeliveryCoordinatorInstance,
      state: DurableObjectState,
    ) => T | Promise<T>,
  ): Promise<T> {
    return runInDurableObject(host, (coordinator, state) => callback(coordinator, state));
  }

  async function state() {
    return withCoordinator((_coordinator, storageHost) => readSnapshotCheck(storageHost.storage));
  }

  async function prepare(recovery: boolean) {
    return withCoordinator((coordinator) =>
      coordinator.prepareSnapshotCheck({
        orgId,
        generation,
        claimId: CLAIM_ID,
        copyIndex: 0,
        recovery,
      }),
    );
  }

  async function advanceToDue() {
    const check = await state();
    expect(check).not.toBeNull();
    await withCoordinator((_coordinator, object) => object.storage.deleteAlarm());
    vi.setSystemTime(check!.nextCheckAtMs);
    await withCoordinator((coordinator) =>
      coordinator.renewSnapshotClaim({ generation, claimId: CLAIM_ID }),
    );
  }

  it('persists the first due time and fences early or duplicate checks', async () => {
    expect(await state()).toMatchObject({
      generation,
      copyIndex: 0,
      nextCheckAtMs: START + SNAPSHOT_FIRST_CHECK_MS,
      statusChecks: 0,
      recoveryChecks: 0,
      blockedReason: null,
    });
    expect((await prepare(false)).ready).toBe(false);
    expect((await state())?.statusChecks).toBe(0);

    await advanceToDue();
    const first = await prepare(false);
    expect(first).toMatchObject({
      ready: true,
      state: { statusChecks: 1, nextCheckAtMs: START + 45_000 },
    });
    expect((await prepare(false)).ready).toBe(false);
    expect((await state())?.statusChecks).toBe(1);
    const reconstructed = await withCoordinator((_coordinator, object) =>
      new AgentDeliveryCoordinator(object, env).getSnapshotSchedule({}),
    );
    expect(reconstructed).toMatchObject({
      check: first.state,
      wakeAtMs: first.state.nextCheckAtMs,
    });

    await advanceToDue();
    expect(await prepare(false)).toMatchObject({
      ready: true,
      state: { statusChecks: 2, nextCheckAtMs: START + 105_000 },
    });
    await advanceToDue();
    expect(await prepare(false)).toMatchObject({
      ready: true,
      state: { statusChecks: 3, nextCheckAtMs: START + 165_000 },
    });
  });

  it('blocks after 15 status checks, stops its alarm, and resumes only after the claim expires', async () => {
    for (let attempt = 1; attempt <= 15; attempt += 1) {
      await advanceToDue();
      expect(await prepare(false)).toMatchObject({
        ready: true,
        state: { statusChecks: attempt, blockedReason: null },
      });
    }
    await advanceToDue();
    expect(await prepare(false)).toMatchObject({
      ready: false,
      state: { statusChecks: 15, blockedReason: 'Snapshot Copy exceeded its status check budget' },
    });
    expect(await withCoordinator((_coordinator, object) => object.storage.getAlarm())).toBeNull();

    await withCoordinator((_coordinator, object) => object.storage.deleteAlarm());
    vi.advanceTimersByTime(5 * 60_000);
    const resumed = await withCoordinator((coordinator) =>
      coordinator.resumeSnapshot({ orgId, generation, reason: 'Operator verified Copy state' }),
    );
    expect(resumed).toMatchObject({
      check: { statusChecks: 0, recoveryChecks: 0, blockedReason: null, nextCheckAtMs: Date.now() },
    });
    expect(await withCoordinator((_coordinator, object) => object.storage.getAlarm())).toBe(
      Date.now() + 1,
    );
  });

  it('blocks after three recovery checks with exponential delays', async () => {
    await withCoordinator((coordinator) =>
      coordinator.requireSnapshotRecovery({ generation, claimId: CLAIM_ID }),
    );
    expect((await state())?.recoveryRequired).toBe(true);

    for (const [attempt, delay] of [60_000, 120_000, 240_000].entries()) {
      await advanceToDue();
      expect(await prepare(true)).toMatchObject({
        ready: true,
        state: { recoveryChecks: attempt + 1, nextCheckAtMs: Date.now() + delay },
      });
    }
    await advanceToDue();
    expect(await prepare(true)).toMatchObject({
      ready: false,
      state: {
        recoveryChecks: 3,
        recoveryRequired: true,
        blockedReason: 'Snapshot Copy receipt could not be recovered',
      },
    });
    expect(await withCoordinator((_coordinator, object) => object.storage.getAlarm())).toBeNull();
  });
});
