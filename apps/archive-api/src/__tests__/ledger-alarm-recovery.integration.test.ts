import { describe, expect, it } from 'vitest';
import {
  runInDurableObject,
  commitArchiveSession,
  readLedgerSnapshot,
  readPendingIntent,
  runtimeEnv,
  partFor,
  base64,
  exactPrefix,
  observation,
  checkpoint,
  scope,
  envelope,
  newLedger,
} from './ledger.integration.fixtures';
import type {
  ArchiveApiEnv,
  ArchiveSessionLedger,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { wrapKey } from './key-rotation-crypto-fixture';

async function oneRecordRequest(label: string) {
  const currentScope = scope('codex', `${label}-${crypto.randomUUID()}`);
  const record = await observation(
    currentScope.source,
    currentScope.sourceSessionId,
    partFor(currentScope.source),
    `${label}-record`,
    JSON.stringify({ label }),
  );
  const upload = {
    source_session_id: currentScope.sourceSessionId,
    observations: [record],
    checkpoint: await checkpoint(
      currentScope.source,
      currentScope.sourceSessionId,
      partFor(currentScope.source),
      [record],
    ),
    complete_prefix_base64: base64(exactPrefix([record])),
  } satisfies ArchiveUploadRequest;
  return { currentScope, request: await envelope(currentScope, upload) };
}

describe('Archive Session Ledger alarm recovery', () => {
  it('drains a committed budget journal after rotation changes version width', async () => {
    const { currentScope, request } = await oneRecordRequest('commit-response-loss');
    const ledger = newLedger(currentScope);
    const wrappedV9 = await wrapKey(currentScope.orgId, 9);
    const wrappedV10 = await wrapKey(currentScope.orgId, 10);
    const versionedRequest = { ...request, keyVersion: 9, wrappedKey: wrappedV9 };
    const interruptedEnv = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: (orgId: string) => {
          const delegated = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
          return {
            reserveStorage: (input: Parameters<typeof delegated.reserveStorage>[0]) =>
              delegated.reserveStorage(input),
            releaseStorage: (input: Parameters<typeof delegated.releaseStorage>[0]) =>
              delegated.releaseStorage(input),
            commitStorage: async (input: Parameters<typeof delegated.commitStorage>[0]) => {
              await delegated.commitStorage(input);
              throw new Error('commit_response_lost');
            },
          };
        },
      },
    } as unknown as ArchiveApiEnv;

    await expect(
      runInDurableObject(ledger, (_instance, state) =>
        commitArchiveSession(state.storage, interruptedEnv, versionedRequest),
      ),
    ).rejects.toThrow('commit_response_lost');
    const checkpointed = await runInDurableObject(ledger, (_instance, state) => ({
      pending: readPendingIntent(state.storage),
      ledger: readLedgerSnapshot(state.storage),
      journal: [
        ...state.storage.sql.exec<{ bytes: number; key_version: number }>(
          'SELECT bytes, key_version FROM pending_budget_commits ORDER BY object_key',
        ),
      ],
    }));
    expect(checkpointed.pending).toBeNull();
    expect(checkpointed.ledger).toMatchObject({ generation: 1, keyVersion: 9 });
    expect(checkpointed.journal.length).toBeGreaterThan(0);
    expect(checkpointed.journal.every(({ key_version }) => key_version === 9)).toBe(true);

    const custody = new FakeArchiveCustody();
    const custodyFetch = installCustody(custody);
    try {
      custody.versions.set(9, wrappedV9);
      custody.versions.set(10, wrappedV10);
      custody.activeVersion = 10;
      custody.retiringVersion = 9;
      custody.operationId = `rotate:${currentScope.orgId}:9:10`;
      custody.rotationStatus = 'rotating';
      const budget = runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId);
      const landedRows = await runInDurableObject(budget, (_instance, state) => [
        ...state.storage.sql.exec<{ status: string; key_version: number }>(
          'SELECT status, key_version FROM storage_budget_objects',
        ),
      ]);
      expect(
        landedRows.every(({ status, key_version }) => status === 'committed' && key_version === 9),
      ).toBe(true);
      await budget.startKeyRotation({
        orgId: currentScope.orgId,
        operationId: custody.operationId,
        fromVersion: 9,
        toVersion: 10,
        activationId: ACTIVATION_ID,
      });
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'succeeded',
        },
      );
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 9 }),
      ).resolves.toBe(0);

      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      const recovered = await runInDurableObject(ledger, (_instance, state) => ({
        pending: readPendingIntent(state.storage),
        ledger: readLedgerSnapshot(state.storage),
        journalCount: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_budget_commits',
          ),
        ][0]!.count,
      }));
      expect(recovered.pending).toBeNull();
      expect(recovered.ledger).toMatchObject({ generation: 1, keyVersion: 9 });
      expect(recovered.journalCount).toBe(0);
      const rotatedRows = await runInDurableObject(budget, (_instance, state) => [
        ...state.storage.sql.exec<{ bytes: number; key_version: number; status: string }>(
          'SELECT bytes, key_version, status FROM storage_budget_objects ORDER BY object_key',
        ),
      ]);
      expect(
        rotatedRows.every(
          ({ key_version, status }) => key_version === 10 && status === 'committed',
        ),
      ).toBe(true);
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 9 }),
      ).resolves.toBe(0);
      expect(
        rotatedRows.some(({ bytes }, index) => bytes !== checkpointed.journal[index]?.bytes),
      ).toBe(true);
    } finally {
      custodyFetch.mockRestore();
    }
  });
});
