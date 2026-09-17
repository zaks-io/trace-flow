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
    expect(() => recovery.repairByDedupeKey('duplicate')).toThrow(
      'repair recovery dedupe key is not unique',
    );

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

it('pages blocked recovery records through the blocked index without sorting', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, (_instance: AgentFactBatcherInstance, state) => {
    const sql = state.storage.sql;
    const recovery = new TinybirdRecoveryStore(state.storage);
    recovery.initialize();
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 5000
      )
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
      SELECT 'repair', 'blocked', 'changed', NULL, NULL, 'first-' || n, '', '', n FROM rows
    `);
    sql.exec(`
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, payload, outcome, created_at_ms,
         resolved_at_ms, resolution, resolution_reason)
      VALUES
        ('tinybird_insert', 'resolved', 'uncertain', 'facts', 'pending_facts:messages',
         '[{"batch":3}]', '{"status":"written"}', 5001, 5001, 'confirm-written', 'proof')
    `);

    const firstPage = recovery.list({ limit: 100 });
    expect(firstPage.records).toHaveLength(100);
    expect(firstPage.records[0]).toMatchObject({ id: 1, kind: 'repair', state: 'blocked' });
    expect(firstPage.nextAfterId).toBe(100);
    expect(recovery.list({ afterId: 4900, limit: 100 })).toMatchObject({ nextAfterId: null });
    expect(recovery.list({ state: 'resolved' })).toMatchObject({
      records: [{ id: 5001, kind: 'tinybird_insert', state: 'resolved' }],
      nextAfterId: null,
    });
    expect(() => recovery.list({ afterId: -1 })).toThrow('afterId must be a non-negative integer');
    expect(() => recovery.list({ limit: 101 })).toThrow('limit must be between 1 and 100');

    const plan = sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM recovery_records WHERE id > ? AND state = ? ORDER BY id LIMIT ?`,
        0,
        'blocked',
        2,
      )
      .toArray()
      .map(({ detail }) => detail)
      .join('\n');
    expect(plan).toContain('idx_recovery_records_blocked');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});

it('counts blocked recovery rows from the bounded recovery-items side of the join', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, (_instance: AgentFactBatcherInstance, state) => {
    const sql = state.storage.sql;
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 77910
      )
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
      SELECT 'repair', 'blocked', 'changed', NULL, NULL, 'repair-' || n, '', '', 0 FROM rows
    `);
    const measured = {
      cursor: { rowsRead: -1 } as { readonly rowsRead: number },
    };
    let blockedRowsQuery: string | undefined;
    const measuredSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === 'exec') {
          const exec = target.exec.bind(target);
          return (query: string, ...args: unknown[]) => {
            const cursor = exec(query, ...args);
            if (query.includes('FROM recovery_items AS i')) {
              measured.cursor = cursor;
              blockedRowsQuery = query;
            }
            return cursor;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const measuredStorage: DurableObjectStorage = new Proxy(state.storage, {
      get(target, property, receiver) {
        if (property === 'sql') return measuredSql;
        return Reflect.get(target, property, receiver);
      },
    });
    const recovery = new TinybirdRecoveryStore(measuredStorage);
    const countBlocked = () => {
      measured.cursor = { rowsRead: -1 };
      const count = recovery.countBlockedRows();
      const rowsRead = measured.cursor.rowsRead;
      if (rowsRead < 0) throw new Error('countBlockedRows did not execute its rows query');
      return { count, rowsRead };
    };

    expect(countBlocked()).toEqual({ count: 0, rowsRead: 1 });

    sql.exec(`
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, payload, outcome, created_at_ms)
      VALUES ('tinybird_insert', 'blocked', 'uncertain', 'facts', 'pending_facts:messages', '', '', 1)
    `);
    const blockedId = sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id;
    sql.exec(
      `INSERT INTO recovery_items (recovery_id, row_id, target_key) VALUES (?, 1, ?)`,
      blockedId,
      'pending_facts:messages',
    );
    expect(countBlocked()).toEqual({ count: 1, rowsRead: 2 });

    sql.exec(`
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, payload, outcome, created_at_ms)
      VALUES
        ('tinybird_insert', 'in_flight', NULL, 'facts', 'pending_facts:messages', '', '', 2),
        ('tinybird_insert', 'resolved', 'uncertain', 'facts', 'pending_facts:messages', '', '', 3)
    `);
    const resolvedId = sql.exec<{ id: number }>('SELECT last_insert_rowid() AS id').one().id;
    const inFlightId = resolvedId - 1;
    sql.exec(
      `INSERT INTO recovery_items (recovery_id, row_id, target_key) VALUES
         (?, 2, ?), (?, 3, ?), (?, 4, ?)`,
      blockedId,
      'pending_facts:messages',
      inFlightId,
      'pending_facts:messages',
      resolvedId,
      'pending_facts:messages',
    );

    expect(countBlocked()).toEqual({ count: 2, rowsRead: 6 });
    if (!blockedRowsQuery) throw new Error('countBlockedRows did not expose its rows query');
    const plan = sql
      .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${blockedRowsQuery}`)
      .toArray()
      .map((row) => row.detail)
      .join('\n');
    expect(plan).toContain('SCAN i');
  });
});
