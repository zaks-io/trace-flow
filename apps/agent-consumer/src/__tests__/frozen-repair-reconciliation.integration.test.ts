import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { agentAnalyticsDayBounds, sha256Hex } from '@trace-flow/utils';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import {
  assertFrozenRepairReleaseCapacity,
  reconcileFrozenRepairs as reconcileFrozenRepairsCore,
} from '../frozen-repair-reconciliation';
import {
  factIngestedAtMs,
  factPartitionKey,
  rowIdentity,
  ROW_IDENTITY_FIELDS,
  stableHash,
} from '../facts';
import type { ReconcileFrozenRepairInput } from '../frozen-repair-reconciliation-contract';

const env = workerEnv as unknown as AgentConsumerEnv;
const migrationProofSha256 = 'a'.repeat(64);
const verificationSha256 = 'b'.repeat(64);

describe('frozen repair reconciliation', () => {
  it('rejects a batch whose replacement metadata exceeds its logical release', () => {
    expect(() => assertFrozenRepairReleaseCapacity(100, 80, 21)).toThrow(
      'cannot release enough logical bytes',
    );
    expect(() => assertFrozenRepairReleaseCapacity(101, 80, 21)).not.toThrow();
  });

  it('resolves an exact repair idempotently and leaves retirement blocked after partial failure', async () => {
    const orgId = `frozen-repair-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const rows = [fact(orgId, 'first', 1), fact(orgId, 'second', 2)];
    const recoveryIds = await runInDurableObject(batcher, async (instance, state) => {
      const ids = rows.map((row) => seedRepair(state.storage, row));
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
      return ids;
    });
    await completeMigration(orgId);

    const firstProof = await proof(orgId, recoveryIds[0]!, rows[0]!);
    const staleSecond = {
      ...(await proof(orgId, recoveryIds[1]!, rows[1]!)),
      expectedPayloadSha256: 'c'.repeat(64),
    };
    await rejectsBatch(
      batcher,
      orgId,
      [firstProof, staleSecond],
      'payload or outcome SHA256 changed',
    );
    await expect(batcher.getRecovery(recoveryIds[0]!)).resolves.toMatchObject({
      state: 'blocked',
      resolution: null,
    });

    const first = await reconcile(batcher, orgId, firstProof);
    expect(first.resolved).toEqual([
      { recoveryId: recoveryIds[0], resolution: 'frozen-journal-exact' },
    ]);
    await expect(batcher.getRecovery(recoveryIds[0]!)).resolves.toMatchObject({
      resolutionReason: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(reconcile(batcher, orgId, firstProof)).resolves.toMatchObject({
      resolved: first.resolved,
    });
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE fact_repairs SET data = ? WHERE recovery_dedupe_key =
           (SELECT dedupe_key FROM recovery_records WHERE id = ?)`,
        JSON.stringify({ ...rows[0], content: 'replaced after reconciliation' }),
        recoveryIds[0],
      );
    });
    await rejects(batcher, orgId, firstProof, 'already resolved with another proof');
    const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
    await runInDurableObject(batcher, async (instance) => {
      await expectError(
        () =>
          instance.retireFrozenLedger(orgId, {
            verificationSha256,
            migrationProofSha256,
            deliverySequence: 1,
            oldestDay,
            todayDay: today,
            frozenFactCount: 0,
          }),
        'not quiescent',
      );
    });
    await expect(batcher.getRecovery(recoveryIds[1]!)).resolves.toMatchObject({
      state: 'blocked',
      resolution: null,
    });
  });

  it('rejects cross-org, stale-fence, modified-payload, and unfrozen proofs', async () => {
    const orgId = `frozen-guards-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const row = fact(orgId, 'guarded', 1);
    const recoveryId = await runInDurableObject(batcher, async (instance, state) => {
      const id = seedRepair(state.storage, row);
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
      return id;
    });
    await completeMigration(orgId);
    const valid = await proof(orgId, recoveryId, row);

    await rejects(batcher, orgId, { ...valid, orgId: 'another-org' }, 'does not match shard');
    await rejects(
      batcher,
      orgId,
      { ...valid, deliverySequence: 2 },
      'migration proof, delivery fence, or retention window changed',
    );

    const originalOutcome = (await batcher.getRecovery(recoveryId)).outcome;
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE recovery_outcome_chunks SET data = ? WHERE recovery_id = ? AND chunk_index = 0`,
        '{}',
        recoveryId,
      );
    });
    await rejects(batcher, orgId, valid, 'payload or outcome SHA256 changed');
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE recovery_outcome_chunks SET data = ? WHERE recovery_id = ? AND chunk_index = 0`,
        originalOutcome,
        recoveryId,
      );
    });
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE recovery_payload_chunks SET data = ? WHERE recovery_id = ? AND chunk_index = 0`,
        JSON.stringify({ ...row, content: 'modified after inspection' }),
        recoveryId,
      );
    });
    await rejects(batcher, orgId, valid, 'payload or outcome SHA256 changed');

    const writableOrg = `writable-repair-${crypto.randomUUID()}`;
    const writable = env.AGENT_FACT_BATCHER.getByName(`org:${writableOrg}`);
    const writableRow = fact(writableOrg, 'not-frozen', 1);
    const writableId = await runInDurableObject(writable, (_instance, state) =>
      seedRepair(state.storage, writableRow),
    );
    await rejects(
      writable,
      writableOrg,
      await proof(writableOrg, writableId, writableRow),
      'not frozen',
    );
  });

  it('fails closed for unknown, DLQ, and malformed repair records', async () => {
    const orgId = `frozen-invalid-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const row = fact(orgId, 'invalid', 1);
    const ids = await runInDurableObject(batcher, async (instance, state) => {
      const repair = seedRepair(state.storage, row);
      const recovery = new TinybirdRecoveryStore(state.storage);
      const dlq = recovery.preserveDlq('{}', '{}', 'dlq');
      const malformed = recovery.preserveRepair('{malformed', '{}', 'malformed');
      const wrongState = seedRepair(state.storage, fact(orgId, 'wrong-state', 2));
      state.storage.sql.exec(
        `UPDATE recovery_records SET state = 'in_flight' WHERE id = ?`,
        wrongState,
      );
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
      return { repair, dlq: dlq.id, malformed: malformed.id, wrongState };
    });
    await completeMigration(orgId);
    const valid = await proof(orgId, ids.repair, row);
    await rejects(batcher, orgId, { ...valid, recoveryId: 999_999 }, 'not found');
    await rejects(batcher, orgId, { ...valid, recoveryId: ids.dlq }, 'not a verifiable repair');
    await rejects(
      batcher,
      orgId,
      {
        ...valid,
        recoveryId: ids.malformed,
        expectedPayloadSha256: await sha256Hex('{malformed'),
        expectedOutcomeSha256: await sha256Hex('{}'),
      },
      'link is not unique',
    );
    await rejects(
      batcher,
      orgId,
      { ...valid, recoveryId: ids.wrongState },
      'in-flight record is private',
    );
    await expect(batcher.getRecovery(ids.repair)).resolves.toMatchObject({ state: 'blocked' });
  });

  it('releases inline and chunk payload bytes before adding compact tombstones', async () => {
    const orgId = `frozen-capacity-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...fact(orgId, `capacity-${index}`, 1),
      content: 'x'.repeat(8_000),
    }));
    const seeded = await runInDurableObject(batcher, async (instance, state) => {
      const recovery = new TinybirdRecoveryStore(state.storage);
      const ids = rows.map((row) => seedRepair(state.storage, row));
      for (const id of ids.filter((_, index) => index % 2 === 0)) {
        const record = recovery.get(id);
        state.storage.sql.exec('DELETE FROM recovery_payload_chunks WHERE recovery_id = ?', id);
        state.storage.sql.exec('DELETE FROM recovery_outcome_chunks WHERE recovery_id = ?', id);
        state.storage.sql.exec(
          'UPDATE recovery_records SET payload = ?, outcome = ? WHERE id = ?',
          record.payload,
          record.outcome,
          id,
        );
      }
      for (const id of ids.filter((_, index) => index % 3 === 0)) {
        state.storage.sql.exec(
          `UPDATE fact_repairs SET data = NULL WHERE recovery_dedupe_key =
             (SELECT dedupe_key FROM recovery_records WHERE id = ?)`,
          id,
        );
      }
      const rawBytes = recoveryPayloadBytes(state.storage);
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
      return { ids, rawBytes };
    });
    await completeMigration(orgId);
    const proofs = await Promise.all(
      rows.map((row, index) => proof(orgId, seeded.ids[index]!, row)),
    );

    await runInDurableObject(batcher, async (instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_frozen_repair_hydration BEFORE UPDATE OF data ON fact_repairs
         WHEN NEW.data IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL simulated'); END`,
      );
      await expectError(
        () =>
          reconcileFrozenRepairsCore(
            orgId,
            { repairs: proofs },
            reconciliationContext(instance, state),
          ),
        'SQLITE_FULL simulated',
      );
      expect(
        state.storage.sql
          .exec<{
            count: number;
          }>("SELECT count(*) AS count FROM recovery_records WHERE state = 'blocked'")
          .one().count,
      ).toBe(100);
      expect(recoveryPayloadBytes(state.storage)).toBe(seeded.rawBytes);
      expect(
        state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM fact_repairs WHERE data IS NULL')
          .one().count,
      ).toBe(34);
      expect(
        state.storage.sql
          .exec<{
            count: number;
          }>('SELECT count(*) AS count FROM recovery_records WHERE resolution IS NOT NULL')
          .one().count,
      ).toBe(0);
      state.storage.sql.exec('DROP TRIGGER fail_frozen_repair_hydration');

      await expectError(
        () =>
          reconcileFrozenRepairsCore(
            orgId,
            { repairs: proofs },
            growthReportingContext(instance, state),
          ),
        'would grow SQLite storage',
      );
      expect(recoveryPayloadBytes(state.storage)).toBe(seeded.rawBytes);
      expect(
        state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM fact_repairs WHERE data IS NULL')
          .one().count,
      ).toBe(34);
      expect(
        state.storage.sql
          .exec<{
            count: number;
          }>('SELECT count(*) AS count FROM recovery_records WHERE resolution IS NOT NULL')
          .one().count,
      ).toBe(0);

      const actualDatabaseSizeBeforeBytes = state.storage.sql.databaseSize;
      const reportedDatabaseSize = 20 * 1024 ** 3;
      const result = await reconcileFrozenRepairsCore(
        orgId,
        { repairs: proofs },
        fixedSizeReportingContext(instance, state, reportedDatabaseSize),
      );
      expect(result.resolved).toHaveLength(100);
      expect(result.storage).toMatchObject({
        databaseSizeBeforeBytes: reportedDatabaseSize,
        databaseSizeAfterBytes: reportedDatabaseSize,
      });
      expect(result.storage.releasedRecoveryBytes).toBeGreaterThan(
        result.storage.hydratedRepairBytes + result.storage.tombstoneBytes,
      );
      const chunks = state.storage.sql
        .exec<{ count: number }>(
          `SELECT
             (SELECT count(*) FROM recovery_payload_chunks) +
             (SELECT count(*) FROM recovery_outcome_chunks) AS count`,
        )
        .one().count;
      const tombstoneBytes = state.storage.sql
        .exec<{ bytes: number }>(
          `SELECT sum(length(CAST(resolution AS BLOB)) +
                      length(CAST(resolution_reason AS BLOB)) + 8) AS bytes
           FROM recovery_records`,
        )
        .one().bytes;
      expect(chunks).toBe(0);
      expect(recoveryPayloadBytes(state.storage)).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM fact_repairs WHERE data IS NULL')
          .one().count,
      ).toBe(0);
      expect(seeded.rawBytes).toBeGreaterThan(tombstoneBytes);
      expect(state.storage.sql.databaseSize).toBeLessThanOrEqual(actualDatabaseSizeBeforeBytes);
    });
  });
});

