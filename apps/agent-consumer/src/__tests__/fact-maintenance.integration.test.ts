import { env as workerEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { TinybirdRecoveryStore } from '@trace-flow/tinybird-client';
import type * as TinybirdClient from '@trace-flow/tinybird-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentFactMaintenance } from '../fact-maintenance';
import type { AgentFactBatcherInstance } from '../fact-batcher';
import { ROW_IDENTITY_FIELDS, rowIdentity, stableHash } from '../facts';

vi.mock('@trace-flow/tinybird-client', async (importOriginal) => ({
  ...(await importOriginal<typeof TinybirdClient>()),
  insertRows: vi.fn().mockResolvedValue(undefined),
}));

const env = workerEnv as unknown as {
  AGENT_FACT_BATCHER: DurableObjectNamespace<AgentFactBatcherInstance>;
};

const emptyRows = {
  messages: [],
  tool_events: [],
  file_events: [],
  capability_snapshots: [],
  pull_request_links: [],
  review_unit_attributions: [],
};

const originalRow = {
  OrgId: 'org-1',
  session_pk: 'session-1',
  message_pk: 'message-1',
  IngestedAt: '2026-09-10 12:00:00.000',
  content: 'original',
};

const rebuildReason = 'rebuild verified against the cloud snapshot';
const executorId = '11111111-1111-4111-8111-111111111111';
const otherExecutorId = '22222222-2222-4222-8222-222222222222';
const tinybirdTokenFingerprint = '02678c7d0b2ede6174be0b3e990a2a3cd18a45640f35d6ae636f6342acba2e4e';
const tinybirdWorkspaceId = '33333333-3333-4333-8333-333333333333';
const tinybirdHost = 'https://api.us-west-2.aws.tinybird.co';
const tinybirdTarget = { tokenFingerprint: tinybirdTokenFingerprint, host: tinybirdHost };
const proof = {
  backupSha256: 'a'.repeat(64),
  canonicalFingerprint: 'canonical-fingerprint',
  legacyFingerprint: 'legacy-fingerprint',
};

function batch(row: unknown, writeClean = true) {
  return { rows: { ...emptyRows, messages: [row] }, writeClean };
}

describe('agent fact rebuild maintenance', () => {
  let batcher: DurableObjectStub<AgentFactBatcherInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    batcher = env.AGENT_FACT_BATCHER.get(env.AGENT_FACT_BATCHER.newUniqueId());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('persists the lock, resumes the same operation, and rejects a conflicting operation', async () => {
    const targetMismatch = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance) => {
        try {
          await instance.beginFactRebuild('org-1', {
            operationId: 'target-mismatch',
            executorId,
            reason: rebuildReason,
            tinybirdWorkspaceId,
            tinybirdTokenFingerprints: ['b'.repeat(64)],
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    expect(targetMismatch).toBe('fact rebuild Tinybird target does not match');
    await expect(batcher.addFacts(batch(originalRow))).resolves.toMatchObject({
      status: 'accepted',
    });
    const first = await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-1',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });
    expect(first).toMatchObject({
      status: 'quiescent',
      expectedFactCount: 1,
      tinybirdTokenFingerprint,
      tinybirdWorkspaceId,
      tinybirdHost,
    });

    const resumed = await runInDurableObject(
      batcher,
      (_instance: AgentFactBatcherInstance, state) => {
        const recovery = new TinybirdRecoveryStore(state.storage);
        const restartedMaintenance = new AgentFactMaintenance(state.storage, recovery);
        return restartedMaintenance.begin(
          'org-1',
          {
            operationId: 'rebuild-1',
            executorId,
            reason: rebuildReason,
            tinybirdWorkspaceId,
            tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
          },
          tinybirdTarget,
        );
      },
    );
    expect(resumed).toMatchObject({ operationId: 'rebuild-1', completed: false });
    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.beginFactRebuild('org-1', {
          operationId: 'rebuild-1',
          executorId: otherExecutorId,
          reason: rebuildReason,
          tinybirdWorkspaceId,
          tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
        }),
      ),
    ).rejects.toThrow('fact rebuild executor does not match');
    const rotated = await runInDurableObject(batcher, (_instance, state) => {
      const recovery = new TinybirdRecoveryStore(state.storage);
      const restartedMaintenance = new AgentFactMaintenance(state.storage, recovery);
      return restartedMaintenance.begin(
        'org-1',
        {
          operationId: 'rebuild-1',
          executorId,
          reason: rebuildReason,
          tinybirdWorkspaceId,
          tinybirdTokenFingerprints: ['b'.repeat(64)],
        },
        { tokenFingerprint: 'b'.repeat(64), host: tinybirdHost },
      );
    });
    expect(rotated).toMatchObject({ tinybirdTokenFingerprint: 'b'.repeat(64) });
    const resumedTargetMismatch = await runInDurableObject(batcher, (_instance, state) => {
      try {
        const recovery = new TinybirdRecoveryStore(state.storage);
        const restartedMaintenance = new AgentFactMaintenance(state.storage, recovery);
        restartedMaintenance.begin(
          'org-1',
          {
            operationId: 'rebuild-1',
            executorId,
            reason: rebuildReason,
            tinybirdWorkspaceId: '44444444-4444-4444-8444-444444444444',
            tinybirdTokenFingerprints: ['b'.repeat(64)],
          },
          { tokenFingerprint: 'b'.repeat(64), host: tinybirdHost },
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(resumedTargetMismatch).toBe('fact rebuild Tinybird target does not match');
    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.beginFactRebuild('org-1', {
          operationId: 'rebuild-2',
          executorId,
          reason: rebuildReason,
          tinybirdWorkspaceId,
          tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
        }),
      ),
    ).rejects.toThrow('rebuild-1 is already active');

    expect(
      (await batcher.addFacts(batch({ ...originalRow, message_pk: 'message-2' }))).status,
    ).toBe('failed');
    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.reconcileRecovery({
          recoveryId: 1,
          action: 'retain-original',
          reason: rebuildReason,
        }),
      ),
    ).rejects.toThrow('fact rebuild is active');
  });

  it('stages the selected repair, resolves obsolete repair versions, and finalizes pending rows', async () => {
    const changedOnce = { ...originalRow, content: 'changed once' };
    const selected = { ...originalRow, content: 'selected replacement' };
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(batch(originalRow));
      await state.storage.deleteAlarm();
      const rowId = state.storage.sql.exec<{ id: number }>('SELECT id FROM pending_facts').one().id;
      new TinybirdRecoveryStore(state.storage).preserveInsert(
        'agent_message_facts',
        'pending_facts:messages',
        JSON.stringify([originalRow]),
        [rowId],
        'uncertain',
        JSON.stringify({ reason: 'operator must confirm the ambiguous insert' }),
      );
    });
    await batcher.addFacts(batch(changedOnce));
    await batcher.addFacts(batch(selected));
    await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-repairs',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });
    expect(
      await runInDurableObject(
        batcher,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_facts')
            .one().count,
      ),
    ).toBe(1);
    const recovery = await batcher.listRecovery();
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);

    const staged = await batcher.completeFactRebuild({
      phase: 'stage',
      operationId: 'rebuild-repairs',
      executorId,
      reason: rebuildReason,
      confirmations: [
        {
          category: 'messages',
          factId,
          expectedOldHash: stableHash(originalRow),
          newHash: stableHash(selected),
          row: selected,
        },
      ],
      repairRecoveryConfirmations: recovery.records
        .filter((record) => record.kind === 'repair')
        .map((record) => ({
          recoveryId: record.id,
          expectedPayloadHash: stableHash(JSON.parse(record.payload)),
        })),
      insertRecoveryConfirmations: recovery.records
        .filter((record) => record.kind === 'tinybird_insert')
        .map((record) => ({
          recoveryId: record.id,
          expectedPayloadHash: stableHash(JSON.parse(record.payload)),
        })),
    });
    expect(staged).toMatchObject({
      status: 'staged',
      confirmedFactCount: 1,
      resolvedRepairRecords: 2,
      resolvedInsertRecords: 1,
    });
    const resolved = await batcher.listRecovery({ state: 'resolved' });
    expect(resolved.records.map((record) => record.resolution).sort()).toEqual([
      'rebuilt',
      'rebuilt-confirm-written',
      'superseded-by-rebuild',
    ]);

    const completed = await batcher.completeFactRebuild({
      phase: 'finalize',
      operationId: 'rebuild-repairs',
      executorId,
      reason: rebuildReason,
      proof,
    });
    expect(completed).toMatchObject({ status: 'completed', confirmedFactCount: 1 });
    const stored = await runInDurableObject(batcher, (_instance, state) => ({
      ledger: state.storage.sql
        .exec<{
          content_hash: string;
          data: string;
        }>(
          'SELECT content_hash, data FROM fact_ledger WHERE category = ? AND fact_id = ?',
          'messages',
          factId,
        )
        .one(),
      pending: state.storage.sql
        .exec<{ sent_at_ms: number | null }>('SELECT sent_at_ms FROM pending_facts')
        .one(),
    }));
    expect(stored.ledger).toEqual({
      content_hash: stableHash(selected),
      data: JSON.stringify(selected),
    });
    expect(stored.pending.sent_at_ms).not.toBeNull();
    expect((await batcher.addFacts(batch({ ...originalRow, message_pk: 'after' }))).status).toBe(
      'accepted',
    );
  });

  it('requires exact explicit insert evidence before resolving pending recovery', async () => {
    await runInDurableObject(batcher, async (instance: AgentFactBatcherInstance, state) => {
      await instance.addFacts(batch(originalRow));
      await state.storage.deleteAlarm();
      const rowId = state.storage.sql.exec<{ id: number }>('SELECT id FROM pending_facts').one().id;
      new TinybirdRecoveryStore(state.storage).preserveInsert(
        'agent_message_facts',
        'pending_facts:messages',
        JSON.stringify([originalRow]),
        [rowId],
        'uncertain',
        JSON.stringify({ reason: 'operator must confirm the ambiguous insert' }),
      );
    });
    const [record] = (await batcher.listRecovery()).records;
    expect(record).toMatchObject({ kind: 'tinybird_insert', state: 'blocked' });
    await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-insert',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);

    const factConfirmation = {
      category: 'messages' as const,
      factId,
      expectedOldHash: stableHash(originalRow),
      newHash: stableHash(originalRow),
      row: originalRow,
    };
    await batcher.completeFactRebuild({
      phase: 'stage',
      operationId: 'rebuild-insert',
      executorId,
      reason: rebuildReason,
      confirmations: [factConfirmation],
    });
    const repeated = await batcher.completeFactRebuild({
      phase: 'stage',
      operationId: 'rebuild-insert',
      executorId,
      reason: rebuildReason,
      confirmations: [factConfirmation],
    });
    expect(repeated.confirmedFactCount).toBe(1);
    expect(
      await runInDurableObject(
        batcher,
        (_instance, state) =>
          state.storage.sql
            .exec<{
              confirmed_fact_count: number;
            }>('SELECT confirmed_fact_count FROM fact_rebuild_operations')
            .one().confirmed_fact_count,
      ),
    ).toBe(1);

    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.completeFactRebuild({
          phase: 'stage',
          operationId: 'rebuild-insert',
          executorId,
          reason: rebuildReason,
          confirmations: [],
          insertRecoveryConfirmations: [
            { recoveryId: record!.id, expectedPayloadHash: 'incorrect' },
          ],
        }),
      ),
    ).rejects.toThrow('payload hash does not match');

    await batcher.completeFactRebuild({
      phase: 'stage',
      operationId: 'rebuild-insert',
      executorId,
      reason: rebuildReason,
      confirmations: [],
      insertRecoveryConfirmations: [
        { recoveryId: record!.id, expectedPayloadHash: stableHash(JSON.parse(record!.payload)) },
      ],
    });
    expect(await batcher.getRecovery(record!.id)).toMatchObject({
      state: 'resolved',
      resolution: 'rebuilt-confirm-written',
    });
    await expect(
      runInDurableObject(batcher, (instance: AgentFactBatcherInstance) =>
        instance.completeFactRebuild({
          phase: 'finalize',
          operationId: 'rebuild-insert',
          executorId,
          reason: rebuildReason,
          proof: { ...proof, backupSha256: 'wrong' },
        }),
      ),
    ).rejects.toThrow('backup SHA-256 proof is invalid');
    await expect(
      batcher.completeFactRebuild({
        phase: 'finalize',
        operationId: 'rebuild-insert',
        executorId,
        reason: rebuildReason,
        proof,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('refuses to lock until replay hydrates a missing ledger payload', async () => {
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES ('messages', ?, ?, 0, '', 1, 0)`,
        factId,
        stableHash(originalRow),
      );
    });
    const beginError = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance) => {
        try {
          await instance.beginFactRebuild('org-1', {
            operationId: 'rebuild-missing-payload',
            executorId,
            reason: rebuildReason,
            tinybirdWorkspaceId,
            tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    expect(beginError).toContain('replay the collector before beginning maintenance');
    const unlocked = await runInDurableObject(batcher, (_instance, state) => ({
      operations: state.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_rebuild_operations')
        .one().count,
      queryPlan: [
        ...state.storage.sql.exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT 1 FROM fact_ledger AS ledger
           WHERE (ledger.data IS NULL OR ledger.data = '')
             AND NOT EXISTS (
               SELECT 1 FROM fact_ledger_payload_chunks AS chunks
               WHERE chunks.category = ledger.category AND chunks.fact_id = ledger.fact_id
             )
           LIMIT 1`,
        ),
      ].map((row) => row.detail),
    }));
    expect(unlocked.operations).toBe(0);
    expect(unlocked.queryPlan.join('\n')).toContain('idx_fact_ledger_missing_payload');

    await expect(batcher.addFacts(batch(originalRow))).resolves.toMatchObject({
      status: 'accepted',
      duplicateRows: 1,
    });
    await expect(
      batcher.beginFactRebuild('org-1', {
        operationId: 'rebuild-missing-payload',
        executorId,
        reason: rebuildReason,
        tinybirdWorkspaceId,
        tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
      }),
    ).resolves.toMatchObject({ status: 'quiescent' });
  });

  it('exports the latest validated repair separately when the old ledger payload is missing', async () => {
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);
    const firstReplacement = { ...originalRow, content: 'first changed replay' };
    const latestReplacement = { ...originalRow, content: 'latest changed replay' };
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES ('messages', ?, ?, 0, '', 1, 0)`,
        factId,
        stableHash(originalRow),
      );
    });
    await expect(batcher.addFacts(batch(firstReplacement))).resolves.toMatchObject({
      status: 'accepted',
      repairRows: 1,
    });
    await expect(batcher.addFacts(batch(latestReplacement))).resolves.toMatchObject({
      status: 'accepted',
      repairRows: 1,
    });
    const blocked = await batcher.listRecovery({ state: 'blocked' });
    const latestRecovery = blocked.records.at(-1)!;

    await expect(
      batcher.beginFactRebuild('org-1', {
        operationId: 'rebuild-replacement',
        executorId,
        reason: rebuildReason,
        tinybirdWorkspaceId,
        tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
      }),
    ).resolves.toMatchObject({ status: 'quiescent', expectedFactCount: 1 });
    const page = await batcher.listRebuildFacts({
      operationId: 'rebuild-replacement',
      executorId,
    });
    expect(page.facts).toEqual([
      expect.objectContaining({
        category: 'messages',
        factId,
        contentHash: stableHash(originalRow),
        payload: null,
        missingPayload: true,
        replacement: {
          contentHash: stableHash(latestReplacement),
          payload: JSON.stringify(latestReplacement),
          recoveryId: latestRecovery.id,
        },
      }),
    ]);
    const ledgerHash = await runInDurableObject(
      batcher,
      (_instance, state) =>
        state.storage.sql
          .exec<{
            content_hash: string;
          }>(
            'SELECT content_hash FROM fact_ledger WHERE category = ? AND fact_id = ?',
            'messages',
            factId,
          )
          .one().content_hash,
    );
    expect(ledgerHash).toBe(stableHash(originalRow));
  });

  it('does not accept a resolved repair as a missing-payload replacement', async () => {
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);
    const replacement = { ...originalRow, content: 'resolved replacement' };
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO fact_ledger
         (category, fact_id, content_hash, first_seen_at_ms, data, clean_target, legacy_target)
         VALUES ('messages', ?, ?, 0, '', 1, 0)`,
        factId,
        stableHash(originalRow),
      );
    });
    await batcher.addFacts(batch(replacement));
    await runInDurableObject(batcher, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE recovery_records SET state = 'resolved', resolved_at_ms = 1,
         resolution = 'retain-original', resolution_reason = 'test' WHERE kind = 'repair'`,
      );
    });
    const beginError = await runInDurableObject(
      batcher,
      async (instance: AgentFactBatcherInstance) => {
        try {
          await instance.beginFactRebuild('org-1', {
            operationId: 'rebuild-resolved-replacement',
            executorId,
            reason: rebuildReason,
            tinybirdWorkspaceId,
            tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    expect(beginError).toContain('replay the collector before beginning maintenance');
    expect(
      await runInDurableObject(
        batcher,
        (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>('SELECT COUNT(*) AS count FROM fact_rebuild_operations')
            .one().count,
      ),
    ).toBe(0);
  });

  it('stores an oversized confirmation by exact digest and resumes it idempotently', async () => {
    const oversizedRow = { ...originalRow, content: 'x'.repeat(2_100_000) };
    const factId = rowIdentity(oversizedRow, ROW_IDENTITY_FIELDS.messages);
    await runInDurableObject(batcher, async (instance, state) => {
      await instance.addFacts(batch(oversizedRow));
      await state.storage.deleteAlarm();
    });
    await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-oversized-confirmation',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });
    const confirmation = {
      category: 'messages' as const,
      factId,
      expectedOldHash: stableHash(oversizedRow),
      newHash: stableHash(oversizedRow),
      row: oversizedRow,
    };
    await expect(
      batcher.completeFactRebuild({
        phase: 'stage',
        operationId: 'rebuild-oversized-confirmation',
        executorId,
        reason: rebuildReason,
        confirmations: [confirmation],
      }),
    ).resolves.toMatchObject({ status: 'staged', confirmedFactCount: 1 });
    await expect(
      batcher.completeFactRebuild({
        phase: 'stage',
        operationId: 'rebuild-oversized-confirmation',
        executorId,
        reason: rebuildReason,
        confirmations: [confirmation],
      }),
    ).resolves.toMatchObject({ status: 'staged', confirmedFactCount: 1 });
    const stored = await runInDurableObject(batcher, (_instance, state) => ({
      confirmation: state.storage.sql
        .exec<{
          row_sha256: string;
        }>(
          'SELECT row_sha256 FROM fact_rebuild_confirmations WHERE operation_id = ?',
          'rebuild-oversized-confirmation',
        )
        .one(),
      ledgerChunks: state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM fact_ledger_payload_chunks
           WHERE category = 'messages' AND fact_id = ?`,
          factId,
        )
        .one().count,
    }));
    expect(stored.confirmation.row_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.ledgerChunks).toBeGreaterThan(1);
    await expect(
      batcher.completeFactRebuild({
        phase: 'finalize',
        operationId: 'rebuild-oversized-confirmation',
        executorId,
        reason: rebuildReason,
        proof,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps the begin reason immutable and revalidates concurrent confirmation stages', async () => {
    await batcher.addFacts(batch(originalRow));
    await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-concurrent-stage',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });
    const factId = rowIdentity(originalRow, ROW_IDENTITY_FIELDS.messages);
    const changedRow = { ...originalRow, content: 'changed concurrently' };
    const confirmation = (row: typeof originalRow) => ({
      category: 'messages' as const,
      factId,
      expectedOldHash: stableHash(originalRow),
      newHash: stableHash(row),
      row,
    });
    const wrongStageReason = await runInDurableObject(batcher, async (_instance, state) => {
      try {
        await new AgentFactMaintenance(
          state.storage,
          new TinybirdRecoveryStore(state.storage),
        ).complete({
          phase: 'stage',
          operationId: 'rebuild-concurrent-stage',
          executorId,
          reason: 'different audit reason',
          confirmations: [confirmation(originalRow)],
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(wrongStageReason).toBe('fact rebuild reason does not match');

    const stageStatuses = await runInDurableObject(batcher, async (_instance, state) => {
      const maintenance = new AgentFactMaintenance(
        state.storage,
        new TinybirdRecoveryStore(state.storage),
      );
      const results = await Promise.allSettled(
        [originalRow, changedRow].map((row) =>
          maintenance.complete({
            phase: 'stage',
            operationId: 'rebuild-concurrent-stage',
            executorId,
            reason: rebuildReason,
            confirmations: [confirmation(row)],
          }),
        ),
      );
      return results.map((result) => result.status).sort();
    });
    expect(stageStatuses).toEqual(['fulfilled', 'rejected']);
    expect(
      await runInDurableObject(
        batcher,
        (_instance, state) =>
          state.storage.sql
            .exec<{
              confirmed_fact_count: number;
            }>('SELECT confirmed_fact_count FROM fact_rebuild_operations')
            .one().confirmed_fact_count,
      ),
    ).toBe(1);

    const wrongFinalizeReason = await runInDurableObject(batcher, async (_instance, state) => {
      try {
        await new AgentFactMaintenance(
          state.storage,
          new TinybirdRecoveryStore(state.storage),
        ).complete({
          phase: 'finalize',
          operationId: 'rebuild-concurrent-stage',
          executorId,
          reason: 'different audit reason',
          proof,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(wrongFinalizeReason).toBe('fact rebuild reason does not match');
    await expect(
      batcher.completeFactRebuild({
        phase: 'finalize',
        operationId: 'rebuild-concurrent-stage',
        executorId,
        reason: rebuildReason,
        proof,
      }),
    ).resolves.toMatchObject({ status: 'completed', confirmedFactCount: 1 });
  });

  it('paginates 100 rows in stable order and returns one oversized fact without truncation', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...originalRow,
      message_pk: `message-${index.toString().padStart(3, '0')}`,
      content: index === 0 ? 'x'.repeat(950_000) : `content-${index}`,
    }));
    const firstFactId = rowIdentity(rows[0], ROW_IDENTITY_FIELDS.messages);
    const duplicateRows = await runInDurableObject(batcher, async (instance, state) => {
      await instance.addFacts({ rows: { ...emptyRows, messages: rows } });
      await state.storage.deleteAlarm();
      state.storage.sql.exec(
        `UPDATE fact_ledger SET data = '' WHERE category = 'messages' AND fact_id = ?`,
        firstFactId,
      );
      state.storage.sql.exec(
        `DELETE FROM fact_ledger_payload_chunks WHERE category = 'messages' AND fact_id = ?`,
        firstFactId,
      );
      const duplicate = await instance.addFacts(batch(rows[0]));
      await state.storage.deleteAlarm();
      return duplicate.duplicateRows;
    });
    expect(duplicateRows).toBe(1);
    await batcher.beginFactRebuild('org-1', {
      operationId: 'rebuild-pages',
      executorId,
      reason: rebuildReason,
      tinybirdWorkspaceId,
      tinybirdTokenFingerprints: [tinybirdTokenFingerprint],
    });

    const first = await batcher.listRebuildFacts({ operationId: 'rebuild-pages', executorId });
    expect(first.facts).toHaveLength(1);
    expect(first.facts[0]?.factId).toBe(firstFactId);
    expect(first.facts[0]?.payload).toBe(JSON.stringify(rows[0]));
    expect(first.facts[0]?.missingPayload).toBe(false);
    expect(first.serializedBytes).toBeGreaterThan(900_000);
    expect(first.nextAfter).toEqual({ category: 'messages', factId: firstFactId });

    const second = await batcher.listRebuildFacts({
      operationId: 'rebuild-pages',
      executorId,
      after: first.nextAfter!,
    });
    expect(second.facts).toHaveLength(100);
    expect(second.nextAfter).toBeNull();
  });
});
