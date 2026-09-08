import { runInDurableObject } from 'cloudflare:test';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { recordRotatedObject } from '../archive-key-rotation-state';
import { archiveObjectKey } from '../archive-storage-key';
import type { StorageBudget } from '../archive-storage-budget';
import { budget, runtimeEnv, scope } from './storage-budget-fixture';

export interface ReconciliationObject {
  orgId: string;
  objectKey: string;
  body: string;
  bytes: number;
  stub: DurableObjectStub<StorageBudget>;
}

export async function createCommittedObject(label: string): Promise<ReconciliationObject> {
  const currentScope = scope(`budget-rotation-reconcile-${label}-${crypto.randomUUID()}`);
  const objectKey = await archiveObjectKey(
    currentScope,
    'chunks',
    `sha256:${'a'.repeat(63)}${label.length % 10}`,
  );
  const body = `v1-${label}`;
  const bytes = new TextEncoder().encode(body).byteLength;
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    customMetadata: archiveKeyVersionMetadata(1),
  });
  const stub = budget(currentScope.orgId);
  const object = {
    objectKey,
    objectClass: 'agent_archive_chunk' as const,
    bytes,
    expiresAt: null,
    keyVersion: 1,
  };
  await stub.reserveStorage({ orgId: currentScope.orgId, objects: [object] });
  await stub.commitStorage({ orgId: currentScope.orgId, objects: [object] });
  return { orgId: currentScope.orgId, objectKey, body, bytes, stub };
}

export async function addCommittedObject(
  input: ReconciliationObject,
  label: string,
): Promise<{ objectKey: string; bytes: number }> {
  const objectKey = await archiveObjectKey(
    scope(input.orgId),
    'chunks',
    `sha256:${'b'.repeat(63)}${label.length % 10}`,
  );
  const body = `v1-${label}`;
  const bytes = new TextEncoder().encode(body).byteLength;
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    customMetadata: archiveKeyVersionMetadata(1),
  });
  const object = {
    objectKey,
    objectClass: 'agent_archive_chunk' as const,
    bytes,
    expiresAt: null,
    keyVersion: 1,
  };
  await input.stub.reserveStorage({ orgId: input.orgId, objects: [object] });
  await input.stub.commitStorage({ orgId: input.orgId, objects: [object] });
  return { objectKey, bytes };
}

export async function snapshotInventory(
  input: ReconciliationObject,
  limit = 1000,
): Promise<number> {
  const result = await input.stub.reconcileArchiveInventory({ orgId: input.orgId, limit });
  return result.generation;
}

export async function rotateCatalogAndObject(
  input: ReconciliationObject,
  body: string,
  keyVersion = 2,
  objectKey = input.objectKey,
): Promise<number> {
  const bytes = new TextEncoder().encode(body).byteLength;
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    customMetadata: archiveKeyVersionMetadata(keyVersion),
  });
  await runInDurableObject(input.stub, (_instance, state) => {
    recordRotatedObject(state.storage, objectKey, keyVersion, bytes);
  });
  return bytes;
}

export async function finishActiveGeneration(
  input: ReconciliationObject,
  limit = 1000,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await input.stub.reconcileArchiveInventory({ orgId: input.orgId, limit });
    if (result.complete) return;
  }
  throw new Error('reconciliation_did_not_complete');
}

export async function reconciliationState(input: ReconciliationObject) {
  return runInDurableObject(input.stub, (_instance, state) => ({
    catalog: [
      ...state.storage.sql.exec<{
        object_class: string;
        bytes: number;
        expires_at: string | null;
        status: string;
        key_version: number | null;
      }>(
        'SELECT object_class, bytes, expires_at, status, key_version FROM storage_budget_objects WHERE object_key = ?',
        input.objectKey,
      ),
    ][0],
    reconciliation: [
      ...state.storage.sql.exec<{
        generation: number;
        active_generation: number | null;
        finalization_phase: string | null;
        completed_at: number | null;
        error: string | null;
      }>(
        'SELECT generation, active_generation, finalization_phase, completed_at, error FROM storage_budget_reconciliation WHERE id = 1',
      ),
    ][0],
    snapshotCount: [
      ...state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM storage_budget_reconciliation_objects',
      ),
    ][0]?.count,
    guarded:
      [
        ...state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM storage_budget_admission_guard WHERE id = 1',
        ),
      ][0]?.count === 1,
  }));
}
