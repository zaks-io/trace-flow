import { describe, expect, it, vi } from 'vitest';
import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import {
  ARCHIVE_STORAGE_CAP_BYTES,
  type StorageBudget,
  type StorageBudgetObject,
} from '../archive-storage-budget';
import type { ArchiveApiEnv } from '../context';
import { verifyOrPutImmutableObject } from '../archive-r2';
import { verifyObjectsAndReleaseDefinitivelyUnwritten } from '../archive-ledger-intent-recovery';
import { archiveObjectKey, archiveOrganizationPrefix } from '../archive-storage-key';
import type { ArchiveScope } from '../archive-contract';
import { reconcileBudgetInventoryPage } from '../archive-storage-budget-reconciliation';
import { reserveBudgetStorage } from '../archive-storage-budget-ledger';

const runtimeEnv = workerEnv as unknown as Pick<
  ArchiveApiEnv,
  'ARCHIVE_STORAGE' | 'STORAGE_BUDGET'
>;

function budget(orgId: string): DurableObjectStub<StorageBudget> {
  return runtimeEnv.STORAGE_BUDGET.getByName(orgId);
}

function object(
  objectKey: string,
  bytes: number,
  objectClass: StorageBudgetObject['objectClass'] = 'agent_archive_chunk',
): StorageBudgetObject {
  return { objectKey, objectClass, bytes, expiresAt: null };
}

function scope(orgId: string): ArchiveScope {
  return {
    orgId,
    userId: `user-${crypto.randomUUID()}`,
    contributionId: `contribution-${crypto.randomUUID()}`,
    source: 'claude',
    sourceSessionId: `session-${crypto.randomUUID()}`,
  };
}

async function inventoryKeys(currentScope: ArchiveScope): Promise<string[]> {
  return [
    await archiveObjectKey(currentScope, 'chunks', `sha256:${'a'.repeat(64)}`),
    await archiveObjectKey(currentScope, 'manifests', `sha256:${'b'.repeat(64)}`),
    await archiveObjectKey(currentScope, 'chunks', `sha256:${'c'.repeat(64)}`),
  ];
}

async function finishReconciliation(stub: DurableObjectStub<StorageBudget>, orgId: string) {
  let result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  while (!result.complete) {
    result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  }
}

