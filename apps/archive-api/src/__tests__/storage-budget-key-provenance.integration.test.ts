import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { archiveObjectKey } from '../archive-storage-key';
import { ensureReconciliationSchema } from '../archive-storage-budget-reconciliation';
import type { StorageBudget } from '../archive-storage-budget';
import { commitBudgetStorage, reserveBudgetStorage } from '../archive-storage-budget-ledger';
import { writeRotationState } from '../archive-key-rotation-state';
import { ACTIVATION_ID } from './key-rotation-custody-fixture';
import { budget, runtimeEnv, scope } from './storage-budget-fixture';

async function finishReconciliation(stub: DurableObjectStub<StorageBudget>, orgId: string) {
  let result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  while (!result.complete) {
    result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  }
}

async function putInventoryObject(key: string, body: string, keyVersion: number): Promise<void> {
  await runtimeEnv.ARCHIVE_STORAGE.put(key, body, {
    customMetadata: archiveKeyVersionMetadata(keyVersion),
  });
}

describe('StorageBudget key provenance reconciliation', () => {
  it('enforces the durable retired-key boundary at reserve and commit after later rotations', async () => {
    const orgId = `budget-retired-boundary-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.getStorageBudget({ orgId });
    const staleObject = {
      objectKey: `org/${orgId}/chunks/stale-v1`,
      objectClass: 'agent_archive_chunk' as const,
      bytes: 16,
      expiresAt: null,
      keyVersion: 1,
    };

    const errors = await runInDurableObject(stub, async (_instance, state) => {
      for (const [fromVersion, toVersion] of [
        [1, 2],
        [2, 3],
      ] as const) {
        writeRotationState(state.storage, {
          operationId: `rotate-${fromVersion}-${toVersion}`,
          fromVersion,
          toVersion,
          status: 'succeeded',
          generation: fromVersion,
          reencryptedCount: 0,
          remainingReferences: 0,
          activationId: ACTIVATION_ID,
          updatedAt: Date.now(),
        });
      }
      const capture = async (operation: () => Promise<unknown>): Promise<string> => {
        try {
          await operation();
          return 'accepted';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      return [
        await capture(() =>
          reserveBudgetStorage(state.storage, runtimeEnv, { orgId, objects: [staleObject] }),
        ),
        await capture(async () =>
          commitBudgetStorage(state.storage, { orgId, objects: [staleObject] }),
        ),
      ];
    });

    expect(errors).toEqual(['archive_key_version_retired', 'archive_key_version_retired']);
  });

  it('reconciles the exact encrypted key version from R2 metadata', async () => {
    const currentScope = scope(`budget-reconcile-version-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const objectKey = await archiveObjectKey(currentScope, 'chunks', `sha256:${'e'.repeat(64)}`);
    await putInventoryObject(objectKey, 'encrypted-v2', 2);

    await finishReconciliation(stub, orgId);

    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).resolves.toBe(0);
    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).resolves.toBe(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ key_version: number | null }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          objectKey,
        ),
      ]),
    ).toEqual([{ key_version: 2 }]);
  });

  it('repairs a legacy catalog row only when R2 supplies its exact key version', async () => {
    const currentScope = scope(`budget-reconcile-legacy-version-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const objectKey = await archiveObjectKey(currentScope, 'chunks', `sha256:${'1'.repeat(64)}`);
    await putInventoryObject(objectKey, 'legacy-encrypted-v2', 2);
    await stub.getStorageBudget({ orgId });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO storage_budget_objects (object_key, object_class, bytes, expires_at, status, key_version) VALUES (?, 'agent_archive_chunk', ?, NULL, 'committed', NULL)",
        objectKey,
        new TextEncoder().encode('legacy-encrypted-v2').byteLength,
      );
      state.storage.sql.exec(
        'UPDATE storage_budget_state SET committed_bytes = ? WHERE id = 1',
        new TextEncoder().encode('legacy-encrypted-v2').byteLength,
      );
    });

    await finishReconciliation(stub, orgId);

    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).resolves.toBe(0);
    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).resolves.toBe(1);
  });

  it('restarts an in-flight legacy reconciliation after adding key provenance', async () => {
    const orgId = `budget-reconcile-schema-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.getStorageBudget({ orgId });

    const migrated = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE storage_budget_reconciliation_objects');
      state.storage.sql.exec(
        'CREATE TABLE storage_budget_reconciliation_objects (generation INTEGER NOT NULL, object_key TEXT NOT NULL, object_class TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (generation, object_key))',
      );
      state.storage.sql.exec(
        'INSERT INTO storage_budget_reconciliation_objects (generation, object_key, object_class, bytes) VALUES (7, ?, ?, 12)',
        'legacy-object',
        'agent_archive_chunk',
      );
      state.storage.sql.exec(
        'INSERT INTO storage_budget_reconciliation (id, generation, active_generation, concurrent_mutation, finalizing) VALUES (1, 7, 7, 0, 1) ON CONFLICT(id) DO UPDATE SET generation = 7, active_generation = 7, finalizing = 1',
      );

      ensureReconciliationSchema(state.storage);
      return {
        columns: [
          ...state.storage.sql.exec<{ name: string }>(
            'PRAGMA table_info(storage_budget_reconciliation_objects)',
          ),
        ].map((column) => column.name),
        staged: [
          ...state.storage.sql.exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM storage_budget_reconciliation_objects',
          ),
        ][0]!.count,
        activeGeneration: [
          ...state.storage.sql.exec<{ active_generation: number | null }>(
            'SELECT active_generation FROM storage_budget_reconciliation WHERE id = 1',
          ),
        ][0]!.active_generation,
      };
    });

    expect(migrated.columns).toContain('key_version');
    expect(migrated).toMatchObject({ staged: 0, activeGeneration: null });
  });

  it('fails closed instead of cataloging a canonical object without key metadata', async () => {
    const currentScope = scope(`budget-reconcile-unknown-version-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const stub = budget(orgId);
    const objectKey = await archiveObjectKey(currentScope, 'manifests', `sha256:${'f'.repeat(64)}`);
    await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, 'missing-key-version');

    const errorClass = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.reconcileArchiveInventory({ orgId, limit: 100 });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(errorClass).toBe('archive_key_version_unknown');
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ key_version: number | null }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          objectKey,
        ),
      ]),
    ).toEqual([]);
  });
});
