import { describe, expect, it } from 'vitest';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { ArchiveRecovery } from '../index';
import {
  ARCHIVE_STORAGE_CAP_BYTES,
  type StorageBudget,
  type StorageBudgetInspection,
} from '../archive-storage-budget';
import { budgetState, markStorageAdmissionUnsafe } from '../archive-storage-budget-ledger';
import type { ArchiveApiEnv } from '../context';
import { budget, runtimeEnv } from './storage-budget-fixture';

function durableState(stub: DurableObjectStub<StorageBudget>) {
  return runInDurableObject(stub, async (_instance, state) => ({
    budget: [...state.storage.sql.exec('SELECT * FROM storage_budget_state')],
    objects: [...state.storage.sql.exec('SELECT * FROM storage_budget_objects')],
    guard: [...state.storage.sql.exec('SELECT * FROM storage_budget_admission_guard')],
    reconciliation: [...state.storage.sql.exec('SELECT * FROM storage_budget_reconciliation')],
    reconciliationObjects: [
      ...state.storage.sql.exec('SELECT * FROM storage_budget_reconciliation_objects'),
    ],
    statusOutbox: [...state.storage.sql.exec('SELECT * FROM storage_budget_status_outbox')],
    rotationAuditOutbox: [
      ...state.storage.sql.exec('SELECT * FROM archive_key_rotation_audit_outbox'),
    ],
    alarm: await state.storage.getAlarm(),
  }));
}

describe('storage budget inspection', () => {
  it('fails uninitialized inspection without creating budget state or scheduling work', async () => {
    const orgId = `budget-uninitialized-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    const error = await runInDurableObject(stub, async (instance: StorageBudget) => {
      try {
        await instance.getStorageBudget({ orgId });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    });

    expect(error).toBe('storage_budget_uninitialized');
    await expect(durableState(stub)).resolves.toEqual({
      budget: [],
      objects: [],
      guard: [],
      statusOutbox: [],
      reconciliation: [],
      reconciliationObjects: [],
      rotationAuditOutbox: [],
      alarm: null,
    });
  });

  it('reports unsafe admission and reconciliation state without changing durable state', async () => {
    const orgId = `budget-diagnostics-${crypto.randomUUID()}`;
    const stub = budget(orgId);
    await stub.reserveStorage({
      orgId,
      objects: [
        {
          objectKey: `budget/${crypto.randomUUID()}`,
          objectClass: 'agent_archive_chunk',
          bytes: 29,
          expiresAt: null,
        },
      ],
    });
    const completedAt = Date.now() - 1000;
    await runInDurableObject(stub, (_instance, state) => {
      const current = budgetState(state.storage, orgId);
      markStorageAdmissionUnsafe(state.storage, current);
      state.storage.sql.exec(
        "UPDATE storage_budget_reconciliation SET generation = 7, active_generation = 7, cursor = 'cursor/object', started_mutation_version = ?, started_admission_guard_revision = ?, concurrent_mutation = 1, completed_at = ?, error = 'storage_object_metadata_mismatch' WHERE id = 1",
        current.mutationVersion,
        current.admissionGuardRevision + 1,
        completedAt,
      );
    });
    const before = await durableState(stub);
    const recovery = new ArchiveRecovery(
      createExecutionContext(),
      runtimeEnv as unknown as ArchiveApiEnv,
    );

    const inspection: StorageBudgetInspection = await recovery.getStorageBudget(orgId, { orgId });

    expect(inspection).toMatchObject({
      orgId,
      capBytes: ARCHIVE_STORAGE_CAP_BYTES,
      reservedBytes: 29,
      committedBytes: 0,
      admissionUnsafe: true,
      mutationVersion: 1,
      admissionGuardRevision: 1,
      byClass: {
        agent_archive_chunk: { reservedBytes: 29, committedBytes: 0 },
        agent_archive_manifest: { reservedBytes: 0, committedBytes: 0 },
      },
      reconciliationState: {
        generation: 7,
        activeGeneration: 7,
        cursor: 'cursor/object',
        startedMutationVersion: 1,
        startedAdmissionGuardRevision: 1,
        concurrentMutation: true,
        lastCompletedAt: completedAt,
        error: 'storage_object_metadata_mismatch',
      },
    });
    await expect(durableState(stub)).resolves.toEqual(before);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE storage_budget_reconciliation SET error = 'private object diagnostic' WHERE id = 1",
      );
    });
    const beforePrivateErrorRead = await durableState(stub);
    await expect(recovery.getStorageBudget(orgId, { orgId })).resolves.toMatchObject({
      reconciliationState: { error: 'private object diagnostic' },
    });
    await expect(durableState(stub)).resolves.toEqual(beforePrivateErrorRead);
    expect(() =>
      recovery.getStorageBudget(orgId, { orgId: `other-${crypto.randomUUID()}` }),
    ).toThrow('archive_repair_invalid');
  });
});
