import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import { archiveOrganizationPrefix } from './archive-storage-key';
import {
  budgetState,
  clearStorageCapBlockIfCapacityReturned,
  clearStorageAdmissionUnsafe,
  enqueueStatus,
  markStorageAdmissionUnsafe,
  storageAdmissionUnsafe,
  type StorageBudgetObjectClass,
} from './archive-storage-budget-ledger';

const RECONCILIATION_PAGE_LIMIT = 1000;
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

export interface ReconciliationState {
  generation: number;
  activeGeneration?: number;
  cursor?: string;
  startedMutationVersion?: number;
  startedAdmissionGuardRevision?: number;
  concurrentMutation?: boolean;
  finalizing?: boolean;
  finalizationPhase?: 'objects' | 'stale' | 'cleanup';
  finalizationCursor?: string;
  lastCompletedAt?: number;
  error?: string;
}

interface InventoryObject {
  objectKey: string;
  objectClass: StorageBudgetObjectClass;
  bytes: number;
}

export function ensureReconciliationSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS storage_budget_reconciliation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generation INTEGER NOT NULL,
      active_generation INTEGER,
      cursor TEXT,
      started_mutation_version INTEGER,
      started_admission_guard_revision INTEGER,
      concurrent_mutation INTEGER NOT NULL DEFAULT 0,
      finalizing INTEGER NOT NULL DEFAULT 0,
      finalization_phase TEXT,
      finalization_cursor TEXT,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS storage_budget_reconciliation_objects (
      generation INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      object_class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (generation, object_key)
    );
  `);
  const columns = new Set(
    [...storage.sql.exec<{ name: string }>('PRAGMA table_info(storage_budget_reconciliation)')].map(
      (column) => column.name,
    ),
  );
  if (!columns.has('concurrent_mutation')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_reconciliation ADD COLUMN concurrent_mutation INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!columns.has('completed_at')) {
    storage.sql.exec('ALTER TABLE storage_budget_reconciliation ADD COLUMN completed_at INTEGER');
  }
  if (!columns.has('started_admission_guard_revision')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_reconciliation ADD COLUMN started_admission_guard_revision INTEGER',
    );
  }
  if (!columns.has('finalizing')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_reconciliation ADD COLUMN finalizing INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!columns.has('finalization_phase')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_reconciliation ADD COLUMN finalization_phase TEXT',
    );
  }
  if (!columns.has('finalization_cursor')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_reconciliation ADD COLUMN finalization_cursor TEXT',
    );
  }
}

export function reconciliationState(storage: DurableObjectStorage): ReconciliationState {
  const row = [
    ...storage.sql.exec<{
      generation: number;
      active_generation: number | null;
      cursor: string | null;
      started_mutation_version: number | null;
      started_admission_guard_revision: number | null;
      concurrent_mutation: number;
      finalizing: number;
      finalization_phase: 'objects' | 'stale' | 'cleanup' | null;
      finalization_cursor: string | null;
      completed_at: number | null;
      error: string | null;
    }>('SELECT * FROM storage_budget_reconciliation WHERE id = 1'),
  ][0];
  if (!row) return { generation: 0 };
  return {
    generation: row.generation,
    activeGeneration: row.active_generation ?? undefined,
    cursor: row.cursor ?? undefined,
    startedMutationVersion: row.started_mutation_version ?? undefined,
    startedAdmissionGuardRevision: row.started_admission_guard_revision ?? undefined,
    concurrentMutation: row.concurrent_mutation === 1,
    finalizing: row.finalizing === 1,
    finalizationPhase: row.finalization_phase ?? undefined,
    finalizationCursor: row.finalization_cursor ?? undefined,
    lastCompletedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function writeReconciliationState(storage: DurableObjectStorage, value: ReconciliationState): void {
  storage.sql.exec(
    'INSERT INTO storage_budget_reconciliation (id, generation, active_generation, cursor, started_mutation_version, started_admission_guard_revision, concurrent_mutation, finalizing, finalization_phase, finalization_cursor, completed_at, error) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, active_generation = excluded.active_generation, cursor = excluded.cursor, started_mutation_version = excluded.started_mutation_version, started_admission_guard_revision = excluded.started_admission_guard_revision, concurrent_mutation = excluded.concurrent_mutation, finalizing = excluded.finalizing, finalization_phase = excluded.finalization_phase, finalization_cursor = excluded.finalization_cursor, completed_at = excluded.completed_at, error = excluded.error',
    value.generation,
    value.activeGeneration ?? null,
    value.cursor ?? null,
    value.startedMutationVersion ?? null,
    value.startedAdmissionGuardRevision ?? null,
    value.concurrentMutation ? 1 : 0,
    value.finalizing ? 1 : 0,
    value.finalizationPhase ?? null,
    value.finalizationCursor ?? null,
    value.lastCompletedAt ?? null,
    value.error ?? null,
  );
}

function inventoryObject(key: string, size: number, prefix: string): InventoryObject {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^${escapedPrefix}/contributions/[0-9a-f]{64}/sessions/(?:claude|codex)/[0-9a-f]{64}/(chunks|manifests)/[0-9a-f]{64}$`,
  ).exec(key);
  if (!match || !Number.isSafeInteger(size) || size < 0) {
    throw new ArchiveContractError('storage_budget_unknown_object_path');
  }
  return {
    objectKey: key,
    objectClass: match[1] === 'chunks' ? 'agent_archive_chunk' : 'agent_archive_manifest',
    bytes: size,
  };
}

