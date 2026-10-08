import { env as workerEnv, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

describe('AgentFactBatcher recovery and erasure', () => {
  let batcher: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  });
  afterEach(() => vi.restoreAllMocks());

  it('retires a dead-lettered message without replaying it and keeps its payload', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const payload = JSON.stringify({ messageId: 'dead', body: { orgId: 'org-1' } });
    const dlq = await batcher.preserveDlq(
      payload,
      '{"reason":"dead_letter_queue_delivery"}',
      'dead',
    );
    await runInDurableObject(batcher, (instance) => {
      expect(() =>
        instance.reconcileRecovery({
          recoveryId: dlq.id,
          action: 'retain-original',
          reason: 'DLQ messages are not repairs',
        }),
      ).toThrow('dlq recovery records allow retire-dead-letter');
      expect(() =>
        instance.reconcileRecovery({
          recoveryId: dlq.id,
          action: 'retire-dead-letter',
          reason: '   ',
        }),
      ).toThrow('recovery reason is required');
    });

    const resolved = await batcher.reconcileRecovery({
      recoveryId: dlq.id,
      action: 'retire-dead-letter',
      reason: 'operator chose not to replay',
    });
    expect(resolved).toMatchObject({
      state: 'resolved',
      resolution: 'retire-dead-letter',
      payload,
    });
    expect((await batcher.listRecovery()).records).toEqual([]);
    expect((await batcher.listRecovery({ state: 'resolved' })).records).toEqual([resolved]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['confirm-written', 'confirm-not-written'] as const)(
    'rejects %s reconciliation for retained tinybird_insert records',
    async (action) => {
      const recoveryId = await runInDurableObject(batcher, (_instance, state) => {
        const recovery = new TinybirdRecoveryStore(state.storage);
        return recovery.preserveInsert(
          'facts',
          'messages',
          '[{"preserved":true}]',
          [7],
          'uncertain',
          '{"reason":"unknown"}',
        );
      });
      await runInDurableObject(batcher, (instance) => {
        expect(() =>
          instance.reconcileRecovery({
            recoveryId,
            action,
            reason: 'operator verified the write outcome',
          }),
        ).toThrow('the retired fact ledger no longer flushes');
      });
      expect((await batcher.listRecovery()).records).toMatchObject([
        { id: recoveryId, kind: 'tinybird_insert', state: 'blocked', resolution: null },
      ]);
    },
  );

  it('resolves retained repair records without rewriting their payloads', async () => {
    const repair = await runInDurableObject(batcher, (_instance, state) => {
      const recovery = new TinybirdRecoveryStore(state.storage);
      return recovery.preserveRepair('{"original":true}', '{"reason":"changed"}', 'repair');
    });
    const resolved = await batcher.reconcileRecovery({
      recoveryId: repair.id,
      action: 'retain-original',
      reason: 'operator retained the original fact',
    });
    expect(resolved).toMatchObject({
      state: 'resolved',
      resolution: 'retain-original',
      payload: repair.payload,
      outcome: repair.outcome,
    });
  });

  it('recovers interrupted insert records on startup and preserves retired storage', async () => {
    const recoveryId = await runInDurableObject(batcher, async (_instance, state) => {
      await state.storage.put('retired_fact_state', { preserved: true });
      state.storage.sql.exec('CREATE TABLE retired_ledger_fixture (data TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO retired_ledger_fixture VALUES (?)', 'preserved');
      const recovery = new TinybirdRecoveryStore(state.storage);
      return recovery.beginInsert('facts', 'messages', '[{"original":true}]', [7]);
    });
    await evictDurableObject(batcher);
    expect((await batcher.listRecovery()).records).toMatchObject([
      {
        id: recoveryId,
        kind: 'tinybird_insert',
        state: 'blocked',
        classification: 'uncertain',
        payload: '[{"original":true}]',
        outcome: '{"reason":"worker_restarted_with_in_flight_insert"}',
      },
    ]);
    await runInDurableObject(batcher, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.get('retired_fact_state')).toEqual({ preserved: true });
      expect(state.storage.sql.exec('SELECT data FROM retired_ledger_fixture').toArray()).toEqual([
        { data: 'preserved' },
      ]);
    });
  });

  it('fences writes before erasing and keeps only a permanent tombstone across new instances', async () => {
    await batcher.preserveDlq('{"preserved":true}', '{}', 'erase');
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await state.storage.put('retired_fact_state', { preserved: true });
      const deleteAlarm = state.storage.deleteAlarm.bind(state.storage);
      const fence = vi.spyOn(state.storage, 'deleteAlarm').mockImplementationOnce(async () => {
        expect(await state.storage.get('organization_erasure')).toEqual({ state: 'pending' });
        expect(() => instance.listRecovery()).toThrow('Organization erasure has started');
        expect(() => instance.preserveDlq('{}', '{}', 'blocked')).toThrow(
          'Organization erasure has started',
        );
        await deleteAlarm();
      });
      try {
        await expect(instance.eraseOrganizationData()).resolves.toEqual({ erased: true });
        expect(fence).toHaveBeenCalledOnce();
      } finally {
        fence.mockRestore();
      }
      expect(await state.storage.list()).toEqual(
        new Map([['organization_erasure', { state: 'erased' }]]),
      );
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_records'")
          .toArray(),
      ).toEqual([]);
      await expect(instance.eraseOrganizationData()).resolves.toEqual({ erased: true });
    });

    await evictDurableObject(batcher);
    await runInDurableObject(batcher, (instance) => {
      expect(() => instance.listRecovery()).toThrow('Organization erasure has started');
      expect(() => instance.preserveDlq('{}', '{}', 'blocked')).toThrow(
        'Organization erasure has started',
      );
    });
    await runInDurableObject(batcher, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(
        new Map([['organization_erasure', { state: 'erased' }]]),
      );
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_records'")
          .toArray(),
      ).toEqual([]);
    });
  });

  it('reloads the pending erasure fence and finishes deletion after a restart', async () => {
    await runInDurableObject(batcher, async (_instance, state) => {
      await state.storage.put('organization_erasure', { state: 'pending' });
      await state.storage.put('retired_fact_state', { preserved: true });
    });
    await evictDurableObject(batcher);
    await runInDurableObject(batcher, (instance) => {
      expect(() => instance.listRecovery()).toThrow('Organization erasure has started');
      expect(() => instance.preserveDlq('{}', '{}', 'blocked')).toThrow(
        'Organization erasure has started',
      );
    });
    await expect(batcher.eraseOrganizationData()).resolves.toEqual({ erased: true });
    await runInDurableObject(batcher, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(
        new Map([['organization_erasure', { state: 'erased' }]]),
      );
    });
  });
});
