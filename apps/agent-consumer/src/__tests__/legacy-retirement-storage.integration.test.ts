import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { agentAnalyticsDayBounds } from '@trace-flow/utils';
import type { AgentConsumerEnv } from '../context';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import type { LegacyRetirementProof } from '../legacy-retirement';

const env = workerEnv as unknown as AgentConsumerEnv;
const migrationProofSha256 = 'a'.repeat(64);
const verificationSha256 = 'b'.repeat(64);

describe('legacy retirement storage', () => {
  it('rejects deleteAll inside a transaction without deleting legacy storage', async () => {
    const host = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
    await runInDurableObject(host, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE retirement_probe(value TEXT NOT NULL)');
      state.storage.sql.exec("INSERT INTO retirement_probe VALUES ('preserved')");
      await state.storage.put('legacy-key', 'preserved');

      await expect(
        state.storage.transaction(async () => {
          await state.storage.deleteAll();
          await state.storage.put('legacy_retirement', { verificationSha256: 'a'.repeat(64) });
        }),
      ).rejects.toThrow('Cannot call deleteAll() within a transaction');

      expect(
        state.storage.sql.exec<{ value: string }>('SELECT value FROM retirement_probe').one(),
      ).toEqual({ value: 'preserved' });
      await expect(state.storage.get('legacy-key')).resolves.toBe('preserved');
      await expect(state.storage.get('legacy_retirement')).resolves.toBeUndefined();
    });
  });

  it('retires only a quiescent frozen ledger behind the external durable fence', async () => {
    const orgId = `retire-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    await runInDurableObject(batcher, async (instance, state) => {
      instance.getIngestionMigrationState();
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category,fact_id,content_hash,first_seen_at_ms,data,clean_target,legacy_target)
         VALUES ('messages',?,'hash',1,'{}',1,0)`,
        `${orgId}\x1fsession\x1fmessage`,
      );
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
    });
    const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
    await coordinator.seedIngestionMigration({ proofSha256: migrationProofSha256, dirtyDays: [] });
    await coordinator.completeIngestionMigration({ proofSha256: migrationProofSha256 });

    const proof = retirementProof(1);
    await expect(batcher.retireFrozenLedger(orgId, proof)).resolves.toMatchObject({
      ...proof,
      state: 'complete',
    });
    const external = retirementCoordinator(batcher);
    await expect(external.getLegacyRetirement({})).resolves.toMatchObject({
      ...proof,
      state: 'complete',
    });
    await expect(batcher.getIngestionMigrationState()).resolves.toMatchObject({
      migrationId: null,
      retirement: { ...proof, state: 'complete' },
      queuedRows: 0,
    });
    await runInDurableObject(batcher, (instance) =>
      expect(instance.addFacts({ rows: emptyRows() })).rejects.toThrow('retired'),
    );
    await runInDurableObject(batcher, (instance) =>
      expect(instance.freezeIngestionMigration('bounded-agent-ingestion-v1')).rejects.toThrow(
        'retired',
      ),
    );
    await expect(coordinator.getIngestionMigrationState()).resolves.toEqual({
      proofSha256: migrationProofSha256,
      complete: true,
    });
    await expect(batcher.retireFrozenLedger(orgId, proof)).resolves.toMatchObject({
      ...proof,
      state: 'complete',
    });
  });

  it('reconstructs the fence and completes an interrupted empty legacy deletion', async () => {
    const orgId = `resume-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    const external = retirementCoordinator(batcher);
    const proof = retirementProof(7);
    await expect(external.beginLegacyRetirement(proof)).resolves.toEqual({
      ...proof,
      state: 'intent',
      completedAtMs: null,
    });

    await expect(batcher.getIngestionMigrationState()).resolves.toMatchObject({
      migrationId: null,
      retirement: { ...proof, state: 'intent' },
    });
    await runInDurableObject(batcher, (instance) =>
      expect(instance.addFacts({ rows: emptyRows() })).rejects.toThrow('retired'),
    );
    await runInDurableObject(batcher, (instance) =>
      expect(
        instance.retireFrozenLedger(orgId, {
          ...proof,
          verificationSha256: 'c'.repeat(64),
        }),
      ).rejects.toThrow('proof conflict'),
    );
    await expect(batcher.retireFrozenLedger(orgId, proof)).resolves.toMatchObject({
      ...proof,
      state: 'complete',
    });
    await expect(external.getLegacyRetirement({})).resolves.toMatchObject({
      ...proof,
      state: 'complete',
    });
  });

  it('keeps the frozen ledger when a blocked recovery source still needs reconciliation', async () => {
    const orgId = `blocked-${crypto.randomUUID()}`;
    const batcher = env.AGENT_FACT_BATCHER.getByName(`org:${orgId}`);
    await runInDurableObject(batcher, async (instance, state) => {
      instance.getIngestionMigrationState();
      state.storage.sql.exec(
        `INSERT INTO recovery_records
         (kind,state,classification,target,target_key,dedupe_key,payload,outcome,created_at_ms)
         VALUES ('repair','blocked','changed',NULL,NULL,'repair-key','{}','{}',1)`,
      );
      await instance.freezeIngestionMigration('bounded-agent-ingestion-v1');
    });
    const coordinator = env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${orgId}`);
    await coordinator.seedIngestionMigration({ proofSha256: migrationProofSha256, dirtyDays: [] });
    await coordinator.completeIngestionMigration({ proofSha256: migrationProofSha256 });

    await runInDurableObject(batcher, (instance) =>
      expect(instance.retireFrozenLedger(orgId, retirementProof(0))).rejects.toThrow(
        'not quiescent',
      ),
    );
    await expect(retirementCoordinator(batcher).getLegacyRetirement({})).resolves.toBeNull();
    await runInDurableObject(batcher, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_records')
          .one().count,
      ).toBe(1);
    });
  });
});

function retirementProof(frozenFactCount: number): LegacyRetirementProof {
  const { oldestDay, today } = agentAnalyticsDayBounds(Date.now());
  return {
    verificationSha256,
    migrationProofSha256,
    deliverySequence: 1,
    oldestDay,
    todayDay: today,
    frozenFactCount,
  };
}

function retirementCoordinator(batcher: DurableObjectStub<AgentFactBatcherInstance>) {
  return env.AGENT_DELIVERY_COORDINATOR.getByName(`retirement:${batcher.id.toString()}`);
}

function emptyRows() {
  return {
    messages: [],
    tool_events: [],
    file_events: [],
    capability_snapshots: [],
    pull_request_links: [],
    review_unit_attributions: [],
  };
}