function reconcile(
  batcher: DurableObjectStub<AgentFactBatcherInstance>,
  orgId: string,
  input: ReconcileFrozenRepairInput,
) {
  return runInDurableObject(batcher, (instance, state) =>
    reconcileFrozenRepairsCore(orgId, { repairs: [input] }, reconciliationContext(instance, state)),
  );
}

function rejects(
  batcher: DurableObjectStub<AgentFactBatcherInstance>,
  orgId: string,
  input: ReconcileFrozenRepairInput,
  message: string,
) {
  return runInDurableObject(batcher, async (instance, state) => {
    await expectError(
      () =>
        reconcileFrozenRepairsCore(
          orgId,
          { repairs: [input] },
          reconciliationContext(instance, state),
        ),
      message,
    );
  });
}

function rejectsBatch(
  batcher: DurableObjectStub<AgentFactBatcherInstance>,
  orgId: string,
  repairs: ReconcileFrozenRepairInput[],
  message: string,
) {
  return runInDurableObject(batcher, async (instance, state) => {
    await expectError(
      () => reconcileFrozenRepairsCore(orgId, { repairs }, reconciliationContext(instance, state)),
      message,
    );
  });
}

function reconciliationContext(instance: AgentFactBatcherInstance, state: DurableObjectState) {
  const internals = instance as unknown as {
    legacyState: Parameters<typeof reconcileFrozenRepairsCore>[2]['legacyState'];
    maintenance: { assertUnlocked(): void };
    flushInProgress: boolean;
    countPendingRows(): number;
  };
  const recovery = new TinybirdRecoveryStore(state.storage);
  return {
    storage: state.storage,
    recovery,
    coordinators: env.AGENT_DELIVERY_COORDINATOR,
    legacyState: internals.legacyState,
    flushInProgress: internals.flushInProgress,
    assertMaintenanceUnlocked: () => internals.maintenance.assertUnlocked(),
    pendingRows: () => internals.countPendingRows(),
    blockedRows: () => recovery.countBlockedRows(),
  };
}

