import { describe, expect, it } from 'vitest';
import {
  archiveKey,
  base64,
  call,
  checkpoint,
  commitArchiveSession,
  envelope,
  exactPrefix,
  newLedger,
  observation,
  partFor,
  readLedgerSnapshot,
  runInDurableObject,
  runtimeEnv,
  scope,
} from './ledger.integration.fixtures';
import type {
  ArchiveApiEnv,
  ArchiveSessionLedger,
  ArchiveUploadRequest,
} from './ledger.integration.fixtures';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { wrapKey } from './key-rotation-crypto-fixture';

async function requestFor(label: string) {
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

async function failBeforeBudgetCommit(label: string) {
  const { currentScope, request } = await requestFor(label);
  const ledger = newLedger(currentScope);
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
          commitStorage: async () => {
            throw new Error('before_budget_commit');
          },
        };
      },
    },
  } as unknown as ArchiveApiEnv;
  await expect(
    runInDurableObject(ledger, (_instance, state) =>
      commitArchiveSession(state.storage, interruptedEnv, request),
    ),
  ).rejects.toThrow('before_budget_commit');
  return {
    currentScope,
    request,
    ledger,
    budget: runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId),
  };
}

async function failBeforeLedgerCheckpoint(label: string) {
  const { currentScope, request } = await requestFor(label);
  const ledger = newLedger(currentScope);
  let puts = 0;
  const interruptedBucket = {
    get: runtimeEnv.ARCHIVE_STORAGE.get.bind(runtimeEnv.ARCHIVE_STORAGE),
    head: runtimeEnv.ARCHIVE_STORAGE.head.bind(runtimeEnv.ARCHIVE_STORAGE),
    put: async (key: string, body: string, options?: R2PutOptions) => {
      puts += 1;
      if (puts === 2) throw new Error('before_ledger_checkpoint');
      return runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
    },
  } as unknown as R2Bucket;
  await expect(
    runInDurableObject(ledger, (_instance, state) =>
      commitArchiveSession(
        state.storage,
        { ...runtimeEnv, ARCHIVE_STORAGE: interruptedBucket } as ArchiveApiEnv,
        request,
      ),
    ),
  ).rejects.toThrow('before_ledger_checkpoint');
  return { currentScope, ledger, budget: runtimeEnv.STORAGE_BUDGET.getByName(currentScope.orgId) };
}

async function reconcileAll(orgId: string) {
  const budget = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
  let result = await budget.reconcileArchiveInventory({ orgId, limit: 1000 });
  while (!result.complete) result = await budget.reconcileArchiveInventory({ orgId, limit: 1000 });
  return result;
}

