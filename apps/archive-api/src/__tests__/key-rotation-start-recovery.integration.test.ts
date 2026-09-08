import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  env as workerEnv,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { encryptArchiveObject } from '@trace-flow/utils';
import type { ArchiveApiEnv } from '../context';
import { ArchiveContractError } from '../archive-contract';
import { app } from '../index';
import { startStoredRotation } from '../archive-key-rotation';
import { archiveKeyVersionMetadata } from '../archive-r2';
import { archiveObjectKey } from '../archive-storage-key';
import type { StorageBudget } from '../archive-storage-budget';
import { ACTIVATION_ID, FakeArchiveCustody, installCustody } from './key-rotation-custody-fixture';
import { compress, cryptoKey, digest, wrapKey } from './key-rotation-crypto-fixture';

const SHARED = 'archive-status-test-secret';
const runtimeEnv = workerEnv as unknown as ArchiveApiEnv;

async function alarmOf(stub: DurableObjectStub<StorageBudget>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function advanceCatching(stub: DurableObjectStub<StorageBudget>, orgId: string) {
  return runInDurableObject(stub, async (instance: StorageBudget) => {
    try {
      await instance.advanceKeyRotation({ orgId });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

async function rotateOverHttp(orgId: string, operationId: string, env: ArchiveApiEnv = runtimeEnv) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request('https://archive.test/v1/archive/key-rotations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SHARED}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orgId, operationId }),
    }),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function putChunkWithNullCatalogVersion(
  stub: DurableObjectStub<StorageBudget>,
  orgId: string,
  wrappedKey: string,
) {
  const plaintext = new TextEncoder().encode(`rotation-start-${crypto.randomUUID()}`);
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
  const body = JSON.stringify(
    await encryptArchiveObject(await compress(plaintext), {
      key: await cryptoKey(orgId, 1, wrappedKey),
      orgId,
      objectKey,
      objectClass: 'chunk',
      keyVersion: 1,
    }),
  );
  await runtimeEnv.ARCHIVE_STORAGE.put(objectKey, body, {
    customMetadata: archiveKeyVersionMetadata(1),
  });
  const bytes = new TextEncoder().encode(body).byteLength;
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
  return objectKey;
}

async function finishReconciliation(stub: DurableObjectStub<StorageBudget>, orgId: string) {
  let result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
  while (!result.complete) result = await stub.reconcileArchiveInventory({ orgId, limit: 1 });
}

describe('archive key rotation start recovery', () => {
  let custody: FakeArchiveCustody;

  beforeEach(() => {
    custody = new FakeArchiveCustody();
    installCustody(custody);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('compensates a failed start and replays it after unknown provenance is reconciled', async () => {
    const orgId = `rotation-start-compensation-${crypto.randomUUID()}`;
    const operationId = `rotate:${orgId}:1:2`;
    const v1 = await wrapKey(orgId, 1);
    custody.versions.set(1, v1);
    const stub = runtimeEnv.STORAGE_BUDGET.getByName(orgId);
    const objectKey = await putChunkWithNullCatalogVersion(stub, orgId, v1);
    const startFailure = await runInDurableObject(stub, (_instance, state) => {
      try {
        startStoredRotation(state.storage, {
          operationId,
          fromVersion: 1,
          toVersion: 2,
          activationId: ACTIVATION_ID,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(startFailure).toBe('archive_key_version_unknown');
    const failingEnv = {
      ...runtimeEnv,
      STORAGE_BUDGET: {
        getByName: () => ({
          startKeyRotation: () => {
            throw new ArchiveContractError('archive_key_version_unknown');
          },
        }),
      } as unknown as ArchiveApiEnv['STORAGE_BUDGET'],
    };

    const failed = await rotateOverHttp(orgId, operationId, failingEnv);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    await expect(failed.json()).resolves.toMatchObject({
      error: 'rotation_failed',
      reason: 'archive_key_version_unknown',
    });
    expect(custody).toMatchObject({
      activeVersion: 2,
      retiringVersion: 1,
      operationId,
      rotationStatus: 'failed',
    });

    await finishReconciliation(stub, orgId);
    const retried = await rotateOverHttp(orgId, operationId);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({ status: 'succeeded', toVersion: 2 });
    expect(custody.activeVersion).toBe(2);
    expect(custody.versions.has(1)).toBe(false);
    expect(custody.versions.has(3)).toBe(false);
    expect((await runtimeEnv.ARCHIVE_STORAGE.get(objectKey))?.customMetadata).toEqual({
      'archive-key-version': '2',
    });
  });

  it('arms a fresh DO on start and re-arms after a failed advance for audit retry', async () => {
    const orgId = `rotation-alarm-recovery-${crypto.randomUUID()}`;
    const operationId = `rotate:${orgId}:1:2`;
    custody.versions.set(1, await wrapKey(orgId, 1));
    custody.versions.set(2, await wrapKey(orgId, 2));
    custody.activeVersion = 2;
    custody.retiringVersion = 1;
    custody.operationId = operationId;
    custody.rotationStatus = 'rotating';
    const stub = runtimeEnv.STORAGE_BUDGET.getByName(orgId);

    expect(await alarmOf(stub)).toBeNull();
    await stub.startKeyRotation({
      orgId,
      operationId,
      fromVersion: 1,
      toVersion: 2,
      activationId: ACTIVATION_ID,
    });
    expect(await alarmOf(stub)).not.toBeNull();
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());

    custody.destroyFailuresRemaining = 1;
    custody.auditFailuresRemaining = 1;
    expect(await advanceCatching(stub, orgId)).not.toBeNull();
    const failedState = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      pendingAudits: [
        ...state.storage.sql.exec('SELECT operation_id FROM archive_key_rotation_audit_outbox'),
      ].length,
    }));
    expect(failedState.alarm).not.toBeNull();
    expect(failedState.pendingAudits).toBe(1);
    expect(custody.auditBodies).toHaveLength(1);

    await runInDurableObject(stub, (instance: StorageBudget) => instance.alarm());
    expect(custody.auditBodies).toHaveLength(2);
    expect(custody.destroyCalls).toHaveLength(1);
    expect(
      await runInDurableObject(stub, (_instance, state) => [
        ...state.storage.sql.exec('SELECT operation_id FROM archive_key_rotation_audit_outbox'),
      ]),
    ).toEqual([]);
  });
});
