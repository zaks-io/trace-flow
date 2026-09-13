import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConsumerEnv } from '../context';
import { replayFrozenFactSelection } from '../frozen-fact-replay';
import { factIngestedAtMs, rowIdentity, stableHash, ROW_IDENTITY_FIELDS } from '../facts';

const env = workerEnv as unknown as AgentConsumerEnv;
const writes: Record<string, unknown>[] = [];

function sourceRow(orgId: string) {
  return {
    OrgId: orgId,
    session_pk: 'session-1',
    message_pk: 'message-1',
    EventAt: '2026-09-01 00:00:00.000',
    IngestedAt: '2026-09-01 01:00:00.000',
    cost_usd: 47.125,
  };
}

function mockTinybird() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('agent_fact_identity_day')) {
        const identities = (url.searchParams.get('identities') ?? '').split(',');
        return Response.json({
          data: writes
            .filter((row) => row.IsDeleted === 0)
            .filter((row) => identities.includes(String(row.FactIdentity)))
            .map((row) => ({
              FactIdentity: row.FactIdentity,
              EventDay: String(row.EventAt).slice(0, 10),
              DeliverySequence: row.DeliverySequence,
              ContentHash: row.ContentHash,
            })),
        });
      }
      if (url.pathname === '/v0/events') {
        for (const line of String(init?.body).trim().split('\n')) {
          const row = JSON.parse(line) as Record<string, unknown>;
          writes.push({
            ...row,
            FactIdentity: rowIdentity(row, ROW_IDENTITY_FIELDS.messages),
          });
        }
        return Response.json({ successful_rows: writes.length, quarantined_rows: 0 });
      }
      if (url.pathname.includes('agent_delivery_receipt')) return Response.json({ data: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    }),
  );
}

afterEach(() => {
  writes.length = 0;
  vi.unstubAllGlobals();
});

describe('frozen ledger replay', () => {
  it('replays once without repricing or deleting the old source', async () => {
    mockTinybird();
    const orgId = `test-${crypto.randomUUID()}`;
    const row = sourceRow(orgId);
    const ledgerRow = {
      ...row,
      IngestedAt: '2026-09-01 00:00:00.000',
      cost_usd: 1,
    };
    const factId = rowIdentity(row, ROW_IDENTITY_FIELDS.messages);
    const sourceHash = stableHash(row);
    const ledgerHash = stableHash(ledgerRow);
    const repairDedupeKey = JSON.stringify([
      'messages',
      factId,
      ledgerHash,
      sourceHash,
      factIngestedAtMs(row),
    ]);
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    await runInDurableObject(batcher, async (instance, state) => {
      instance.getIngestionMigrationState();
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES (?, ?, ?, ?, ?, 1, 0)`,
        'messages',
        factId,
        ledgerHash,
        Date.now(),
        JSON.stringify(ledgerRow),
      );
      state.storage.sql.exec(
        `INSERT INTO fact_repairs
         (category, fact_id, old_hash, new_hash, seen_at_ms, data, recovery_dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'messages',
        factId,
        ledgerHash,
        sourceHash,
        Date.now(),
        JSON.stringify(row),
        repairDedupeKey,
      );
      state.storage.sql.exec(
        `INSERT INTO recovery_records
         (kind, state, classification, target, target_key, dedupe_key, payload, outcome,
          created_at_ms)
         VALUES ('repair', 'blocked', 'changed', NULL, NULL, ?, ?, ?, ?)`,
        repairDedupeKey,
        JSON.stringify(row),
        JSON.stringify({
          category: 'messages',
          factId,
          oldHash: ledgerHash,
          newHash: sourceHash,
          originalPayload: JSON.stringify(ledgerRow),
        }),
        Date.now(),
      );
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
    });
    const input = {
      deliveryId: crypto.randomUUID(),
      createdAtMs: Date.now(),
      facts: [
        {
          category: 'messages' as const,
          factId,
          expectedSourceHash: sourceHash,
          expectedCanonical: null,
        },
      ],
    };

    const first = await replayFrozenFactSelection(env, orgId, input, batcher);
    const second = await replayFrozenFactSelection(env, orgId, input, batcher);

    expect(second).toEqual(first);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ cost_usd: 47.125, DeliverySequence: first.deliverySequence });
    await runInDurableObject(batcher, (_instance, state) => {
      const stored = state.storage.sql
        .exec<{
          data: string;
        }>('SELECT data FROM fact_ledger WHERE category = ? AND fact_id = ?', 'messages', factId)
        .one();
      expect(JSON.parse(stored.data)).toMatchObject({ cost_usd: 1 });
    });
  });
});
