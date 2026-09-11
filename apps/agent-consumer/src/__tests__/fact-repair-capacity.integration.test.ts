import { env as workerEnv } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { expect, it, vi } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { FactRepairCapacity } from '../fact-repair-capacity';
import { factIngestedAtMs, rowIdentity, stableHash } from '../facts';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

const original = {
  OrgId: 'org-1',
  session_pk: 'session-1',
  message_pk: 'message-1',
  EventAt: '2024-01-01 00:00:00.000',
  IngestedAt: '2024-01-01 00:00:00.000',
  content: 'original',
};

const changed = {
  ...original,
  IngestedAt: '2024-01-01 01:00:00.000',
  content: 'changed',
};

it('keeps read-only capacity inspection available when restart recovery cannot write', async () => {
  const id = env.AGENT_FACT_BATCHER.newUniqueId();
  const batcher = env.AGENT_FACT_BATCHER.get(id);
  await runInDurableObject(batcher, async (_instance: AgentFactBatcherInstance, state) => {
    seedRepair(state.storage, changed, original);
    state.storage.sql.exec(
      `INSERT INTO pending_facts
       (category, data, created_at_ms, sent_at_ms, fact_id, content_hash)
       VALUES ('messages', '{}', 0, NULL, 'pending-id', 'pending-hash')`,
    );
    state.storage.sql.exec(
      `INSERT INTO recovery_records
       (kind, state, classification, target, target_key, payload, outcome, created_at_ms)
       VALUES ('tinybird_insert', 'in_flight', NULL, 'target', 'pending_facts:messages', '', '', 0)`,
    );
    state.storage.sql.exec(
      `CREATE TRIGGER fail_restart_recovery BEFORE UPDATE OF state ON recovery_records
       WHEN OLD.state = 'in_flight'
       BEGIN SELECT RAISE(ABORT, 'Exceeded the maximum database size.'); END`,
    );
    await state.storage.deleteAlarm();
  });
  await evictDurableObject(batcher);

  const restarted = env.AGENT_FACT_BATCHER.get(id);
  const inspection = await restarted.inspectFactRepairCapacity('org-1', { limit: 10 });
  expect(inspection.startupBlockedReason).toContain('Exceeded the maximum database size.');
  expect(inspection.queuedRows).toBe(1);
  expect(inspection.alarmScheduledAtMs).toBeNull();
  expect(inspection.candidates).toHaveLength(1);
  await runInDurableObject(restarted, async (_instance: AgentFactBatcherInstance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    expect(
      state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM recovery_records WHERE kind = 'tinybird_insert'`)
        .one().state,
    ).toBe('in_flight');
    state.storage.sql.exec('DROP TRIGGER fail_restart_recovery');
  });

  const expectedAlarmScheduledAtMs = Date.now() + 60_000;
  const rowsBefore = await runInDurableObject(
    restarted,
    async (_instance: AgentFactBatcherInstance, state) => {
      await state.storage.setAlarm(expectedAlarmScheduledAtMs);
      return readCapacityRows(state.storage);
    },
  );
  await runInDurableObject(restarted, async (instance: AgentFactBatcherInstance) => {
    await expect(
      instance.quiesceFactRepairCapacity({
        expectedAlarmScheduledAtMs,
        reason: '',
      }),
    ).rejects.toThrow('recovery reason is required');
    await expect(
      instance.quiesceFactRepairCapacity({
        expectedAlarmScheduledAtMs: expectedAlarmScheduledAtMs + 1,
        reason: 'clear the exact reviewed capacity alarm',
      }),
    ).rejects.toThrow('scheduled repair alarm does not match');
  });
  const quiesced = await restarted.quiesceFactRepairCapacity({
    expectedAlarmScheduledAtMs,
    reason: 'clear the exact reviewed capacity alarm',
  });
  expect(quiesced).toEqual(
    expect.objectContaining({
      alarmScheduledAtMs: null,
      clearedAlarmScheduledAtMs: expectedAlarmScheduledAtMs,
      queuedRows: 1,
    }),
  );
  const afterQuiescence = await restarted.inspectFactRepairCapacity('org-1', { limit: 10 });
  expect(afterQuiescence.startupBlockedReason).toContain('Exceeded the maximum database size.');
  expect(afterQuiescence.alarmScheduledAtMs).toBeNull();
  await runInDurableObject(restarted, async (_instance: AgentFactBatcherInstance, state) => {
    expect(readCapacityRows(state.storage)).toEqual(rowsBefore);
    expect(
      state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM recovery_records WHERE kind = 'tinybird_insert'`)
        .one().state,
    ).toBe('in_flight');
  });

  const compacted = await restarted.compactFactRepairDuplicates('org-1', {
    reason: 'free capacity after exact duplicate verification',
    candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
      repairId,
      proofSha256,
    })),
  });
  expect(compacted.startupBlockedReason).toContain('Exceeded the maximum database size.');
  expect(compacted.compacted).toHaveLength(1);
  await runInDurableObject(restarted, async (_instance: AgentFactBatcherInstance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    expect(
      state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM recovery_records WHERE kind = 'tinybird_insert'`)
        .one().state,
    ).toBe('in_flight');
  });

  await runInDurableObject(restarted, async (instance: AgentFactBatcherInstance, state) => {
    const getAlarm = vi.spyOn(state.storage, 'getAlarm').mockResolvedValue(null);
    const setAlarm = vi
      .spyOn(state.storage, 'setAlarm')
      .mockRejectedValueOnce(new Error('alarm storage unavailable'));
    try {
      instance.getStats();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setAlarm).toHaveBeenCalledTimes(1);
    } finally {
      getAlarm.mockRestore();
      setAlarm.mockRestore();
    }
  });
  const failedSchedule = await restarted.inspectFactRepairCapacity('org-1', { limit: 1 });
  expect(failedSchedule.startupBlockedReason).toBe('alarm storage unavailable');
  expect(failedSchedule.alarmScheduledAtMs).toBeNull();
  await runInDurableObject(restarted, async (_instance: AgentFactBatcherInstance, state) => {
    state.storage.sql.exec(
      `INSERT INTO recovery_records
       (kind, state, classification, target, target_key, payload, outcome, created_at_ms)
       VALUES ('tinybird_insert', 'in_flight', NULL, 'active-target',
         'pending_facts:messages', '', '', 1)`,
    );
  });

  await restarted.getStats();
  const recoveredInspection = await restarted.inspectFactRepairCapacity('org-1', { limit: 1 });
  expect(recoveredInspection.startupBlockedReason).toBeNull();
  expect(recoveredInspection.alarmScheduledAtMs).not.toBeNull();
  await runInDurableObject(restarted, async (_instance: AgentFactBatcherInstance, state) => {
    expect(
      state.storage.sql
        .exec<{
          state: string;
        }>(`SELECT state FROM recovery_records WHERE target = 'active-target'`)
        .one().state,
    ).toBe('in_flight');
  });
});

it('checks active flushes around alarm removal and preserves restart compaction fences', async () => {
  const id = env.AGENT_FACT_BATCHER.newUniqueId();
  const batcher = env.AGENT_FACT_BATCHER.get(id);
  const expectedAlarmScheduledAtMs = Date.now() + 60_000;
  const inspection = await runInDurableObject(
    batcher,
    async (instance: AgentFactBatcherInstance, state) => {
      seedRepair(state.storage, changed, original);
      state.storage.sql.exec(
        `INSERT INTO pending_facts
         (category, data, created_at_ms, sent_at_ms, fact_id, content_hash)
         VALUES ('messages', '{}', 0, NULL, 'pending-id', 'pending-hash')`,
      );
      await state.storage.setAlarm(expectedAlarmScheduledAtMs);
      const batcherState = instance as unknown as { flushInProgress: boolean };
      batcherState.flushInProgress = true;
      await expect(
        instance.quiesceFactRepairCapacity({
          expectedAlarmScheduledAtMs,
          reason: 'reject an active capacity flush',
        }),
      ).rejects.toThrow('fact repair quiescence requires no active flush');
      batcherState.flushInProgress = false;
      const getAlarm = vi.spyOn(state.storage, 'getAlarm').mockImplementationOnce(async () => {
        batcherState.flushInProgress = true;
        return expectedAlarmScheduledAtMs;
      });
      try {
        await expect(
          instance.quiesceFactRepairCapacity({
            expectedAlarmScheduledAtMs,
            reason: 'reject a capacity flush that starts before removal',
          }),
        ).rejects.toThrow('fact repair flush started before alarm removal');
      } finally {
        getAlarm.mockRestore();
        batcherState.flushInProgress = false;
      }
      const maintenance = (instance as unknown as { maintenance: { assertUnlocked(): void } })
        .maintenance;
      const lockBeforeDelete = vi
        .spyOn(maintenance, 'assertUnlocked')
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('fact maintenance is locked');
        });
      await expect(
        instance.quiesceFactRepairCapacity({
          expectedAlarmScheduledAtMs,
          reason: 'detect a rebuild lock before alarm removal',
        }),
      ).rejects.toThrow('fact maintenance is locked');
      lockBeforeDelete.mockRestore();
      const deleteAlarm = vi
        .spyOn(state.storage, 'deleteAlarm')
        .mockImplementationOnce(async () => {
          deleteAlarm.mockRestore();
          await state.storage.deleteAlarm();
          batcherState.flushInProgress = true;
        });
      await expect(
        instance.quiesceFactRepairCapacity({
          expectedAlarmScheduledAtMs,
          reason: 'detect a capacity flush after alarm removal',
        }),
      ).rejects.toThrow('fact repair batcher did not become quiescent');
      batcherState.flushInProgress = false;
      await state.storage.setAlarm(expectedAlarmScheduledAtMs);
      const lockAfterDelete = vi
        .spyOn(maintenance, 'assertUnlocked')
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw new Error('fact maintenance is locked');
        });
      await expect(
        instance.quiesceFactRepairCapacity({
          expectedAlarmScheduledAtMs,
          reason: 'detect a rebuild lock after alarm removal',
        }),
      ).rejects.toThrow('fact maintenance is locked');
      lockAfterDelete.mockRestore();
      await state.storage.setAlarm(expectedAlarmScheduledAtMs);
      const proof = await instance.inspectFactRepairCapacity('org-1', { limit: 1 });
      await instance.quiesceFactRepairCapacity({
        expectedAlarmScheduledAtMs,
        reason: 'clear the exact reviewed capacity alarm',
      });
      return proof;
    },
  );
  await evictDurableObject(batcher);

  const restarted = env.AGENT_FACT_BATCHER.get(id);
  const restartedInspection = await restarted.inspectFactRepairCapacity('org-1', { limit: 1 });
  expect(restartedInspection.alarmScheduledAtMs).not.toBeNull();
  await runInDurableObject(restarted, async (instance: AgentFactBatcherInstance) => {
    await expect(
      instance.compactFactRepairDuplicates('org-1', {
        reason: 'must remain blocked after restart reschedules pending work',
        candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
          repairId,
          proofSha256,
        })),
      }),
    ).rejects.toThrow('fact repair compaction requires a quiescent batcher');
  });
});

it('inspects exact duplicate repair payloads without mutating recovery or alarms', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  const result = await runInDurableObject(
    batcher,
    async (instance: AgentFactBatcherInstance, state) => {
      const seeded = seedRepair(state.storage, changed, original);
      state.storage.sql.exec(
        `INSERT INTO fact_repairs
         (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
         VALUES ('messages', 'legacy', 'old', 'new', 0, '{"legacy":true}', NULL)`,
      );
      state.storage.sql.exec(
        `INSERT INTO pending_facts
         (category, data, created_at_ms, sent_at_ms, fact_id, content_hash)
         VALUES ('messages', '{}', 0, NULL, 'pending-id', 'pending-hash')`,
      );
      state.storage.sql.exec(
        `INSERT INTO recovery_records
         (kind, state, classification, target, target_key, payload, outcome, created_at_ms)
         VALUES ('tinybird_insert', 'in_flight', NULL, 'target', 'pending_facts:messages', '', '', 0)`,
      );
      await state.storage.deleteAlarm();
      const beforeChanges = state.storage.sql
        .exec<{ changes: number }>('SELECT total_changes() AS changes')
        .one().changes;
      const inspection = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
      const afterChanges = state.storage.sql
        .exec<{ changes: number }>('SELECT total_changes() AS changes')
        .one().changes;
      return {
        afterChanges,
        alarm: await state.storage.getAlarm(),
        beforeChanges,
        inspection,
        recoveryState: state.storage.sql
          .exec<{
            state: string;
          }>(`SELECT state FROM recovery_records WHERE kind = 'tinybird_insert'`)
          .one().state,
        seeded,
      };
    },
  );

  expect(result.afterChanges).toBe(result.beforeChanges);
  expect(result.alarm).toBeNull();
  expect(result.recoveryState).toBe('in_flight');
  expect(result.inspection.candidates).toEqual([
    expect.objectContaining({
      repairId: result.seeded.repairId,
      recoveryId: result.seeded.recoveryId,
      dataBytes: new TextEncoder().encode(JSON.stringify(changed)).byteLength,
    }),
  ]);
  expect(result.inspection.databaseSizeBytes).toBeGreaterThan(0);
  expect(result.inspection.queuedRows).toBe(1);
  expect(result.inspection.alarmScheduledAtMs).toBeNull();
  expect(result.inspection.highestRepairId).toBeGreaterThanOrEqual(result.seeded.repairId);
  expect(result.inspection.legacyRows).toBe(1);
  expect(result.inspection.issues).toEqual([]);
  expect(
    await runInDurableObject(
      batcher,
      (_instance: AgentFactBatcherInstance, state) =>
        state.storage.sql
          .exec<{ data: string }>("SELECT data FROM fact_repairs WHERE fact_id = 'legacy'")
          .one().data,
    ),
  ).toBe('{"legacy":true}');
});

it('compacts a bounded batch with explicit partial success and transaction rollback', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    const first = seedRepair(state.storage, { ...changed, message_pk: 'message-1' }, original);
    const second = seedRepair(
      state.storage,
      { ...changed, message_pk: 'message-2' },
      { ...original, message_pk: 'message-2' },
    );
    const third = seedRepair(
      state.storage,
      { ...changed, message_pk: 'message-3' },
      { ...original, message_pk: 'message-3' },
    );
    const inspection = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
    state.storage.sql.exec(
      `CREATE TRIGGER fail_fact_repair_reinsert BEFORE INSERT ON fact_repairs
       WHEN NEW.id = ${second.repairId}
       BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL simulated after delete'); END`,
    );
    const result = await instance.compactFactRepairDuplicates('org-1', {
      reason: 'verified duplicate payloads',
      candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
        repairId,
        proofSha256,
      })),
    });
    const rows = state.storage.sql
      .exec<{ id: number; data: string | null }>('SELECT id, data FROM fact_repairs ORDER BY id')
      .toArray();

    expect(result.compacted.map(({ repairId }) => repairId)).toEqual([first.repairId]);
    expect(result.failure).toMatchObject({ repairId: second.repairId });
    expect(result.failure?.reason).toContain('SQLITE_FULL simulated after delete');
    expect(result.remainingRepairIds).toEqual([third.repairId]);
    expect(rows).toEqual([
      { id: first.repairId, data: null },
      { id: second.repairId, data: second.payload },
      { id: third.repairId, data: third.payload },
    ]);
    expect(readRepairMetadata(state.storage, second.repairId)).toEqual(second.metadata);
    expect(readRecovery(state.storage, second.recoveryId)).toMatchObject({
      payload: second.payload,
      outcome: second.outcome,
    });
    const firstProof = inspection.candidates.find(
      ({ repairId }) => repairId === first.repairId,
    )!.proofSha256;
    const readback = await instance.inspectFactRepairCapacity('org-1', {
      afterRepairId: first.repairId - 1,
      limit: 1,
    });
    expect(readback.candidates).toEqual([]);
    expect(readback.compactedRepairs).toEqual([
      expect.objectContaining({ repairId: first.repairId, proofSha256: firstProof }),
    ]);
  });
});

