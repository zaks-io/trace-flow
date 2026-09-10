import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { expect, it } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

it('indexes existing recovery records without deleting duplicate repairs and bounds lookup reads', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, (_instance: AgentFactBatcherInstance, state) => {
    const sql = state.storage.sql;
    sql.exec('DROP INDEX IF EXISTS idx_recovery_repair_dedupe');
    sql.exec('DROP INDEX IF EXISTS idx_recovery_records_blocked');
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 10000
      )
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
      SELECT 'repair', 'resolved', 'changed', NULL, NULL, 'resolved-' || n, '', '', 0 FROM rows
    `);
    sql.exec(
      `INSERT INTO recovery_records
         (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
       VALUES
         ('repair', 'blocked', 'changed', NULL, NULL, 'duplicate', '', '', 1),
         ('repair', 'blocked', 'changed', NULL, NULL, 'duplicate', '', '', 2)`,
    );

    const lookup = (dedupeKey: string) => {
      const cursor = sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records
         WHERE kind = 'repair' AND dedupe_key = ? LIMIT 1`,
        dedupeKey,
      );
      return { rows: cursor.toArray(), rowsRead: cursor.rowsRead };
    };
    const countBlocked = () => {
      const cursor = sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM recovery_records WHERE state = 'blocked'`,
      );
      return { count: cursor.one().count, rowsRead: cursor.rowsRead };
    };

    expect(lookup('missing').rowsRead).toBeGreaterThanOrEqual(10_000);
    expect(countBlocked().rowsRead).toBeGreaterThanOrEqual(10_000);

    const recovery = new TinybirdRecoveryStore(state.storage);
    recovery.initialize();
    recovery.initialize();

    expect(
      sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_records').one().count,
    ).toBe(10_002);
    expect(
      sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM recovery_records
           WHERE kind = 'repair' AND dedupe_key = 'duplicate'`,
        )
        .one().count,
    ).toBe(2);
    expect(lookup('duplicate')).toMatchObject({ rows: [{ id: 10001 }], rowsRead: 1 });
    expect(lookup('missing')).toEqual({ rows: [], rowsRead: 0 });
    expect(countBlocked()).toEqual({ count: 2, rowsRead: 2 });

    const repairPlan = sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT id FROM recovery_records
         WHERE kind = 'repair' AND dedupe_key = 'duplicate' LIMIT 1`,
      )
      .toArray()
      .map((row) => row.detail)
      .join('\n');
    const blockedPlan = sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*) AS count FROM recovery_records WHERE state = 'blocked'`,
      )
      .toArray()
      .map((row) => row.detail)
      .join('\n');
    expect(repairPlan).toContain('idx_recovery_repair_dedupe');
    expect(blockedPlan).toContain('idx_recovery_records_blocked');

    recovery.preserveRepair('{"preserved":true}', '{"reason":"same"}', 'duplicate');
    expect(
      sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_records').one().count,
    ).toBe(10_002);
  });
});