function budgetTotals(storage: DurableObjectStorage): { reserved: number; committed: number } {
  return [
    ...storage.sql.exec<{ reserved: number; committed: number }>(
      "SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN bytes ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN status = 'committed' THEN bytes ELSE 0 END), 0) AS committed FROM storage_budget_objects",
    ),
  ][0]!;
}

function assertInventoryMetadata(
  row:
    | {
        object_class: StorageBudgetObjectClass;
        bytes: number;
        expires_at: string | null;
        status: 'reserved' | 'committed';
      }
    | undefined,
  object: InventoryObject,
): void {
  if (
    row &&
    (row.object_class !== object.objectClass ||
      row.bytes !== object.bytes ||
      row.expires_at !== null)
  ) {
    throw new ArchiveContractError('storage_object_metadata_mismatch');
  }
}

function applyInventoryObject(storage: DurableObjectStorage, object: InventoryObject): boolean {
  const row = [
    ...storage.sql.exec<{
      object_class: StorageBudgetObjectClass;
      bytes: number;
      expires_at: string | null;
      status: 'reserved' | 'committed';
    }>(
      'SELECT object_class, bytes, expires_at, status FROM storage_budget_objects WHERE object_key = ?',
      object.objectKey,
    ),
  ][0];
  assertInventoryMetadata(row, object);
  if (row?.status === 'reserved') {
    storage.sql.exec(
      "UPDATE storage_budget_objects SET status = 'committed' WHERE object_key = ?",
      object.objectKey,
    );
    return true;
  }
  if (row) return false;
  storage.sql.exec(
    "INSERT INTO storage_budget_objects (object_key, object_class, bytes, expires_at, status) VALUES (?, ?, ?, NULL, 'committed')",
    object.objectKey,
    object.objectClass,
    object.bytes,
  );
  return true;
}

function finishReconciliation(
  storage: DurableObjectStorage,
  orgId: string,
  reconciliation: ReconciliationState,
): void {
  const generation = reconciliation.activeGeneration ?? reconciliation.generation;
  const clearedUnsafeAdmission = clearStorageAdmissionUnsafe(
    storage,
    reconciliation.startedAdmissionGuardRevision ?? 0,
  );
  writeReconciliationState(storage, { generation, lastCompletedAt: Date.now() });
  if (clearedUnsafeAdmission) enqueueStatus(storage, budgetState(storage, orgId));
}

function recordReconciliationFailure(
  storage: DurableObjectStorage,
  orgId: string,
  error: unknown,
  fallback: string,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      'UPDATE storage_budget_reconciliation SET error = ? WHERE id = 1',
      error instanceof Error ? error.message : fallback,
    );
    markStorageAdmissionUnsafe(storage, budgetState(storage, orgId));
  });
}

