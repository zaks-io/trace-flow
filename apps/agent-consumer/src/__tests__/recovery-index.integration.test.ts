import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { AgentDeadLettersInstance } from '../dead-letters';

const env = workerEnv as unknown as {
  AGENT_DEAD_LETTERS: DurableObjectNamespace<AgentDeadLettersInstance>;
};

it('dedupes dead letters with bounded lookup reads across resolved history', async () => {
  const host = env.AGENT_DEAD_LETTERS.get(env.AGENT_DEAD_LETTERS.newUniqueId());
  await runInDurableObject(host, (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 10000
      )
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
      SELECT 'dlq', 'resolved', 'dead_letter', NULL, NULL, 'resolved-' || n, '', '', 0 FROM rows
    `);
    const record = instance.preserveDlq('{"complete":true}', '{}', 'blocked');
    expect(instance.preserveDlq('{"complete":true}', '{}', 'blocked')).toEqual(record);
    const lookup = (key: string) => {
      const cursor = sql.exec<{ id: number }>(
        `SELECT id FROM recovery_records WHERE kind = 'dlq' AND dedupe_key = ? LIMIT 1`,
        key,
      );
      return { rows: cursor.toArray(), rowsRead: cursor.rowsRead };
    };
    expect(lookup('blocked')).toEqual({ rows: [{ id: record.id }], rowsRead: 1 });
    expect(lookup('missing')).toEqual({ rows: [], rowsRead: 0 });
    expect(
      sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_records').one().count,
    ).toBe(10001);
  });
});

it('pages blocked dead letters through the blocked index without sorting resolved history', async () => {
  const host = env.AGENT_DEAD_LETTERS.get(env.AGENT_DEAD_LETTERS.newUniqueId());
  await runInDurableObject(host, (instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 5000
      )
      INSERT INTO recovery_records
        (kind, state, classification, target, target_key, dedupe_key, payload, outcome, created_at_ms)
      SELECT 'dlq', 'blocked', 'dead_letter', NULL, NULL, 'dead-' || n, '', '', n FROM rows
    `);
    const resolved = instance.reconcileRecovery({
      recoveryId: 5000,
      action: 'retire-dead-letter',
      reason: 'operator retired the message',
    });
    const firstPage = instance.listRecovery({ limit: 100 });
    expect(firstPage.records).toHaveLength(100);
    expect(firstPage.records[0]).toMatchObject({ id: 1, kind: 'dlq', state: 'blocked' });
    expect(firstPage.nextAfterId).toBe(100);
    expect(instance.listRecovery({ afterId: 4900, limit: 100 })).toMatchObject({
      nextAfterId: null,
    });
    expect(instance.listRecovery({ state: 'resolved' })).toEqual({
      records: [resolved],
      nextAfterId: null,
    });
    expect(() => instance.listRecovery({ afterId: -1 })).toThrow(
      'afterId must be a non-negative integer',
    );
    expect(() => instance.listRecovery({ limit: 101 })).toThrow('limit must be between 1 and 100');
    const plan = sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM recovery_records WHERE id > ? AND state = ? ORDER BY id LIMIT ?`,
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