it('rejects stale proofs and reports non-duplicate rows without changing them', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    const seeded = seedRepair(state.storage, changed, original);
    const inspection = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
    const candidate = inspection.candidates[0]!;
    const wrongOrganization = await instance.inspectFactRepairCapacity('org-2', { limit: 10 });
    expect(wrongOrganization.candidates).toEqual([]);
    expect(wrongOrganization.issues).toEqual([
      {
        repairId: seeded.repairId,
        reason: 'repair outcome or current payload metadata differs',
      },
    ]);
    state.storage.sql.exec(
      'UPDATE fact_repairs SET seen_at_ms = seen_at_ms + 1 WHERE id = ?',
      seeded.repairId,
    );
    const stale = await instance.compactFactRepairDuplicates('org-1', {
      reason: 'stale proof test',
      candidates: [candidate],
    });
    expect(stale.compacted).toEqual([]);
    expect(stale.failure).toEqual({
      repairId: seeded.repairId,
      reason: 'fact repair compaction proof is stale',
    });
    expect(readRepairData(state.storage, seeded.repairId)).toBe(seeded.payload);

    state.storage.sql.exec(
      `UPDATE recovery_payload_chunks SET data = '{"different":true}' WHERE recovery_id = ?`,
      seeded.recoveryId,
    );
    const mismatch = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
    expect(mismatch.candidates).toEqual([]);
    expect(mismatch.issues).toEqual([
      {
        repairId: seeded.repairId,
        reason: 'recovery payload differs from inline payload',
      },
    ]);
    expect(readRepairData(state.storage, seeded.repairId)).toBe(seeded.payload);
  });
});

