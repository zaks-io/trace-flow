import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { AgentFactBatcherInstance } from '../fact-batcher';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

it('indexes existing repairs without losing rows and bounds hit and miss reads', async () => {
  const batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  await runInDurableObject(batcher, (instance: AgentFactBatcherInstance, state) => {
    const sql = state.storage.sql;
    sql.exec('DROP INDEX IF EXISTS idx_fact_repairs_lookup');
    sql.exec(`
      WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 10000
      )
      INSERT INTO fact_repairs (category, fact_id, old_hash, new_hash, seen_at_ms, data)
      SELECT 'messages', 'fact-' || n, 'old', 'new', 0, '{"preserved":true}' FROM rows
    `);
    const lookup = (factId: string) => {
      const cursor = sql.exec<{ id: number }>(
        `SELECT id FROM fact_repairs
         WHERE category = ? AND fact_id = ? AND old_hash = ? AND new_hash = ? LIMIT 1`,
        'messages',
        factId,
        'old',
        'new',
      );
      return { rows: cursor.toArray(), rowsRead: cursor.rowsRead };
    };
    expect(lookup('missing').rowsRead).toBeGreaterThanOrEqual(10000);

    const schema = instance as unknown as { initializeSchema(): void };
    schema.initializeSchema();
    schema.initializeSchema();

    expect(
      sql
        .exec<{
          count: number;
        }>(`SELECT COUNT(*) AS count FROM fact_repairs WHERE data = '{"preserved":true}'`)
        .one().count,
    ).toBe(10000);
    const hit = lookup('fact-10000');
    expect(hit.rows).toHaveLength(1);
    expect(hit.rowsRead).toBeLessThanOrEqual(1);
    const miss = lookup('missing');
    expect(miss.rows).toEqual([]);
    expect(miss.rowsRead).toBe(0);
  });
});
