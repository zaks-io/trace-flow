import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillPendingFactIdentities } from '../fact-pending-migration';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { ROW_IDENTITY_FIELDS, rowIdentity, stableHash } from '../facts';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

const row = {
  OrgId: 'org-1',
  session_pk: 'session-1',
  message_pk: 'message-1',
  content: 'chunked legacy payload',
};

describe('legacy pending fact migration', () => {
  let batcher: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  });

  it('visits pending rows once as a large legacy backlog migrates', async () => {
    await batcher.getStats();
    const result = await runInDurableObject(batcher, (_instance, state) => {
      for (let index = 0; index < 80; index++) {
        const value = { ...row, message_pk: `message-${index}` };
        const payload = JSON.stringify(value);
        state.storage.sql.exec(
          `INSERT INTO fact_ledger
           (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
           VALUES ('messages', ?, ?, 0, ?, 1, 0)`,
          rowIdentity(value, ROW_IDENTITY_FIELDS.messages),
          stableHash(value),
          payload,
        );
        state.storage.sql.exec(
          `INSERT INTO pending_facts (category, data, created_at_ms)
           VALUES ('messages', ?, 0)`,
          payload,
        );
      }
      let rowsRead = 0;
      const storage = {
        sql: {
          exec(query: string, ...bindings: (string | number | null)[]) {
            const cursor = state.storage.sql.exec(query, ...bindings);
            return {
              *[Symbol.iterator]() {
                yield* cursor;
                rowsRead += cursor.rowsRead;
              },
            };
          },
        },
      } as unknown as Parameters<typeof backfillPendingFactIdentities>[0];
      const migrated = backfillPendingFactIdentities(storage, 'org-1');
      return { migrated, rowsRead };
    });
    expect(result.migrated).toBe(80);
    expect(result.rowsRead).toBeGreaterThanOrEqual(160);
    expect(result.rowsRead).toBeLessThan(250);
  });

  it('hydrates a chunked pending row from its identity-verified ledger fact', async () => {
    await batcher.getStats();
    const result = await runInDurableObject(batcher, (_instance, state) => {
      const payload = JSON.stringify(row);
      const factId = rowIdentity(row, ROW_IDENTITY_FIELDS.messages);
      const contentHash = stableHash(row);
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES ('messages', ?, ?, 0, ?, 1, 1)`,
        factId,
        contentHash,
        payload,
      );
      state.storage.sql.exec(
        `INSERT INTO legacy_pending_facts
         (category, fact_id, content_hash, data, created_at_ms, sent_at_ms)
         VALUES ('messages', NULL, NULL, '', 0, NULL)`,
      );
      const rowId = state.storage.sql
        .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
        .one().id;
      const split = Math.floor(payload.length / 2);
      for (const [index, data] of [payload.slice(0, split), payload.slice(split)].entries()) {
        state.storage.sql.exec(
          `INSERT INTO fact_payload_chunks (table_name, row_id, chunk_index, data)
           VALUES ('legacy_pending_facts', ?, ?, ?)`,
          rowId,
          index,
          data,
        );
      }

      const migrated = backfillPendingFactIdentities(state.storage, 'org-1');
      const pending = state.storage.sql
        .exec<{
          fact_id: string;
          content_hash: string;
        }>('SELECT fact_id, content_hash FROM legacy_pending_facts WHERE id = ?', rowId)
        .one();
      return { migrated, pending, factId, contentHash };
    });

    expect(result).toMatchObject({
      migrated: 1,
      pending: { fact_id: result.factId, content_hash: result.contentHash },
    });
  });

  it('fails without changing an unresolved chunked row', async () => {
    await batcher.getStats();
    const result = await runInDurableObject(batcher, (_instance, state) => {
      const payload = JSON.stringify(row);
      const factId = rowIdentity(row, ROW_IDENTITY_FIELDS.messages);
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES ('messages', ?, ?, 0, ?, 1, 1)`,
        factId,
        stableHash(row),
        payload,
      );
      state.storage.sql.exec(
        `INSERT INTO pending_facts
         (category, fact_id, content_hash, data, created_at_ms, sent_at_ms)
         VALUES ('messages', NULL, NULL, '', 0, NULL)`,
      );
      const rowId = state.storage.sql
        .exec<{ id: number }>('SELECT last_insert_rowid() AS id')
        .one().id;
      state.storage.sql.exec(
        `INSERT INTO fact_payload_chunks (table_name, row_id, chunk_index, data)
         VALUES ('pending_facts', ?, 1, ?)`,
        rowId,
        payload,
      );

      let error = '';
      try {
        backfillPendingFactIdentities(state.storage, 'org-1');
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const pending = state.storage.sql
        .exec<{
          fact_id: string | null;
          content_hash: string | null;
        }>('SELECT fact_id, content_hash FROM pending_facts WHERE id = ?', rowId)
        .one();
      return { error, pending };
    });

    expect(result.error).toContain('payload chunk sequence is incomplete');
    expect(result.pending).toEqual({ fact_id: null, content_hash: null });
  });
});