it('rechecks the maintenance gate after asynchronous proof generation', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (_instance: AgentFactBatcherInstance, state) => {
    const seeded = seedRepair(state.storage, changed, original);
    const recovery = new TinybirdRecoveryStore(state.storage);
    const inspectionCapacity = new FactRepairCapacity(state.storage, recovery, () => {});
    const inspection = await inspectionCapacity.inspect('org-1', { limit: 10 }, null);
    const mutationCapacity = new FactRepairCapacity(state.storage, recovery, () => {
      throw new Error('fact maintenance is locked');
    });

    const result = await mutationCapacity.compact('org-1', {
      reason: 'maintenance gate regression',
      candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
        repairId,
        proofSha256,
      })),
    });

    expect(result.compacted).toEqual([]);
    expect(result.failure).toEqual({
      repairId: seeded.repairId,
      reason: 'fact maintenance is locked',
    });
    expect(readRepairData(state.storage, seeded.repairId)).toBe(seeded.payload);
    expect(readRecovery(state.storage, seeded.recoveryId)).toMatchObject({
      payload: seeded.payload,
      outcome: seeded.outcome,
    });
  });
});

it('refuses compaction while a flush alarm is scheduled', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    const seeded = seedRepair(state.storage, changed, original);
    const inspection = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
    await state.storage.setAlarm(Date.now() + 60_000);

    await expect(
      instance.compactFactRepairDuplicates('org-1', {
        reason: 'scheduled alarm regression',
        candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
          repairId,
          proofSha256,
        })),
      }),
    ).rejects.toThrow('fact repair compaction requires no scheduled flush alarm');
    expect(readRepairData(state.storage, seeded.repairId)).toBe(seeded.payload);
  });
});

