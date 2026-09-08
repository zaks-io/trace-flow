import { describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { StorageBudget } from '../archive-storage-budget';
import {
  addCommittedObject,
  createCommittedObject,
  finishActiveGeneration,
  reconciliationState,
  rotateCatalogAndObject,
  snapshotInventory,
} from './storage-budget-reconciliation-rotation-fixture';
import { budgetState, markStorageAdmissionUnsafe } from '../archive-storage-budget-ledger';

async function finalizationError(
  input: Awaited<ReturnType<typeof createCommittedObject>>,
): Promise<string | null> {
  return runInDurableObject(input.stub, async (instance: StorageBudget) => {
    try {
      await instance.reconcileArchiveInventory({ orgId: input.orgId, limit: 1000 });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

describe('StorageBudget reconciliation across key rotation', () => {
  it('finalizes a validated snapshot after rotation without overwriting newer catalog data', async () => {
    const input = await createCommittedObject('supersede');
    await snapshotInventory(input);
    const rotatedBytes = await rotateCatalogAndObject(input, 'rotated-v2-with-new-length');

    await finishActiveGeneration(input);

    expect(await reconciliationState(input)).toMatchObject({
      catalog: { bytes: rotatedBytes, key_version: 2 },
      reconciliation: { active_generation: null, completed_at: expect.any(Number), error: null },
    });
  });

  it('recovers an already-guarded wedge across two full generations', async () => {
    const input = await createCommittedObject('guard-recovery');
    await snapshotInventory(input);
    await rotateCatalogAndObject(input, 'rotated-v2-guard-recovery');
    await runInDurableObject(input.stub, (_instance, state) => {
      markStorageAdmissionUnsafe(state.storage, budgetState(state.storage, input.orgId));
      state.storage.sql.exec(
        "UPDATE storage_budget_reconciliation SET error = 'storage_object_metadata_mismatch' WHERE id = 1",
      );
    });

    await finishActiveGeneration(input);
    expect(await reconciliationState(input)).toMatchObject({ guarded: true });
    await finishActiveGeneration(input);
    expect(await reconciliationState(input)).toMatchObject({ guarded: false });
    await expect(
      input.stub.reserveStorage({
        orgId: input.orgId,
        objects: [
          {
            objectKey: `new/${crypto.randomUUID()}`,
            objectClass: 'agent_archive_chunk',
            bytes: 1,
            expiresAt: null,
            keyVersion: 2,
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('finalizes stale rows from an earlier listing page after rotation', async () => {
    const input = await createCommittedObject('multipage');
    await addCommittedObject(input, 'multipage-second');
    const generation = await snapshotInventory(input, 1);
    const snapshottedKey = await runInDurableObject(
      input.stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ object_key: string }>(
            'SELECT object_key FROM storage_budget_reconciliation_objects WHERE generation = ?',
            generation,
          ),
        ][0]!.object_key,
    );
    const rotatedBytes = await rotateCatalogAndObject(
      input,
      'rotated-v2-multipage-with-new-length',
      2,
      snapshottedKey,
    );

    await finishActiveGeneration(input, 1);
    const rotated = await runInDurableObject(
      input.stub,
      (_instance, state) =>
        [
          ...state.storage.sql.exec<{ bytes: number; key_version: number }>(
            'SELECT bytes, key_version FROM storage_budget_objects WHERE object_key = ?',
            snapshottedKey,
          ),
        ][0],
    );
    expect(rotated).toEqual({ bytes: rotatedBytes, key_version: 2 });
    expect(await reconciliationState(input)).toMatchObject({
      reconciliation: { active_generation: null, error: null },
    });
  });

  it.each([
    {
      name: 'same-version byte mismatch',
      update: 'UPDATE storage_budget_objects SET bytes = bytes + 1 WHERE object_key = ?',
    },
    {
      name: 'rotated object class mismatch',
      update:
        "UPDATE storage_budget_objects SET key_version = 2, bytes = bytes + 1, object_class = 'agent_archive_manifest' WHERE object_key = ?",
    },
    {
      name: 'rotated expiry mismatch',
      update:
        "UPDATE storage_budget_objects SET key_version = 2, bytes = bytes + 1, expires_at = '2099-01-01T00:00:00.000Z' WHERE object_key = ?",
    },
    {
      name: 'newer reserved row',
      update:
        "UPDATE storage_budget_objects SET key_version = 2, bytes = bytes + 1, status = 'reserved' WHERE object_key = ?",
    },
  ])('keeps $name strict during finalization', async ({ update }) => {
    const input = await createCommittedObject(crypto.randomUUID());
    await snapshotInventory(input);
    await runInDurableObject(input.stub, (_instance, state) => {
      state.storage.sql.exec(update, input.objectKey);
    });

    expect(await finalizationError(input)).toBe('storage_object_metadata_mismatch');
    expect(await reconciliationState(input)).toMatchObject({ guarded: true });
  });

  it('keeps unknown snapshot provenance fail-closed', async () => {
    const input = await createCommittedObject('unknown-snapshot');
    const generation = await snapshotInventory(input);
    await runInDurableObject(input.stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE storage_budget_reconciliation_objects');
      state.storage.sql.exec(
        'CREATE TABLE storage_budget_reconciliation_objects (generation INTEGER NOT NULL, object_key TEXT NOT NULL, object_class TEXT NOT NULL, bytes INTEGER NOT NULL, key_version INTEGER, PRIMARY KEY (generation, object_key))',
      );
      state.storage.sql.exec(
        "INSERT INTO storage_budget_reconciliation_objects (generation, object_key, object_class, bytes, key_version) VALUES (?, ?, 'agent_archive_chunk', ?, NULL)",
        generation,
        input.objectKey,
        input.bytes,
      );
    });

    expect(await finalizationError(input)).toBe('archive_key_version_unknown');
  });

  it('still backfills a null catalog key version from the validated snapshot', async () => {
    const input = await createCommittedObject('null-catalog');
    await snapshotInventory(input);
    const before = await runInDurableObject(input.stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE storage_budget_objects SET key_version = NULL WHERE object_key = ?',
        input.objectKey,
      );
      return [
        ...state.storage.sql.exec<{ mutation_version: number }>(
          'SELECT mutation_version FROM storage_budget_state WHERE id = 1',
        ),
      ][0]!.mutation_version;
    });

    await input.stub.reconcileArchiveInventory({ orgId: input.orgId, limit: 1000 });
    const after = await runInDurableObject(input.stub, (_instance, state) => ({
      row: [
        ...state.storage.sql.exec<{ key_version: number | null }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          input.objectKey,
        ),
      ][0],
      mutationVersion: [
        ...state.storage.sql.exec<{ mutation_version: number }>(
          'SELECT mutation_version FROM storage_budget_state WHERE id = 1',
        ),
      ][0]!.mutation_version,
    }));
    expect(after).toEqual({ row: { key_version: 1 }, mutationVersion: before + 1 });
  });
});
