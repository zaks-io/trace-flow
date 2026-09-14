import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import { describe, expect, it } from 'vitest';
import { AgentFactMaintenance } from '../fact-maintenance';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { CATEGORIES, type Category } from '../facts';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const orgId = 'org-frozen-inventory';

function host() {
  return env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
}

describe('frozen fact inventory', () => {
  it('pages ledger identities in key order without reading unavailable payloads', async () => {
    const batcher = host();
    const expected = CATEGORIES.flatMap((category) =>
      Array.from({ length: 17 }, (_, index) => ({
        category,
        factId: `${category}-${index.toString().padStart(3, '0')}`,
      })),
    ).sort(compareIdentity);

    await runInDurableObject(batcher, async (instance, state) => {
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
      state.storage.transactionSync(() => {
        for (const identity of [...expected].reverse()) {
          state.storage.sql.exec(
            `INSERT INTO fact_ledger
             (category,fact_id,content_hash,first_seen_at_ms,data)
             VALUES (?,?,?,1,'')`,
            identity.category,
            identity.factId,
            'missing-payload',
          );
        }
      });

      const first = instance.listFrozenFacts(orgId, { limit: 100 });
      expect(first).toEqual({
        facts: expected.slice(0, 100),
        nextAfter: expected[99],
      });
      const second = instance.listFrozenFacts(orgId, { after: first.nextAfter!, limit: 100 });
      expect(second).toEqual({ facts: expected.slice(100), nextAfter: null });
      expect(instance.listFrozenFacts(orgId, { after: expected.at(-1), limit: 100 })).toEqual({
        facts: [],
        nextAfter: null,
      });

      expect(() => instance.listFrozenFacts(orgId, { limit: 101 })).toThrow(
        'fact rebuild limit must be between 1 and 100',
      );
      expect(() =>
        instance.listFrozenFacts(orgId, {
          after: { category: 'unknown' as Category, factId: 'fact' },
        }),
      ).toThrow('invalid fact rebuild cursor');
      expect(() =>
        instance.listFrozenFacts(orgId, {
          after: { category: 'messages', factId: '' },
        }),
      ).toThrow('invalid fact rebuild cursor');

      expect(() =>
        instance.readFrozenFacts(orgId, {
          facts: [
            {
              ...expected[0]!,
              expectedSourceHash: '0'.repeat(16),
            },
          ],
        }),
      ).toThrow('frozen fact source payload is missing');
    });
  });

  it('keeps full rebuild pages hydrated', async () => {
    const batcher = host();
    const payload = JSON.stringify({ OrgId: orgId, session_pk: 'session', message_pk: 'message' });
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category,fact_id,content_hash,first_seen_at_ms,data)
         VALUES ('messages','fact','content-hash',1,?)`,
        payload,
      );
      const recovery = new TinybirdRecoveryStore(state.storage);
      const maintenance = new AgentFactMaintenance(state.storage, recovery, () => undefined);
      expect(maintenance.listFrozen(orgId, {}).facts).toEqual([
        {
          category: 'messages',
          factId: 'fact',
          contentHash: 'content-hash',
          payload,
          missingPayload: false,
          pending: [],
        },
      ]);
    });
  });
});

function compareIdentity(
  left: { category: Category; factId: string },
  right: { category: Category; factId: string },
): number {
  if (left.category !== right.category) return left.category < right.category ? -1 : 1;
  return left.factId.localeCompare(right.factId);
}