function reconcileFinalizationPage(
  storage: DurableObjectStorage,
  orgId: string,
  prefix: string,
  reconciliation: ReconciliationState,
  limit: number,
): { complete: boolean; generation: number; cursor?: string } {
  const generation = reconciliation.activeGeneration;
  if (generation === undefined) {
    return { complete: true, generation: reconciliation.generation };
  }
  let result: { complete: boolean; generation: number; cursor?: string } = {
    complete: false,
    generation,
  };
  storage.transactionSync(() => {
    const current = budgetState(storage, orgId);
    const concurrentMutation =
      reconciliation.concurrentMutation === true ||
      current.mutationVersion !== reconciliation.startedMutationVersion;
    const phase = reconciliation.finalizationPhase ?? 'objects';
    if (phase === 'cleanup') {
      const rows = [
        ...storage.sql.exec<{ objectKey: string }>(
          'SELECT object_key AS objectKey FROM storage_budget_reconciliation_objects WHERE generation = ? ORDER BY object_key LIMIT ?',
          generation,
          limit,
        ),
      ];
      for (const row of rows) {
        storage.sql.exec(
          'DELETE FROM storage_budget_reconciliation_objects WHERE generation = ? AND object_key = ?',
          generation,
          row.objectKey,
        );
      }
      if (rows.length === limit) {
        writeReconciliationState(storage, {
          ...reconciliation,
          finalizing: true,
          finalizationPhase: 'cleanup',
          finalizationCursor: undefined,
          error: undefined,
        });
        return;
      }
      finishReconciliation(storage, orgId, reconciliation);
      result = { complete: true, generation };
      return;
    }
    if (phase === 'objects') {
      const rows = [
        ...storage.sql.exec<{
          object_key: string;
          object_class: StorageBudgetObjectClass;
          bytes: number;
        }>(
          'SELECT object_key, object_class, bytes FROM storage_budget_reconciliation_objects WHERE generation = ? AND object_key > ? ORDER BY object_key LIMIT ?',
          generation,
          reconciliation.finalizationCursor ?? '',
          limit,
        ),
      ].map((row) => ({
        objectKey: row.object_key,
        objectClass: row.object_class,
        bytes: row.bytes,
      }));
      let changed = false;
      for (const object of rows) changed = applyInventoryObject(storage, object) || changed;
      const totals = budgetTotals(storage);
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = ?, committed_bytes = ?, mutation_version = mutation_version + ? WHERE id = 1',
        totals.reserved,
        totals.committed,
        changed ? 1 : 0,
      );
      const afterPage = budgetState(storage, orgId);
      if (changed) enqueueStatus(storage, afterPage);
      const nextCursor = rows.at(-1)?.objectKey;
      if (rows.length === limit) {
        writeReconciliationState(storage, {
          ...reconciliation,
          finalizing: true,
          finalizationPhase: 'objects',
          finalizationCursor: nextCursor,
          startedMutationVersion: afterPage.mutationVersion,
          concurrentMutation,
          error: undefined,
        });
        return;
      }
      if (concurrentMutation) {
        writeReconciliationState(storage, {
          ...reconciliation,
          finalizing: true,
          finalizationPhase: 'cleanup',
          finalizationCursor: undefined,
          startedMutationVersion: afterPage.mutationVersion,
          concurrentMutation: true,
          error: undefined,
        });
        return;
      }
      writeReconciliationState(storage, {
        ...reconciliation,
        finalizing: true,
        finalizationPhase: 'stale',
        finalizationCursor: undefined,
        startedMutationVersion: afterPage.mutationVersion,
        concurrentMutation: false,
        error: undefined,
      });
      return;
    }

    if (concurrentMutation) {
      writeReconciliationState(storage, {
        ...reconciliation,
        finalizing: true,
        finalizationPhase: 'cleanup',
        finalizationCursor: undefined,
        startedMutationVersion: current.mutationVersion,
        concurrentMutation: true,
        error: undefined,
      });
      return;
    }
    const beforeTotal = current.reservedBytes + current.committedBytes;
    const rows = [
      ...storage.sql.exec<{ objectKey: string }>(
        "SELECT object_key AS objectKey FROM storage_budget_objects WHERE status = 'committed' AND object_key GLOB ? AND object_key > ? AND NOT EXISTS (SELECT 1 FROM storage_budget_reconciliation_objects WHERE generation = ? AND object_key = storage_budget_objects.object_key) ORDER BY object_key LIMIT ?",
        `${prefix}/*`,
        reconciliation.finalizationCursor ?? '',
        generation,
        limit,
      ),
    ];
    for (const row of rows) {
      storage.sql.exec('DELETE FROM storage_budget_objects WHERE object_key = ?', row.objectKey);
    }
    const totals = budgetTotals(storage);
    const changed = rows.length > 0;
    storage.sql.exec(
      'UPDATE storage_budget_state SET reserved_bytes = ?, committed_bytes = ?, mutation_version = mutation_version + ? WHERE id = 1',
      totals.reserved,
      totals.committed,
      changed ? 1 : 0,
    );
    const afterPage = budgetState(storage, orgId);
    if (changed && totals.reserved + totals.committed < beforeTotal) {
      clearStorageCapBlockIfCapacityReturned(storage, afterPage);
    }
    if (changed) enqueueStatus(storage, budgetState(storage, orgId));
    if (rows.length === limit) {
      writeReconciliationState(storage, {
        ...reconciliation,
        finalizing: true,
        finalizationPhase: 'stale',
        finalizationCursor: rows.at(-1)!.objectKey,
        startedMutationVersion: afterPage.mutationVersion,
        error: undefined,
      });
      return;
    }
    writeReconciliationState(storage, {
      ...reconciliation,
      finalizing: true,
      finalizationPhase: 'cleanup',
      finalizationCursor: undefined,
      startedMutationVersion: afterPage.mutationVersion,
      error: undefined,
    });
  });
  return result;
}

