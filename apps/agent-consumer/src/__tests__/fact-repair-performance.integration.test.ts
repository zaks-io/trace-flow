import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { expect, it, vi } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { FactRepairProof, type StoredFactRepair } from '../fact-repair-proof';
import { factIngestedAtMs, rowIdentity, stableHash } from '../facts';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

interface TestMessage {
  OrgId: string;
  session_pk: string;
  message_pk: string;
  EventAt: string;
  IngestedAt: string;
  content: string;
}

it('reuses the loaded chunked recovery while preserving compacted proof validation', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (_instance: AgentFactBatcherInstance, state) => {
    const seeded = seedRepair(
      state.storage,
      message('message-chunked', `current-${'c'.repeat(900_000)}`, 1),
      message('message-chunked', `original-${'o'.repeat(900_000)}`, 0),
    );
    state.storage.sql.exec('UPDATE fact_repairs SET data = NULL WHERE id = ?', seeded.repairId);
    const chunks = state.storage.sql
      .exec<{ payload: number; outcome: number }>(
        `SELECT
           (SELECT COUNT(*) FROM recovery_payload_chunks WHERE recovery_id = ?) AS payload,
           (SELECT COUNT(*) FROM recovery_outcome_chunks WHERE recovery_id = ?) AS outcome`,
        seeded.recoveryId,
        seeded.recoveryId,
      )
      .one();
    expect(chunks.payload).toBeGreaterThan(1);
    expect(chunks.outcome).toBeGreaterThan(1);

    const recoveryRecordQueries: string[] = [];
    const measuredSql = new Proxy(state.storage.sql, {
      get(target, property) {
        if (property === 'exec') {
          const exec = target.exec.bind(target);
          return (query: string, ...bindings: unknown[]) => {
            if (query.includes('FROM recovery_records')) recoveryRecordQueries.push(query);
            return exec(query, ...bindings);
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
    const recovery = new TinybirdRecoveryStore(measuredStorage);
    const expectOneRecoveryRecordQuery = () => {
      expect(recoveryRecordQueries).toHaveLength(1);
      recoveryRecordQueries.length = 0;
    };
    const lookup = vi.spyOn(recovery, 'repairByDedupeKey');
    const proof = new FactRepairProof(recovery);
    const compactedRow = readRepair(state.storage, seeded.repairId);
    const compacted = await proof.verifyCompacted(compactedRow, 'org-1');
    expect(compacted.verified).toBe(true);
    if (!compacted.verified) throw new Error(compacted.reason);
    expect(compacted.value.recovery.payload).toBe(seeded.payload);
    expect(compacted.value.recovery.outcome).toBe(seeded.outcome);
    expect(lookup).toHaveBeenCalledTimes(1);
    expectOneRecoveryRecordQuery();

    lookup.mockClear();
    const inline = await proof.verify({ ...compactedRow, data: seeded.payload }, 'org-1');
    expect(inline).toEqual(compacted);
    expect(lookup).toHaveBeenCalledTimes(1);
    expectOneRecoveryRecordQuery();

    lookup.mockClear();
    const compactedWrongOrg = await proof.verifyCompacted(compactedRow, 'org-2');
    expect(compactedWrongOrg).toEqual({
      verified: false,
      reason: 'repair outcome or current payload metadata differs',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expectOneRecoveryRecordQuery();

    lookup.mockClear();
    await expect(proof.verify({ ...compactedRow, data: seeded.payload }, 'org-2')).resolves.toEqual(
      compactedWrongOrg,
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expectOneRecoveryRecordQuery();

    lookup.mockClear();
    expect(recovery.repairByDedupeKey('missing-repair')).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expectOneRecoveryRecordQuery();
  });
});

it('inspects and compacts 100 near-budget repairs within the Worker request budget', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
    for (let index = 0; index < 100; index++) {
      seedRepair(
        state.storage,
        message(`message-${index}`, `current-${index}-${'c'.repeat(12_000)}`, 1),
        message(`message-${index}`, `original-${index}-${'o'.repeat(12_000)}`, 0),
      );
    }

    await expect(instance.inspectFactRepairCapacity('org-1', { limit: 101 })).rejects.toThrow(
      'repair inspection limit must be between 1 and 100',
    );
    await expect(
      instance.compactFactRepairDuplicates('org-1', {
        reason: 'reject over-limit performance batch',
        candidates: Array.from({ length: 101 }, (_, index) => ({
          repairId: index + 1,
          proofSha256: 'a'.repeat(64),
        })),
      }),
    ).rejects.toThrow('fact repair compaction requires between 1 and 100 candidates');

    const startedAt = performance.now();
    const inspection = await instance.inspectFactRepairCapacity('org-1', { limit: 100 });
    expect(inspection.scannedRows).toBe(100);
    expect(inspection.candidates).toHaveLength(100);
    expect(inspection.inspectedPayloadBytes).toBeGreaterThan(3_000_000);
    expect(inspection.inspectedPayloadBytes).toBeLessThanOrEqual(4_000_000);
    expect(inspection.nextAfterRepairId).toBeNull();

    const compacted = await instance.compactFactRepairDuplicates('org-1', {
      reason: 'verify bounded one-hundred-row performance',
      candidates: inspection.candidates.map(({ repairId, proofSha256 }) => ({
        repairId,
        proofSha256,
      })),
    });
    expect(compacted.compacted).toHaveLength(100);
    expect(compacted.failure).toBeNull();
    expect(compacted.remainingRepairIds).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(30_000);
  });
}, 35_000);

function message(messagePk: string, content: string, hour: number): TestMessage {
  return {
    OrgId: 'org-1',
    session_pk: 'session-1',
    message_pk: messagePk,
    EventAt: '2024-01-01 00:00:00.000',
    IngestedAt: `2024-01-01 0${hour}:00:00.000`,
    content,
  };
}

function seedRepair(storage: DurableObjectStorage, current: TestMessage, previous: TestMessage) {
  const category = 'messages';
  const payload = JSON.stringify(current);
  const factId = rowIdentity(current, ['OrgId', 'session_pk', 'message_pk']);
  const oldHash = stableHash(previous);
  const newHash = stableHash(current);
  const dedupeKey = JSON.stringify([category, factId, oldHash, newHash, factIngestedAtMs(current)]);
  storage.sql.exec(
    `INSERT INTO fact_repairs
     (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    category,
    factId,
    oldHash,
    newHash,
    123,
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
  return { repairId, recoveryId: recovery.id, payload, outcome };
}

function readRepair(storage: DurableObjectStorage, repairId: number): StoredFactRepair {
  return storage.sql
    .exec<StoredFactRepair>(
      `SELECT id, category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key
       FROM fact_repairs WHERE id = ?`,
      repairId,
    )
    .one();
}
