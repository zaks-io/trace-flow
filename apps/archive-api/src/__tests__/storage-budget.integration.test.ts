import { describe, expect, it, vi } from 'vitest';
import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import {
  ARCHIVE_STORAGE_CAP_BYTES,
  type StorageBudget,
  type StorageBudgetObject,
} from '../archive-storage-budget';
import type { ArchiveApiEnv } from '../context';
import { verifyOrPutImmutableObject } from '../archive-r2';
import { archiveObjectKey, archiveOrganizationPrefix } from '../archive-storage-key';
import type { ArchiveScope } from '../archive-contract';
import { reconcileBudgetInventoryPage } from '../archive-storage-budget-reconciliation';

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