export function startBudgetReconciliation(
  storage: DurableObjectStorage,
  orgId: string,
  force = true,
): ReconciliationState {
  storage.transactionSync(() => {
    const current = budgetState(storage, orgId);
    const currentReconciliation = reconciliationState(storage);
    if (currentReconciliation.activeGeneration !== undefined) return;
    if (
      !force &&
      !storageAdmissionUnsafe(storage) &&
      currentReconciliation.lastCompletedAt !== undefined &&
      Date.now() < currentReconciliation.lastCompletedAt + RECONCILIATION_INTERVAL_MS
    ) {
      return;
    }
    const generation = currentReconciliation.generation + 1;
    storage.sql.exec(
      'DELETE FROM storage_budget_reconciliation_objects WHERE generation <> ?',
      generation,
    );
    writeReconciliationState(storage, {
      generation,
      activeGeneration: generation,
      startedMutationVersion: current.mutationVersion,
      startedAdmissionGuardRevision: current.admissionGuardRevision,
      concurrentMutation: false,
    });
  });
  return reconciliationState(storage);
}

export async function reconcileBudgetInventoryPage(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE'>,
  input: { orgId: string; limit?: number; forceStart?: boolean },
): Promise<{ complete: boolean; generation: number; cursor?: string }> {
  startBudgetReconciliation(storage, input.orgId, input.forceStart ?? true);
  const reconciliation = reconciliationState(storage);
  if (reconciliation.activeGeneration === undefined) {
    return { complete: true, generation: reconciliation.generation };
  }
  const generation = reconciliation.activeGeneration;
  const limit = Math.min(
    Math.max(input.limit ?? RECONCILIATION_PAGE_LIMIT, 1),
    RECONCILIATION_PAGE_LIMIT,
  );
  const prefix = await archiveOrganizationPrefix(input.orgId);
  if (reconciliation.finalizing) {
    try {
      return reconcileFinalizationPage(storage, input.orgId, prefix, reconciliation, limit);
    } catch (error) {
      recordReconciliationFailure(storage, input.orgId, error, 'inventory_reconcile_failed');
      throw error;
    }
  }
  let listed: R2Objects;
  try {
    listed = await env.ARCHIVE_STORAGE.list({
      prefix,
      ...(reconciliation.cursor === undefined ? {} : { cursor: reconciliation.cursor }),
      limit,
    });
  } catch (error) {
    recordReconciliationFailure(storage, input.orgId, error, 'inventory_list_failed');
    throw new ArchiveContractError('storage_budget_inventory_failed');
  }

  const inventory: InventoryObject[] = [];
  let inventoryError: Error | undefined;
  for (const object of listed.objects) {
    try {
      inventory.push(inventoryObject(object.key, object.size, prefix));
    } catch (error) {
      inventoryError ??=
        error instanceof Error ? error : new ArchiveContractError('inventory_object_invalid');
    }
  }
  if (listed.truncated && (typeof listed.cursor !== 'string' || listed.cursor.length === 0)) {
    inventoryError ??= new ArchiveContractError('storage_budget_inventory_cursor_missing');
  }

  try {
    storage.transactionSync(() => {
      const current = budgetState(storage, input.orgId);
      const concurrentMutation =
        reconciliation.concurrentMutation === true ||
        current.mutationVersion !== reconciliation.startedMutationVersion;
      for (const object of inventory) {
        storage.sql.exec(
          'INSERT INTO storage_budget_reconciliation_objects (generation, object_key, object_class, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(generation, object_key) DO UPDATE SET object_class = excluded.object_class, bytes = excluded.bytes',
          generation,
          object.objectKey,
          object.objectClass,
          object.bytes,
        );
      }
      let changed = false;
      for (const object of inventory) {
        const row = [
          ...storage.sql.exec<{
            object_class: StorageBudgetObjectClass;
            bytes: number;
            expires_at: string | null;
            status: 'reserved' | 'committed';
          }>(
            'SELECT object_class, bytes, expires_at, status FROM storage_budget_objects WHERE object_key = ?',
            object.objectKey,
          ),
        ][0];
        if (row) {
          if (
            row.object_class !== object.objectClass ||
            row.bytes !== object.bytes ||
            row.expires_at !== null
          ) {
            throw new ArchiveContractError('storage_object_metadata_mismatch');
          }
          if (row.status === 'reserved') {
            storage.sql.exec(
              "UPDATE storage_budget_objects SET status = 'committed' WHERE object_key = ?",
              object.objectKey,
            );
            changed = true;
          }
        } else {
          storage.sql.exec(
            "INSERT INTO storage_budget_objects (object_key, object_class, bytes, expires_at, status) VALUES (?, ?, ?, NULL, 'committed')",
            object.objectKey,
            object.objectClass,
            object.bytes,
          );
          changed = true;
        }
      }
      const totals = budgetTotals(storage);
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = ?, committed_bytes = ?, mutation_version = mutation_version + ? WHERE id = 1',
        totals.reserved,
        totals.committed,
        changed ? 1 : 0,
      );
      if (changed) enqueueStatus(storage, budgetState(storage, input.orgId));
      const afterPage = budgetState(storage, input.orgId);
      if (inventoryError !== undefined) {
        markStorageAdmissionUnsafe(storage, afterPage);
        storage.sql.exec(
          'UPDATE storage_budget_reconciliation SET error = ? WHERE id = 1',
          inventoryError.message,
        );
        return;
      }
      if (listed.truncated) {
        writeReconciliationState(storage, {
          ...reconciliation,
          cursor: listed.cursor,
          startedMutationVersion: afterPage.mutationVersion,
          concurrentMutation,
          finalizing: false,
          finalizationPhase: undefined,
          finalizationCursor: undefined,
          error: undefined,
        });
        return;
      }
      writeReconciliationState(storage, {
        ...reconciliation,
        activeGeneration: generation,
        cursor: undefined,
        startedMutationVersion: afterPage.mutationVersion,
        concurrentMutation,
        finalizing: true,
        finalizationPhase: 'objects',
        finalizationCursor: undefined,
        error: undefined,
      });
    });
  } catch (error) {
    recordReconciliationFailure(storage, input.orgId, error, 'inventory_reconcile_failed');
    throw error;
  }
  if (inventoryError !== undefined) throw inventoryError;
  return { complete: false, generation, ...(listed.truncated ? { cursor: listed.cursor } : {}) };
}
