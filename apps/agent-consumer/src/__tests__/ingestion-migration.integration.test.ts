import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AgentDeliveryCoordinator } from '../agent-delivery-coordinator';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { finishSnapshotCopies } from './snapshot-coordinator-helpers';

const CLAIM_ID = 'claim-a';

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};
const proofSha256 = 'a'.repeat(64);
const day = new Date().toISOString().slice(0, 10);

function host() {
  return env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
}

describe('bounded ingestion migration', () => {
  it('blocks acceptance and completion until seeded snapshot days are published', async () => {
    await runInDurableObject(host(), (_instance, state) => {
      const coordinator = new AgentDeliveryCoordinator(state, {} as AgentConsumerEnv);
      expect(coordinator.seedIngestionMigration({ proofSha256, dirtyDays: [day] })).toEqual({
        proofSha256,
        complete: false,
      });
      expect(() =>
        coordinator.reserve({
          deliveryId: 'delivery',
          payloadSha256: proofSha256,
          dirtyDays: [day],
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        }),
      ).toThrow('migration is incomplete');
      expect(() => coordinator.completeIngestionMigration({ proofSha256 })).toThrow(
        'snapshots are not complete',
      );
      const snapshot = coordinator.beginSnapshot({ claimId: CLAIM_ID });
      finishSnapshotCopies(coordinator, snapshot.generation, CLAIM_ID);
      expect(coordinator.completeIngestionMigration({ proofSha256 })).toEqual({
        proofSha256,
        complete: true,
      });
      expect(coordinator.completeIngestionMigration({ proofSha256 }).complete).toBe(true);
      expect(() =>
        coordinator.seedIngestionMigration({ proofSha256: 'b'.repeat(64), dirtyDays: [] }),
      ).toThrow('proof conflict');
    });
  });

  it('durably completes an empty baseline without allocating fact history', async () => {
    await runInDurableObject(host(), (_instance, state) => {
      const first = new AgentDeliveryCoordinator(state, {} as AgentConsumerEnv);
      first.seedIngestionMigration({ proofSha256, dirtyDays: [] });
      first.completeIngestionMigration({ proofSha256 });
      const restarted = new AgentDeliveryCoordinator(state, {} as AgentConsumerEnv);
      expect(restarted.getIngestionMigrationState()).toEqual({ proofSha256, complete: true });
      expect(restarted.getStats({}).lastDeliverySequence).toBe(1);
      expect(state.storage.sql.databaseSize).toBeLessThan(256 * 1024);
    });
  });

  it('freezes legacy writes and exposes read-only pages without rebuild confirmation rows', async () => {
    await runInDurableObject(host(), async (instance, state) => {
      await expect(
        instance.freezeIngestionMigration('bounded-agent-ingestion-v1'),
      ).resolves.toEqual({ migrationId: 'bounded-agent-ingestion-v1' });
      expect(instance.listFrozenFacts('org-1', {})).toMatchObject({ facts: [], nextAfter: null });
      await expect(
        instance.addFacts({
          rows: {
            messages: [],
            tool_events: [],
            file_events: [],
            capability_snapshots: [],
            pull_request_links: [],
            review_unit_attributions: [],
          },
        }),
      ).rejects.toThrow('frozen');
      expect(await state.storage.get('ingestion_migration')).toBe('bounded-agent-ingestion-v1');
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('fences writes before erasing and keeps only a permanent tombstone', async () => {
    await runInDurableObject(host(), async (instance, state) => {
      instance.getIngestionMigrationState();
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data)
         VALUES ('messages', 'identity', 'hash', 1, '{"preserved":true}')`,
      );
      Object.assign(instance, { flushInProgress: true });
      await expect(instance.eraseOrganizationData()).resolves.toEqual({ erased: false });
      await expect(
        instance.addFacts({
          rows: {
            messages: [],
            tool_events: [],
            file_events: [],
            capability_snapshots: [],
            pull_request_links: [],
            review_unit_attributions: [],
          },
        }),
      ).rejects.toThrow('erasure has started');
      Object.assign(instance, { flushInProgress: false });
      await expect(instance.eraseOrganizationData()).resolves.toEqual({ erased: true });
      expect(await state.storage.get('organization_erasure')).toEqual({ state: 'erased' });
      expect([
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_ledger'",
        ),
      ]).toEqual([]);
      await expect(instance.eraseOrganizationData()).resolves.toEqual({ erased: true });
    });
  });
});