describe('Archive Session Ledger budget commit journal', () => {
  it('checkpoints and journals before a failed budget commit, then recovers and completes rotation', async () => {
    const { currentScope, ledger, budget } = await failBeforeBudgetCommit('before-commit');
    const local = await runInDurableObject(ledger, (_instance, state) => ({
      checkpoint: readLedgerSnapshot(state.storage),
      journalCount: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_budget_commits',
        ),
      ][0]!.count,
    }));
    expect(local.checkpoint.generation).toBe(1);
    expect(local.journalCount).toBeGreaterThan(0);
    await expect(budget.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject({
      committedBytes: 0,
    });

    const custody = new FakeArchiveCustody();
    const custodyFetch = installCustody(custody);
    try {
      custody.versions.set(1, await archiveKey(currentScope.orgId));
      custody.versions.set(2, await wrapKey(currentScope.orgId, 2));
      custody.activeVersion = 2;
      custody.retiringVersion = 1;
      custody.operationId = `rotate:${currentScope.orgId}:1:2`;
      custody.rotationStatus = 'rotating';
      await budget.startKeyRotation({
        orgId: currentScope.orgId,
        operationId: custody.operationId,
        fromVersion: 1,
        toVersion: 2,
        activationId: ACTIVATION_ID,
      });
      await expect(budget.advanceKeyRotation({ orgId: currentScope.orgId })).resolves.toMatchObject(
        {
          status: 'rotating',
          remainingReferences: expect.any(Number),
        },
      );
      expect(custody.destroyCalls).toEqual([]);

      await runInDurableObject(ledger, (instance: ArchiveSessionLedger) => instance.alarm());
      const recovered = await runInDurableObject(ledger, (_instance, state) => ({
        journalCount: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM pending_budget_commits',
          ),
        ][0]!.count,
      }));
      expect(recovered.journalCount).toBe(0);
      await expect(budget.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject({
        reservedBytes: 0,
        committedBytes: expect.any(Number),
      });
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
      ).resolves.toBeGreaterThan(0);

      let rotation = await budget.advanceKeyRotation({ orgId: currentScope.orgId });
      while (rotation.status === 'rotating') {
        rotation = await budget.advanceKeyRotation({ orgId: currentScope.orgId });
      }
      expect(rotation.status).toBe('succeeded');
      await expect(
        budget.countKeyVersionReferences({ orgId: currentScope.orgId, keyVersion: 1 }),
      ).resolves.toBe(0);
      expect(custody.destroyCalls).toEqual([
        {
          keyVersion: 1,
          liveReferenceCount: 0,
          operationId: custody.operationId,
        },
      ]);
    } finally {
      custodyFetch.mockRestore();
    }
  });

  it('keeps reserved rows and cap totals unchanged before the ledger checkpoint', async () => {
    const { currentScope, ledger, budget } = await failBeforeLedgerCheckpoint('reconcile-reserved');
    await expect(
      runInDurableObject(ledger, (_instance, state) => readLedgerSnapshot(state.storage)),
    ).resolves.toMatchObject({ generation: 0 });
    const before = await budget.getStorageBudget({ orgId: currentScope.orgId });
    expect(before.reservedBytes).toBeGreaterThan(0);
    await reconcileAll(currentScope.orgId);
    const after = await budget.getStorageBudget({ orgId: currentScope.orgId });
    expect(after).toMatchObject({
      reservedBytes: before.reservedBytes,
      committedBytes: before.committedBytes,
      availableBytes: before.availableBytes,
    });
    const rows = await runInDurableObject(budget, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string; key_version: number }>(
        'SELECT status, key_version FROM storage_budget_objects',
      ),
    ]);
    expect(
      rows.every(({ status, key_version }) => status === 'reserved' && key_version === 1),
    ).toBe(true);
  });

  it('drains journal accounting before a duplicate client acknowledgement', async () => {
    const { currentScope, request, ledger, budget } = await failBeforeBudgetCommit('client-retry');
    const retry = await call(ledger, request);
    expect(retry.response.status).toBe(200);
    expect(retry.body).toMatchObject({ generation: 1 });
    const local = await runInDurableObject(ledger, (_instance, state) => ({
      checkpoint: readLedgerSnapshot(state.storage),
      elementCount: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM ledger_elements',
        ),
      ][0]!.count,
      journalCount: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM pending_budget_commits',
        ),
      ][0]!.count,
    }));
    expect(local.checkpoint.generation).toBe(1);
    expect(local.elementCount).toBe(local.checkpoint.elementCount);
    expect(local.journalCount).toBe(0);
    await expect(budget.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject({
      reservedBytes: 0,
      committedBytes: expect.any(Number),
    });
  });

  it('backfills legacy provenance without promoting a reserved row', async () => {
    const { currentScope, budget } = await failBeforeBudgetCommit('legacy-provenance');
    const before = await budget.getStorageBudget({ orgId: currentScope.orgId });
    await runInDurableObject(budget, (_instance, state) => {
      state.storage.sql.exec('UPDATE storage_budget_objects SET key_version = NULL');
    });
    await reconcileAll(currentScope.orgId);
    const rows = await runInDurableObject(budget, (_instance, state) => [
      ...state.storage.sql.exec<{ status: string; key_version: number }>(
        'SELECT status, key_version FROM storage_budget_objects',
      ),
    ]);
    expect(
      rows.every(({ status, key_version }) => status === 'reserved' && key_version === 1),
    ).toBe(true);
    await expect(budget.getStorageBudget({ orgId: currentScope.orgId })).resolves.toMatchObject({
      reservedBytes: before.reservedBytes,
      committedBytes: before.committedBytes,
      availableBytes: before.availableBytes,
    });
  });
});