it('reports duplicate recovery keys per row and continues to later candidates', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    const duplicate = seedRepair(state.storage, changed, original);
    state.storage.sql.exec(
      `INSERT INTO recovery_records
       (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
       SELECT kind, state, classification, target, target_key, dedupe_key, payload, outcome,
              created_at_ms
       FROM recovery_records WHERE id = ?`,
      duplicate.recoveryId,
    );
    const valid = seedRepair(
      state.storage,
      { ...changed, message_pk: 'message-valid' },
      { ...original, message_pk: 'message-valid' },
    );

    const page = await instance.inspectFactRepairCapacity('org-1', { limit: 10 });
    expect(page.issues).toEqual([
      {
        repairId: duplicate.repairId,
        reason: 'repair recovery dedupe key is not unique',
      },
    ]);
    expect(page.candidates.map(({ repairId }) => repairId)).toEqual([valid.repairId]);
    expect(page.nextAfterRepairId).toBeNull();
    expect(readRepairData(state.storage, duplicate.repairId)).toBe(duplicate.payload);
    expect(readRepairData(state.storage, valid.repairId)).toBe(valid.payload);
  });
});

it('bounds inspection by reconstructed recovery bytes while allowing one oversized row', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    for (let index = 0; index < 3; index++) {
      seedRepair(
        state.storage,
        { ...changed, message_pk: `message-${index}` },
        { ...original, message_pk: `message-${index}`, content: 'x'.repeat(4_500_000) },
      );
    }
    const first = await instance.inspectFactRepairCapacity('org-1', { limit: 25 });
    expect(first.scannedRows).toBe(1);
    expect(first.inspectedPayloadBytes).toBeGreaterThan(4_000_000);
    expect(first.nextAfterRepairId).toBe(first.candidates[0]?.repairId);
    const second = await instance.inspectFactRepairCapacity('org-1', {
      afterRepairId: first.nextAfterRepairId!,
      limit: 25,
    });
    expect(second.scannedRows).toBe(1);
    expect(second.nextAfterRepairId).toBe(second.candidates[0]?.repairId);
    const third = await instance.inspectFactRepairCapacity('org-1', {
      afterRepairId: second.nextAfterRepairId!,
      limit: 25,
    });
    const allCandidates = [...first.candidates, ...second.candidates, ...third.candidates];
    const compacted = await instance.compactFactRepairDuplicates('org-1', {
      reason: 'bounded oversized batch',
      candidates: allCandidates.map(({ repairId, proofSha256 }) => ({
        repairId,
        proofSha256,
      })),
    });
    expect(compacted.compacted.map(({ repairId }) => repairId)).toEqual([
      first.candidates[0]?.repairId,
    ]);
    expect(compacted.failure).toBeNull();
    expect(compacted.remainingRepairIds).toEqual([
      second.candidates[0]?.repairId,
      third.candidates[0]?.repairId,
    ]);
    expect(readRepairData(state.storage, first.candidates[0]!.repairId)).toBeNull();
    expect(readRepairData(state.storage, second.candidates[0]!.repairId)).not.toBeNull();
  });
});

