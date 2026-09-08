import { encryptArchiveObject } from '@trace-flow/utils';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { archiveObjectKey } from '../archive-storage-key';
import type { StorageBudget } from '../archive-storage-budget';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { compress, cryptoKey, digest, wrapKey } from './key-rotation-crypto-fixture';
import { budget, runtimeEnv, scope } from './storage-budget-fixture';

describe('key rotation during alarm reconciliation', () => {
  let custody: FakeArchiveCustody;

  beforeEach(() => {
    custody = new FakeArchiveCustody();
    installCustody(custody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advances rotation before finalizing its validated inventory snapshot', async () => {
    const currentScope = scope(`alarm-reconciliation-${crypto.randomUUID()}`);
    const orgId = currentScope.orgId;
    const v1 = await wrapKey(orgId, 1);
    const v2 = await wrapKey(orgId, 2);
    custody.versions.set(1, v1);
    custody.versions.set(2, v2);
    const plaintext = new TextEncoder().encode(`${JSON.stringify({ version: 1 })}\n`);
    const objectKey = await archiveObjectKey(currentScope, 'chunks', await digest(plaintext));
    const envelope = await encryptArchiveObject(await compress(plaintext), {
      key: await cryptoKey(orgId, 1, v1),
      orgId,
      objectKey,
      objectClass: 'chunk',
      keyVersion: 1,
    });
    const body = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(body).byteLength;
    await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
      customMetadata: archiveKeyVersionMetadata(1),
    });
    const stub = budget(orgId);
    const planned = {
      objectKey,
      objectClass: 'agent_archive_chunk' as const,
      bytes,
      expiresAt: null,
      keyVersion: 1,
    };
    await stub.reserveStorage({ orgId, objects: [planned] });
    await stub.commitStorage({ orgId, objects: [planned] });
    await stub.reconcileArchiveInventory({ orgId, limit: 1000 });
    await stub.startKeyRotation({
      orgId,
      operationId: `alarm-rotation-${orgId}`,
      fromVersion: 1,
      toVersion: 2,
      activationId: ACTIVATION_ID,
    });
    custody.activeVersion = 2;
    custody.retiringVersion = 1;
    custody.operationId = `alarm-rotation-${orgId}`;
    custody.rotationStatus = 'rotating';

    await runInDurableObject(stub, (instance: StorageBudget) => instance.alarm());

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      catalog: [
        ...durableState.storage.sql.exec<{ key_version: number }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          objectKey,
        ),
      ][0],
      reconciliation: [
        ...durableState.storage.sql.exec<{ error: string | null }>(
          'SELECT error FROM storage_budget_reconciliation WHERE id = 1',
        ),
      ][0],
      guards: [
        ...durableState.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM storage_budget_admission_guard',
        ),
      ][0]!.count,
    }));
    expect(state).toEqual({
      catalog: { key_version: 2 },
      reconciliation: { error: null },
      guards: 0,
    });
  });
});