describe('StorageBudget Durable Object', () => {
  it('serializes concurrent reservations at the exact cap boundary', async () => {
    const orgId = `budget-boundary-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const nearlyFull = object(`budget/${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 1);
    await expect(stub.reserveStorage({ orgId, objects: [nearlyFull] })).resolves.toMatchObject({
      accepted: true,
    });
    await stub.commitStorage({ orgId, objects: [nearlyFull] });

    const [first, second] = await Promise.all([
      stub.reserveStorage({ orgId, objects: [object(`budget/${crypto.randomUUID()}`, 1)] }),
      stub.reserveStorage({ orgId, objects: [object(`budget/${crypto.randomUUID()}`, 1)] }),
    ]);
    expect([first.accepted, second.accepted].sort()).toEqual([false, true]);
    const snapshot = await stub.getStorageBudget({ orgId });
    expect(snapshot.committedBytes + snapshot.reservedBytes).toBe(ARCHIVE_STORAGE_CAP_BYTES);
    expect(snapshot.availableBytes).toBe(0);
    const outbox = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({ lifecycle: 'blocked' });
  });

  it('keeps organizations isolated and duplicate reserve/commit idempotent', async () => {
    const firstOrg = `budget-org-a-${crypto.randomUUID()}`;
    const secondOrg = `budget-org-b-${crypto.randomUUID()}`;
    const firstStub = budget(firstOrg);
    const secondStub = budget(secondOrg);
    const firstObject = object(`budget/${crypto.randomUUID()}`, 17);

    await expect(
      firstStub.reserveStorage({ orgId: firstOrg, objects: [firstObject] }),
    ).resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(
      firstStub.reserveStorage({ orgId: firstOrg, objects: [firstObject] }),
    ).resolves.toMatchObject({ accepted: true, duplicate: true });
    await firstStub.commitStorage({ orgId: firstOrg, objects: [firstObject] });
    await firstStub.commitStorage({ orgId: firstOrg, objects: [firstObject] });

    const mismatch = await runInDurableObject(firstStub, async (instance: StorageBudget) => {
      try {
        await instance.reserveStorage({
          orgId: firstOrg,
          objects: [object(firstObject.objectKey, 18)],
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(mismatch).toBe('storage_object_metadata_mismatch');
    await expect(secondStub.getStorageBudget({ orgId: secondOrg })).resolves.toMatchObject({
      committedBytes: 0,
      reservedBytes: 0,
      availableBytes: ARCHIVE_STORAGE_CAP_BYTES,
    });
    await expect(firstStub.getStorageBudget({ orgId: firstOrg })).resolves.toMatchObject({
      committedBytes: 17,
      reservedBytes: 0,
    });
  });

  it('releases only reserved bytes and retains committed capacity', async () => {
    const orgId = `budget-release-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const reserved = object(`budget/${crypto.randomUUID()}`, 31);
    const committed = object(`budget/${crypto.randomUUID()}`, 47);
    await stub.reserveStorage({ orgId, objects: [reserved] });
    await stub.releaseStorage({ orgId, objects: [reserved] });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 0,
      committedBytes: 0,
    });

    await stub.reserveStorage({ orgId, objects: [committed] });
    await stub.commitStorage({ orgId, objects: [committed] });
    await stub.releaseStorage({ orgId, objects: [committed] });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 0,
      committedBytes: 47,
    });
  });

  it('counts existing exact R2 objects once and meters UTF-8 payload bytes', async () => {
    const orgId = `budget-existing-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const objectKey = `budget/${crypto.randomUUID()}`;
    const body = 'é archive';
    await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body);
    const bytes = new TextEncoder().encode(body).byteLength;
    const existing = object(objectKey, bytes, 'agent_archive_manifest');

    await expect(stub.reserveStorage({ orgId, objects: [existing] })).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    });
    await stub.commitStorage({ orgId, objects: [existing] });
    await stub.reserveStorage({ orgId, objects: [existing] });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: bytes,
      reservedBytes: 0,
      byClass: {
        agent_archive_manifest: { committedBytes: bytes, reservedBytes: 0 },
      },
    });
  });

  it('charges newly discovered existing bytes before rejecting an over-cap plan', async () => {
    const currentScope = scope(`budget-rejection-discovery-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const filler = object(`budget/filler-${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 10);
    await stub.reserveStorage({ orgId, objects: [filler] });
    await stub.commitStorage({ orgId, objects: [filler] });

    const existingKey = await archiveObjectKey(
      currentScope,
      'manifests',
      `sha256:${'d'.repeat(64)}`,
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(existingKey, '12345678');
    const existing = object(existingKey, 8, 'agent_archive_manifest');
    const rejected = await stub.reserveStorage({
      orgId,
      objects: [existing, object(`budget/new-${crypto.randomUUID()}`, 3)],
    });
    expect(rejected).toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
    expect(rejected.snapshot).toMatchObject({ committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 2 });

    const unrelated = await stub.reserveStorage({
      orgId,
      objects: [object(`budget/unrelated-${crypto.randomUUID()}`, 10)],
    });
    expect(unrelated).toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
    expect((await stub.getStorageBudget({ orgId })).committedBytes).toBe(
      ARCHIVE_STORAGE_CAP_BYTES - 2,
    );
  });

  it('charges completed HEAD discoveries before a later HEAD failure escapes', async () => {
    const currentScope = scope(`budget-head-failure-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const filler = object(`budget/filler-${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 10);
    await stub.reserveStorage({ orgId, objects: [filler] });
    await stub.commitStorage({ orgId, objects: [filler] });

    const discoveredKey = await archiveObjectKey(
      currentScope,
      'manifests',
      `sha256:${'e'.repeat(64)}`,
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(discoveredKey, '12345678');
    const discovered = object(discoveredKey, 8, 'agent_archive_manifest');
    const failedProbe = object(
      await archiveObjectKey(currentScope, 'chunks', `sha256:${'9'.repeat(64)}`),
      1,
    );
    const throwingBucket = {
      head: async (key: string) => {
        if (key === failedProbe.objectKey) throw new Error('head_failed');
        return runtimeEnv.ARCHIVE_STORAGE.head(key);
      },
    } as unknown as R2Bucket;

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        reserveBudgetStorage(
          state.storage,
          { ARCHIVE_STORAGE: throwingBucket },
          { orgId, objects: [discovered, failedProbe] },
        ),
      ),
    ).rejects.toThrow('head_failed');
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 2,
      reservedBytes: 0,
    });

    await expect(
      stub.reserveStorage({
        orgId,
        objects: [object(`budget/post-head-failure-${crypto.randomUUID()}`, 3)],
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
  });

  it('retains a reservation after a PUT-then-throw and an ambiguous budget commit', async () => {
    const orgId = `budget-ambiguous-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const objectKey = `budget/${crypto.randomUUID()}`;
    const planned = object(objectKey, 13);
    await stub.reserveStorage({ orgId, objects: [planned] });

    const throwingBucket = {
      get: (key: string) => runtimeEnv.ARCHIVE_STORAGE.get(key),
      put: async (key: string, body: string, options?: R2PutOptions) => {
        await runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
        throw new Error('put_result_ambiguous');
      },
    } as unknown as R2Bucket;
    await expect(
      verifyOrPutImmutableObject(throwingBucket, {
        key: objectKey,
        body: 'payload-bytes',
        objectClass: 'chunk',
      }),
    ).rejects.toThrow('put_result_ambiguous');
    expect(await runtimeEnv.ARCHIVE_STORAGE.head(objectKey)).not.toBeNull();
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 13,
      committedBytes: 0,
    });

    const ambiguousCommit = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.commitStorage({ orgId, objects: [planned] });
        throw new Error('commit_result_ambiguous');
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(ambiguousCommit).toBe('commit_result_ambiguous');
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 0,
      committedBytes: 13,
    });
    await stub.commitStorage({ orgId, objects: [planned] });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({ committedBytes: 13 });
  });

  it('releases pre-PUT failures but retains attempted and ambiguous objects', async () => {
    const orgId = `budget-write-outcomes-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const prePut = [
      object(`budget/pre-put-a-${crypto.randomUUID()}`, 5),
      object(`budget/pre-put-b-${crypto.randomUUID()}`, 7),
    ];
    await stub.reserveStorage({ orgId, objects: prePut });
    let putCalls = 0;
    const prePutFailure = {
      get: async () => {
        throw new Error('read_before_put_failed');
      },
      head: async () => null,
      put: async () => {
        putCalls += 1;
      },
    } as unknown as R2Bucket;
    await expect(
      verifyObjectsAndReleaseDefinitivelyUnwritten(
        prePutFailure,
        prePut.map((planned, index) => ({
          key: planned.objectKey,
          body: String(index).repeat(planned.bytes),
          objectClass: 'chunk' as const,
        })),
        (unwritten) =>
          stub.releaseStorage({
            orgId,
            objects: unwritten.map((item) => object(item.key, item.body.length)),
          }),
      ),
    ).rejects.toThrow('read_before_put_failed');
    expect(putCalls).toBe(0);
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 0,
      committedBytes: 0,
    });

    const attempted = [
      object(`budget/partial-a-${crypto.randomUUID()}`, 5),
      object(`budget/partial-b-${crypto.randomUUID()}`, 7),
      object(`budget/partial-c-${crypto.randomUUID()}`, 9),
      object(`budget/partial-d-${crypto.randomUUID()}`, 11),
    ];
    await stub.reserveStorage({ orgId, objects: attempted });
    const partialBucket = {
      get: (key: string) => runtimeEnv.ARCHIVE_STORAGE.get(key),
      head: (key: string) => runtimeEnv.ARCHIVE_STORAGE.head(key),
      put: async (key: string, body: string, options?: R2PutOptions) => {
        await runtimeEnv.ARCHIVE_STORAGE.put(key, body, options);
        if (key === attempted[1]!.objectKey) throw new Error('partial_put_ambiguous');
      },
    } as unknown as R2Bucket;
    await runtimeEnv.ARCHIVE_STORAGE.put(attempted[2]!.objectKey, 'c'.repeat(attempted[2]!.bytes));
    const planned = attempted.map((item, index) => ({
      key: item.objectKey,
      body: String.fromCharCode(97 + index).repeat(item.bytes),
      objectClass: 'chunk' as const,
    }));
    await expect(
      verifyObjectsAndReleaseDefinitivelyUnwritten(partialBucket, planned, (unwritten) =>
        stub.releaseStorage({
          orgId,
          objects: unwritten.map((item) => object(item.key, item.body.length)),
        }),
      ),
    ).rejects.toThrow('partial_put_ambiguous');
    expect(await runtimeEnv.ARCHIVE_STORAGE.head(attempted[0]!.objectKey)).not.toBeNull();
    expect(await runtimeEnv.ARCHIVE_STORAGE.head(attempted[1]!.objectKey)).not.toBeNull();
    expect(await runtimeEnv.ARCHIVE_STORAGE.head(attempted[2]!.objectKey)).not.toBeNull();
    expect(await runtimeEnv.ARCHIVE_STORAGE.head(attempted[3]!.objectKey)).toBeNull();
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 21,
      committedBytes: 0,
    });
  });

  it('publishes final-page reconciliation discoveries to the status outbox', async () => {
    const currentScope = scope(`budget-reconcile-status-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const key = await archiveObjectKey(currentScope, 'chunks', `sha256:${'a'.repeat(64)}`);
    await runtimeEnv.ARCHIVE_STORAGE.put(key, 'final-page');

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toMatchObject({
      complete: false,
    });
    await finishReconciliation(stub, orgId);
    const outbox = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      orgId,
      storedBytes: new TextEncoder().encode('final-page').byteLength,
      lifecycle: 'active',
    });
  });

  it('keeps a reconciliation charge visible before a truncated inventory completes', async () => {
    const currentScope = scope(`budget-reconcile-admission-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const key = await archiveObjectKey(currentScope, 'chunks', `sha256:${'e'.repeat(64)}`);
    await runtimeEnv.ARCHIVE_STORAGE.put(key, '12345678');
    const secondKey = await archiveObjectKey(currentScope, 'manifests', `sha256:${'f'.repeat(64)}`);
    await runtimeEnv.ARCHIVE_STORAGE.put(secondKey, 'second');

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1 })).resolves.toMatchObject({
      complete: false,
    });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({ committedBytes: 8 });
    await expect(
      stub.reserveStorage({
        orgId,
        objects: [object(`budget/too-large-${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 7)],
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
  });

  it('charges valid discoveries and blocks admission when a reconciliation page is unsafe', async () => {
    const currentScope = scope(`budget-reconcile-unsafe-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const filler = object(`budget/filler-${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 10);
    await stub.reserveStorage({ orgId, objects: [filler] });
    await stub.commitStorage({ orgId, objects: [filler] });

    const prefix = await archiveOrganizationPrefix(orgId);
    const discoveredKey = await archiveObjectKey(
      currentScope,
      'manifests',
      `sha256:${'f'.repeat(64)}`,
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(discoveredKey, '12345678');
    await runtimeEnv.ARCHIVE_STORAGE.put(`${prefix}/unknown`, 'unknown');

    const reconciliationError = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.reconcileArchiveInventory({ orgId, limit: 1000 });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(reconciliationError).toBe('storage_budget_unknown_object_path');
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 2,
      reservedBytes: 0,
    });
    const failure = await runInDurableObject(stub, (_instance, state) => ({
      guard: [
        ...state.storage.sql.exec<{ reason: string }>(
          'SELECT reason FROM storage_budget_admission_guard WHERE id = 1',
        ),
      ][0]?.reason,
      error: [
        ...state.storage.sql.exec<{ error: string | null }>(
          'SELECT error FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ][0]?.error,
    }));
    expect(failure).toEqual({
      guard: 'inventory_unsafe',
      error: 'storage_budget_unknown_object_path',
    });

    await expect(
      stub.reserveStorage({
        orgId,
        objects: [object(`budget/post-unsafe-page-${crypto.randomUUID()}`, 3)],
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
  });

  it('does not let an older reconciliation clear a newer unsafe admission guard', async () => {
    const currentScope = scope(`budget-guard-generation-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const filler = object(`budget/filler-${crypto.randomUUID()}`, ARCHIVE_STORAGE_CAP_BYTES - 10);
    await stub.reserveStorage({ orgId, objects: [filler] });
    await stub.commitStorage({ orgId, objects: [filler] });

    await stub.reconcileArchiveInventory({ orgId, limit: 1000 });
    const discoveredKey = await archiveObjectKey(
      currentScope,
      'manifests',
      `sha256:${'7'.repeat(64)}`,
    );
    await runtimeEnv.ARCHIVE_STORAGE.put(discoveredKey, '12345678');
    const mismatched = object(discoveredKey, 7, 'agent_archive_manifest');
    const mismatch = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await reserveBudgetStorage(
          state.storage,
          { ARCHIVE_STORAGE: runtimeEnv.ARCHIVE_STORAGE },
          { orgId, objects: [mismatched] },
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(mismatch).toBe('storage_object_metadata_mismatch');

    await finishReconciliation(stub, orgId);
    const guarded = await runInDurableObject(stub, (_instance, state) => ({
      committedBytes: [
        ...state.storage.sql.exec<{ committedBytes: number }>(
          'SELECT committed_bytes AS committedBytes FROM storage_budget_state WHERE id = 1',
        ),
      ][0]!.committedBytes,
      guardRevision: [
        ...state.storage.sql.exec<{ revision: number }>(
          'SELECT revision FROM storage_budget_admission_guard WHERE id = 1',
        ),
      ][0]?.revision,
    }));
    expect(guarded).toEqual({
      committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 10,
      guardRevision: 1,
    });
    await expect(
      stub.reserveStorage({
        orgId,
        objects: [object(`budget/post-old-generation-${crypto.randomUUID()}`, 3)],
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });

    await finishReconciliation(stub, orgId);
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: ARCHIVE_STORAGE_CAP_BYTES - 2,
    });
    const guardAfterCoveredGeneration = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec('SELECT id FROM storage_budget_admission_guard WHERE id = 1'),
    ]);
    expect(guardAfterCoveredGeneration).toHaveLength(0);
  });

  it('keeps acknowledgement status blocked while the admission guard is active', async () => {
    const orgId = `budget-guard-status-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.getStorageBudget({ orgId });
    const failedProbe = object(`budget/status-head-failure-${crypto.randomUUID()}`, 1);
    const throwingBucket = {
      head: async () => {
        throw new Error('status_head_failed');
      },
    } as unknown as R2Bucket;
    await runInDurableObject(stub, async (_instance, state) => {
      try {
        await reserveBudgetStorage(
          state.storage,
          { ARCHIVE_STORAGE: throwingBucket },
          { orgId, objects: [failedProbe] },
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'status_head_failed') throw error;
      }
    });

    await stub.recordArchiveAcknowledgement({ orgId, acknowledgedAt: 1234 });
    const outbox = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(outbox[0]!.payload)).toMatchObject({
      lifecycle: 'blocked',
      lastDurableAcknowledgedAt: 1234,
    });
  });

  it('starts reconciliation from ordinary budget traffic and preserves an earlier alarm', async () => {
    const orgId = `budget-alarm-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const planned = object(`budget/alarm-${crypto.randomUUID()}`, 19);
    await stub.reserveStorage({ orgId, objects: [planned] });
    const initial = await runInDurableObject(stub, async (_instance, state) => ({
      reconciliation: [
        ...state.storage.sql.exec<{ active_generation: number | null }>(
          'SELECT active_generation FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ],
      alarm: await state.storage.getAlarm(),
    }));
    expect(initial.reconciliation[0]?.active_generation).not.toBeNull();
    expect(initial.alarm).not.toBeNull();

    const earlierAlarm = await runInDurableObject(stub, async (_instance, state) => {
      const alarm = Date.now() + 1000;
      await state.storage.setAlarm(alarm);
      return alarm;
    });
    await stub.reserveStorage({ orgId, objects: [planned] });
    await stub.reserveStorage({ orgId, objects: [planned] });
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(earlierAlarm);
  });

  it('treats a queued continuation after recent completion as a completed turn', async () => {
    const orgId = `budget-alarm-race-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.reserveStorage({
      orgId,
      objects: [object(`budget/alarm-race-${crypto.randomUUID()}`, 19)],
    });
    await finishReconciliation(stub, orgId);

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        reconcileBudgetInventoryPage(state.storage, runtimeEnv, { orgId, forceStart: false }),
      ),
    ).resolves.toMatchObject({ complete: true });
  });

  it('serializes alarm reconciliation and makes its queued post-completion turn a no-op', async () => {
    const orgId = `budget-alarm-serialization-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.reserveStorage({
      orgId,
      objects: [object(`budget/alarm-serialization-${crypto.randomUUID()}`, 19)],
    });

    await runInDurableObject(stub, async (instance: StorageBudget, state) => {
      state.storage.sql.exec('DELETE FROM storage_budget_status_outbox');
      const mutable = instance as unknown as {
        reconcilePage: (
          input: { orgId: string; limit?: number },
          forceStart: boolean,
        ) => Promise<{ complete: boolean; generation: number; cursor?: string }>;
      };
      const original = mutable.reconcilePage;
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      let calls = 0;
      mutable.reconcilePage = async (input, forceStart) => {
        calls += 1;
        if (calls === 1) {
          markFirstStarted();
          await firstBlocked;
          state.storage.sql.exec(
            'UPDATE storage_budget_reconciliation SET active_generation = NULL, cursor = NULL, finalizing = 0, finalization_phase = NULL, finalization_cursor = NULL, completed_at = ? WHERE id = 1',
            Date.now(),
          );
          return { complete: true, generation: 1 };
        }
        return original.call(instance, input, forceStart);
      };

      try {
        const manual = instance.reconcileArchiveInventory({ orgId, limit: 1 });
        await firstStarted;
        const alarm = instance.alarm();
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toBe(1);
        releaseFirst();
        await expect(manual).resolves.toEqual({ complete: true, generation: 1 });
        await alarm;
        expect(calls).toBe(2);
        const reconciliation = [
          ...state.storage.sql.exec<{ active_generation: number | null }>(
            'SELECT active_generation FROM storage_budget_reconciliation WHERE id = 1',
          ),
        ][0];
        expect(reconciliation?.active_generation).toBeNull();
      } finally {
        releaseFirst();
        mutable.reconcilePage = original;
      }
    });
  });

  it('bounds generation finalization across more than one full page', async () => {
    const currentScope = scope(`budget-finalization-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    await stub.getStorageBudget({ orgId });
    const started = await stub.startReconciliation({ orgId });
    const generation = started.activeGeneration;
    if (generation === undefined) throw new Error('reconciliation did not start');
    const prefix = await archiveOrganizationPrefix(orgId);
    const stagedCount = 1001;

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE storage_budget_reconciliation SET finalizing = 1, finalization_phase = 'objects', finalization_cursor = NULL WHERE id = 1",
      );
      for (let index = 0; index < stagedCount; index += 1) {
        const objectKey = `${prefix}/contributions/${'a'.repeat(64)}/sessions/claude/${'b'.repeat(64)}/chunks/${index.toString(16).padStart(64, '0')}`;
        state.storage.sql.exec(
          "INSERT INTO storage_budget_reconciliation_objects (generation, object_key, object_class, bytes) VALUES (?, ?, 'agent_archive_chunk', 1)",
          generation,
          objectKey,
        );
      }
    });

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toMatchObject({
      complete: false,
      generation,
    });
    const firstPage = await runInDurableObject(stub, (_instance, state) => ({
      committed: [
        ...state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM storage_budget_objects WHERE status = 'committed'",
        ),
      ][0]!.count,
      reconciliation: [
        ...state.storage.sql.exec<{
          finalization_phase: string;
          finalization_cursor: string | null;
        }>(
          'SELECT finalization_phase, finalization_cursor FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ][0]!,
    }));
    expect(firstPage.committed).toBe(1000);
    expect(firstPage.reconciliation).toMatchObject({
      finalization_phase: 'objects',
      finalization_cursor: expect.any(String),
    });

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toMatchObject({
      complete: false,
      generation,
    });
    const secondPage = await runInDurableObject(stub, (_instance, state) => ({
      committed: [
        ...state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM storage_budget_objects WHERE status = 'committed'",
        ),
      ][0]!.count,
      phase: [
        ...state.storage.sql.exec<{ finalization_phase: string }>(
          'SELECT finalization_phase FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ][0]!.finalization_phase,
    }));
    expect(secondPage).toEqual({ committed: stagedCount, phase: 'stale' });

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toMatchObject({
      complete: false,
      generation,
    });
    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toMatchObject({
      complete: false,
      generation,
    });
    const cleanupPage = await runInDurableObject(
      stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM storage_budget_reconciliation_objects',
          ),
        ][0]!.count,
    );
    expect(cleanupPage).toBe(1);

    await expect(stub.reconcileArchiveInventory({ orgId, limit: 1000 })).resolves.toEqual({
      complete: true,
      generation,
    });
    const finished = await runInDurableObject(stub, (_instance, state) => ({
      activeGeneration: [
        ...state.storage.sql.exec<{ active_generation: number | null }>(
          'SELECT active_generation FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ][0]!.active_generation,
      staged: [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM storage_budget_reconciliation_objects',
        ),
      ][0]!.count,
    }));
    expect(finished).toEqual({ activeGeneration: null, staged: 0 });
  });

  it('retains a cap block across acknowledgement replay and clears it only on released capacity', async () => {
    const orgId = `budget-block-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const filler = object(
      `budget/block-filler-${crypto.randomUUID()}`,
      ARCHIVE_STORAGE_CAP_BYTES - 2,
    );
    const held = object(`budget/block-held-${crypto.randomUUID()}`, 1);
    await stub.reserveStorage({ orgId, objects: [filler] });
    await stub.commitStorage({ orgId, objects: [filler] });
    await stub.reserveStorage({ orgId, objects: [held] });
    await expect(
      stub.reserveStorage({
        orgId,
        objects: [object(`budget/block-rejected-${crypto.randomUUID()}`, 2)],
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'storage_cap_exceeded' });
    await stub.recordArchiveAcknowledgement({ orgId, acknowledgedAt: 100 });
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      reservedBytes: 1,
      blockedReason: 'storage_cap_exceeded',
    });
    const blockedStatus = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(blockedStatus[0]!.payload)).toMatchObject({ lifecycle: 'blocked' });

    await stub.releaseStorage({ orgId, objects: [held] });
    expect(await stub.getStorageBudget({ orgId })).not.toHaveProperty('blockedReason');
    const activeStatus = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ payload: string }>(
        'SELECT payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(JSON.parse(activeStatus[0]!.payload)).toMatchObject({ lifecycle: 'active' });
  });

  it('reconciles paged inventory, resumes after a restart, and preserves concurrent writes', async () => {
    const currentScope = scope(`budget-reconcile-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const keys = await inventoryKeys(currentScope);
    await runtimeEnv.ARCHIVE_STORAGE.put(keys[0]!, 'chunk');
    await runtimeEnv.ARCHIVE_STORAGE.put(keys[1]!, 'manifest');
    await runtimeEnv.ARCHIVE_STORAGE.put(keys[2]!, 'third');

    const firstPage = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
    expect(firstPage.complete).toBe(false);
    const concurrent = object(
      await archiveObjectKey(currentScope, 'chunks', `sha256:${'d'.repeat(64)}`),
      11,
    );
    await stub.reserveStorage({ orgId, objects: [concurrent] });
    await stub.commitStorage({ orgId, objects: [concurrent] });

    const restartedStub = budget(orgId);
    await finishReconciliation(restartedStub, orgId);
    const expectedInventoryBytes =
      new TextEncoder().encode('chunk').byteLength +
      new TextEncoder().encode('manifest').byteLength +
      new TextEncoder().encode('third').byteLength;
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: expectedInventoryBytes + 11,
    });

    const prefix = await archiveOrganizationPrefix(orgId);
    await runtimeEnv.ARCHIVE_STORAGE.put(`${prefix}/unknown/path`, 'must-fail-closed');
    const reconciliationError = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.reconcileArchiveInventory({ orgId, limit: 100 });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(reconciliationError).toBe('storage_budget_unknown_object_path');
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({
      committedBytes: expectedInventoryBytes + 11,
    });
  });

  it('retains known usage when an inventory page fails', async () => {
    const orgId = `budget-reconcile-failure-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const known = object(`budget/${crypto.randomUUID()}`, 29);
    await stub.reserveStorage({ orgId, objects: [known] });
    await stub.commitStorage({ orgId, objects: [known] });

    const failure = await runInDurableObject(stub, async (_instance, state) => {
      try {
        await reconcileBudgetInventoryPage(
          state.storage,
          {
            ARCHIVE_STORAGE: {
              list: async () => {
                throw new Error('inventory_connection_lost');
              },
            } as unknown as R2Bucket,
          },
          { orgId },
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toBe('storage_budget_inventory_failed');
    expect(await stub.getStorageBudget({ orgId })).toMatchObject({ committedBytes: 29 });
    const reconciliation = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ error: string }>(
        'SELECT error FROM storage_budget_reconciliation WHERE id = 1',
      ),
    ]);
    expect(reconciliation[0]?.error).toBe('inventory_connection_lost');
  });

  it('persists metadata-only status revisions and leaves the outbox on failed publication', async () => {
    const orgId = `budget-status-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const planned = object(`budget/${crypto.randomUUID()}`, 23);
    await stub.reserveStorage({ orgId, objects: [planned] });
    await stub.commitStorage({ orgId, objects: [planned] });

    const outbox = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ revision: number; payload: string }>(
        'SELECT revision, payload FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(outbox).toHaveLength(1);
    const payload = JSON.parse(outbox[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ orgId, storedBytes: 23, lifecycle: 'active' });
    expect(payload).not.toHaveProperty('objectKey');
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('ciphertext');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('status_retry'));
    await expect(stub.flushStatusOutbox()).resolves.toBe(false);
    fetchMock.mockRestore();
    const retained = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ revision: number }>(
        'SELECT revision FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ]);
    expect(retained).toEqual([{ revision: outbox[0]!.revision }]);
  });
});