it('keeps each production inspection page independent of total repair row count', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (_instance: AgentFactBatcherInstance, state) => {
    state.storage.sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 10000
      )
      INSERT INTO fact_repairs
        (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
      SELECT 'messages', 'legacy-' || n, 'old', 'new', 0, '', NULL FROM rows
    `);
    const cursors: { readonly rowsRead: number }[] = [];
    const measuredSql = new Proxy(state.storage.sql, {
      get(target, property) {
        if (property === 'exec') {
          const exec = target.exec.bind(target);
          return (query: string, ...bindings: unknown[]) => {
            const cursor = exec(query, ...bindings);
            cursors.push(cursor);
            return cursor;
          };
        }
        return Reflect.get(target, property, target);
      },
    });
    const measuredStorage: DurableObjectStorage = new Proxy(state.storage, {
      get(target, property) {
        if (property === 'sql') return measuredSql;
        return Reflect.get(target, property, target);
      },
    });
    const capacity = new FactRepairCapacity(
      measuredStorage,
      new TinybirdRecoveryStore(measuredStorage),
      () => {},
    );
    const page = await capacity.inspect('org-1', { afterRepairId: 5000, limit: 25 }, null);
    expect(page.scannedRows).toBe(25);
    expect(page.highestRepairId).toBe(10000);
    expect(cursors.reduce((total, cursor) => total + cursor.rowsRead, 0)).toBeLessThan(100);
  });
});

it('retains the inline copy when recovery preservation fails and compacts it on retry', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    const originalPayload = JSON.stringify(original);
    state.storage.sql.exec(
      `INSERT INTO fact_ledger
       (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
       VALUES ('messages', ?, ?, 0, ?, 1, 0)`,
      rowIdentity(original, ['OrgId', 'session_pk', 'message_pk']),
      stableHash(original),
      originalPayload,
    );
    state.storage.sql.exec(
      `CREATE TRIGGER fail_repair_recovery BEFORE INSERT ON recovery_records
       WHEN NEW.kind = 'repair'
       BEGIN SELECT RAISE(ABORT, 'repair recovery unavailable'); END`,
    );
    const failed = await instance.addFacts({ rows: emptyRows(changed) });
    expect(failed.status).toBe('failed');
    const repairId = state.storage.sql.exec<{ id: number }>('SELECT id FROM fact_repairs').one().id;
    expect(readRepairData(state.storage, repairId)).toBe(JSON.stringify(changed));

    state.storage.sql.exec('DROP TRIGGER fail_repair_recovery');
    state.storage.sql.exec(
      `CREATE TRIGGER fail_automatic_compaction BEFORE INSERT ON fact_repairs
       WHEN NEW.id = ${repairId}
       BEGIN SELECT RAISE(ABORT, 'automatic compaction unavailable'); END`,
    );
    const retried = await instance.addFacts({ rows: emptyRows(changed) });
    expect(retried.status).toBe('accepted');
    expect(readRepairData(state.storage, repairId)).toBe(JSON.stringify(changed));

    state.storage.sql.exec('DROP TRIGGER fail_automatic_compaction');
    const compacted = await instance.addFacts({ rows: emptyRows(changed) });
    expect(compacted.status).toBe('accepted');
    expect(readRepairData(state.storage, repairId)).toBeNull();
    const recovery = new TinybirdRecoveryStore(state.storage).repairByDedupeKey(
      repairDedupeKey(changed, original),
    );
    expect(recovery).toMatchObject({
      payload: JSON.stringify(changed),
      outcome: expect.any(String),
    });
  });
});

function seedRepair(
  storage: DurableObjectStorage,
  current: typeof changed,
  previous: typeof original,
) {
  const category = 'messages';
  const payload = JSON.stringify(current);
  const factId = rowIdentity(current, ['OrgId', 'session_pk', 'message_pk']);
  const oldHash = stableHash(previous);
  const newHash = stableHash(current);
  const dedupeKey = repairDedupeKey(current, previous);
  const seenAtMs = 123;
  storage.sql.exec(
    `INSERT INTO fact_repairs
     (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    category,
    factId,
    oldHash,
    newHash,
    seenAtMs,
    payload,
    dedupeKey,
  );
  const repairId = storage.sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id;
  const outcome = JSON.stringify({
    category,
    factId,
    oldHash,
    newHash,
    originalPayload: JSON.stringify(previous),
  });
  const recovery = new TinybirdRecoveryStore(storage).preserveRepair(payload, outcome, dedupeKey);
  return {
    repairId,
    recoveryId: recovery.id,
    payload,
    outcome,
    metadata: { category, factId, oldHash, newHash, seenAtMs, dedupeKey },
  };
}

function repairDedupeKey(current: typeof changed, previous: typeof original): string {
  return JSON.stringify([
    'messages',
    rowIdentity(current, ['OrgId', 'session_pk', 'message_pk']),
    stableHash(previous),
    stableHash(current),
    factIngestedAtMs(current),
  ]);
}

function readRepairData(storage: DurableObjectStorage, repairId: number): string | null {
  return storage.sql
    .exec<{ data: string | null }>('SELECT data FROM fact_repairs WHERE id = ?', repairId)
    .one().data;
}

function readRepairMetadata(storage: DurableObjectStorage, repairId: number) {
  const row = storage.sql
    .exec<{
      category: string;
      fact_id: string;
      old_hash: string;
      new_hash: string;
      seen_at_ms: number;
      recovery_dedupe_key: string;
    }>(
      `SELECT category, fact_id, old_hash, new_hash, seen_at_ms, recovery_dedupe_key
       FROM fact_repairs WHERE id = ?`,
      repairId,
    )
    .one();
  return {
    category: row.category,
    factId: row.fact_id,
    oldHash: row.old_hash,
    newHash: row.new_hash,
    seenAtMs: row.seen_at_ms,
    dedupeKey: row.recovery_dedupe_key,
  };
}

function readRecovery(storage: DurableObjectStorage, recoveryId: number) {
  return new TinybirdRecoveryStore(storage).get(recoveryId);
}

function readCapacityRows(storage: DurableObjectStorage) {
  return {
    repairs: [
      ...storage.sql.exec(
        `SELECT id, category, fact_id, old_hash, new_hash, seen_at_ms, data,
                recovery_dedupe_key
         FROM fact_repairs ORDER BY id`,
      ),
    ],
    pending: [
      ...storage.sql.exec(
        `SELECT id, category, data, created_at_ms, sent_at_ms, fact_id, content_hash
         FROM pending_facts ORDER BY id`,
      ),
    ],
    recovery: [
      ...storage.sql.exec(
        `SELECT id, kind, state, classification, target, target_key, dedupe_key,
                payload, outcome, created_at_ms, resolved_at_ms, resolution,
                resolution_reason
         FROM recovery_records ORDER BY id`,
      ),
    ],
  };
}

function emptyRows(message: typeof original) {
  return {
    messages: [message],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
    review_unit_attributions: [],
  };
}
