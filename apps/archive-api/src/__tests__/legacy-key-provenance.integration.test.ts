import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as workerEnv, runInDurableObject } from 'cloudflare:test';
import {
  decryptArchiveObject,
  encryptArchiveObject,
  type ArchiveObjectEnvelope,
} from '@trace-flow/utils';
import type { ArchiveApiEnv } from '../context';
import { decompress } from '../archive-packing';
import { archiveObjectKey } from '../archive-storage-key';
import type { StorageBudget } from '../archive-storage-budget';
import { storageAdmissionUnsafe } from '../archive-storage-budget-ledger';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { compress, cryptoKey, digest, wrapKey } from './key-rotation-crypto-fixture';

const runtimeEnv = workerEnv as unknown as ArchiveApiEnv;

async function finishReconciliation(stub: DurableObjectStub<StorageBudget>, orgId: string) {
  let result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  while (!result.complete) result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
}

async function legacyEncryptedChunk(orgId: string, keyVersion: number, wrappedKey: string) {
  const plaintext = new TextEncoder().encode(`legacy-${crypto.randomUUID()}`);
  const objectKey = await archiveObjectKey(
    {
      orgId,
      userId: `user-${crypto.randomUUID()}`,
      contributionId: `contribution-${crypto.randomUUID()}`,
      source: 'claude',
      sourceSessionId: `session-${crypto.randomUUID()}`,
    },
    'chunks',
    await digest(plaintext),
  );
  const envelope = await encryptArchiveObject(await compress(plaintext), {
    key: await cryptoKey(orgId, keyVersion, wrappedKey),
    orgId,
    objectKey,
    objectClass: 'chunk',
    keyVersion,
  });
  const body = JSON.stringify(envelope);
  return { body, envelope, objectKey, plaintext, bytes: new TextEncoder().encode(body).byteLength };
}

async function insertLegacyCatalogRow(
  stub: DurableObjectStub<StorageBudget>,
  orgId: string,
  objectKey: string,
  bytes: number,
) {
  await stub.getStorageBudget({ orgId });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO storage_budget_objects (object_key, object_class, bytes, expires_at, status, key_version) VALUES (?, 'agent_archive_chunk', ?, NULL, 'committed', NULL)",
      objectKey,
      bytes,
    );
    state.storage.sql.exec(
      'UPDATE storage_budget_state SET committed_bytes = ? WHERE id = 1',
      bytes,
    );
  });
}

describe('legacy archive key provenance', () => {
  let custody: FakeArchiveCustody;

  beforeEach(() => {
    custody = new FakeArchiveCustody();
    installCustody(custody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authenticates a metadata-less legacy envelope before reconciling and rotating it', async () => {
    const orgId = `legacy-provenance-${crypto.randomUUID()}`;
    const v1 = await wrapKey(orgId, 1);
    const v2 = await wrapKey(orgId, 2);
    custody.versions.set(1, v1);
    custody.versions.set(2, v2);
    const legacy = await legacyEncryptedChunk(orgId, 1, v1);
    await runtimeEnv.ARCHIVE_STORAGE.put(legacy.objectKey, legacy.body);

    const stub = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
    await insertLegacyCatalogRow(stub, orgId, legacy.objectKey, legacy.bytes);
    await finishReconciliation(stub, orgId);

    expect(custody.keyFetches).toEqual([1]);
    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).resolves.toBe(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ key_version: number | null }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          legacy.objectKey,
        ),
      ]),
    ).toEqual([{ key_version: 1 }]);

    const operationId = `rotate:${orgId}:1:2`;
    custody.activeVersion = 2;
    custody.retiringVersion = 1;
    custody.operationId = operationId;
    custody.rotationStatus = 'rotating';
    await stub.startKeyRotation({
      orgId,
      operationId,
      fromVersion: 1,
      toVersion: 2,
      activationId: ACTIVATION_ID,
    });
    await expect(stub.advanceKeyRotation({ orgId, limit: 32 })).resolves.toMatchObject({
      status: 'succeeded',
    });

    const stored = await runtimeEnv.ARCHIVE_STORAGE.get(legacy.objectKey);
    expect(stored?.customMetadata).toEqual({ 'archive-key-version': '2' });
    const rotated = JSON.parse(await stored!.text()) as ArchiveObjectEnvelope;
    const compressed = await decryptArchiveObject(rotated, {
      key: await cryptoKey(orgId, 2, v2),
      orgId,
      objectKey: legacy.objectKey,
      objectClass: 'chunk',
      keyVersion: 2,
    });
    expect(await decompress(compressed)).toEqual(legacy.plaintext);
    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 1 })).resolves.toBe(0);
    await expect(stub.countKeyVersionReferences({ orgId, keyVersion: 2 })).resolves.toBe(1);
  });

  it('rejects a metadata-less envelope whose authenticated ciphertext is corrupt', async () => {
    const orgId = `legacy-corrupt-provenance-${crypto.randomUUID()}`;
    const v1 = await wrapKey(orgId, 1);
    custody.versions.set(1, v1);
    const legacy = await legacyEncryptedChunk(orgId, 1, v1);
    legacy.envelope.ciphertext = `${legacy.envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${legacy.envelope.ciphertext.slice(1)}`;
    const corruptBody = JSON.stringify(legacy.envelope);
    await runtimeEnv.ARCHIVE_STORAGE.put(legacy.objectKey, corruptBody);

    const stub = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
    await insertLegacyCatalogRow(
      stub,
      orgId,
      legacy.objectKey,
      new TextEncoder().encode(corruptBody).byteLength,
    );
    const error = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.reconcileArchiveInventory({ orgId, limit: 100 });
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    });
    expect(error).toBe('archive_key_version_unknown');
    expect(
      await runInDurableObject(stub, (_instance, state) => storageAdmissionUnsafe(state.storage)),
    ).toBe(true);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec<{ key_version: number | null }>(
          'SELECT key_version FROM storage_budget_objects WHERE object_key = ?',
          legacy.objectKey,
        ),
      ]),
    ).toEqual([{ key_version: null }]);
  });
});