function growthReportingContext(instance: AgentFactBatcherInstance, state: DurableObjectState) {
  const context = reconciliationContext(instance, state);
  const actualSize = state.storage.sql.databaseSize;
  let reads = 0;
  const sql = new Proxy(state.storage.sql, {
    get(target, property) {
      if (property === 'databaseSize') return actualSize + (reads++ === 0 ? 0 : 1);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const storage = new Proxy(state.storage, {
    get(target, property) {
      if (property === 'sql') return sql;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...context, storage };
}

function fixedSizeReportingContext(
  instance: AgentFactBatcherInstance,
  state: DurableObjectState,
  databaseSize: number,
) {
  const context = reconciliationContext(instance, state);
  const sql = new Proxy(state.storage.sql, {
    get(target, property) {
      if (property === 'databaseSize') return databaseSize;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const storage = new Proxy(state.storage, {
    get(target, property) {
      if (property === 'sql') return sql;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...context, storage };
}

async function expectError(run: () => Promise<unknown>, message: string): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toContain(message);
}

async function completeMigration(orgId: string): Promise<void> {
  const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
  await coordinator.seedIngestionMigration({ proofSha256: migrationProofSha256, dirtyDays: [] });
  await coordinator.completeIngestionMigration({ proofSha256: migrationProofSha256 });
}

function seedRepair(storage: DurableObjectStorage, row: Record<string, unknown>): number {
  const category = 'messages';
  const factId = rowIdentity(row, ROW_IDENTITY_FIELDS[category]);
  const newHash = stableHash(row);
  const oldHash = '0'.repeat(16);
  const dedupeKey = JSON.stringify([category, factId, oldHash, newHash, factIngestedAtMs(row)]);
  const payload = JSON.stringify(row);
  const outcome = JSON.stringify({ category, factId, oldHash, newHash, originalPayload: null });
  const recovery = new TinybirdRecoveryStore(storage).preserveRepair(payload, outcome, dedupeKey);
  storage.sql.exec(
    `INSERT INTO fact_repairs
     (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    category,
    factId,
    oldHash,
    newHash,
    1,
    payload,
    dedupeKey,
  );
  return recovery.id;
}

function recoveryPayloadBytes(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ bytes: number }>(
      `SELECT
         (SELECT coalesce(sum(length(CAST(payload AS BLOB)) + length(CAST(outcome AS BLOB))), 0)
          FROM recovery_records) +
         (SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) FROM recovery_payload_chunks) +
         (SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) FROM recovery_outcome_chunks) AS bytes`,
    )
    .one().bytes;
}

async function proof(
  orgId: string,
  recoveryId: number,
  row: Record<string, unknown>,
): Promise<ReconcileFrozenRepairInput> {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  const sourceRowSha256 = 'd'.repeat(64);
  return {
    recoveryId,
    expectedPayloadSha256: await sha256Hex(JSON.stringify(row)),
    expectedOutcomeSha256: await sha256Hex(
      JSON.stringify({
        category: 'messages',
        factId: rowIdentity(row, ROW_IDENTITY_FIELDS.messages),
        oldHash: '0'.repeat(16),
        newHash: stableHash(row),
        originalPayload: null,
      }),
    ),
    orgId,
    category: 'messages',
    factId: rowIdentity(row, ROW_IDENTITY_FIELDS.messages),
    migrationProofSha256,
    deliverySequence: 1,
    oldestDay,
    todayDay: today,
    fullVerificationSha256: verificationSha256,
    disposition: 'exact',
    sourceEventDay: factPartitionKey('messages', row),
    sourceIngestedAtMs: factIngestedAtMs(row),
    sourceRowSha256,
    canonical: {
      eventDay: factPartitionKey('messages', row),
      deliverySequence: 1,
      contentHash: 'e'.repeat(64),
      ingestedAtMs: factIngestedAtMs(row),
      rowSha256: sourceRowSha256,
    },
  };
}

function fact(orgId: string, id: string, second: number): Record<string, unknown> {
  const day = new Date().toISOString().slice(0, 10);
  const timestamp = `${day} 00:00:0${second}.000`;
  return {
    OrgId: orgId,
    session_pk: 'session',
    message_pk: id,
    EventAt: timestamp,
    IngestedAt: timestamp,
    content: id,
  };
}
