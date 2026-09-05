import type { ArchiveApiEnv } from './context';
import { ArchiveContractError } from './archive-contract';
import { archiveOrganizationPrefix } from './archive-storage-key';
import {
  budgetState,
  enqueueStatus,
  type StorageBudgetObjectClass,
} from './archive-storage-budget-ledger';

const RECONCILIATION_PAGE_LIMIT = 1000;

export interface ReconciliationState {
  generation: number;
  activeGeneration?: number;
  cursor?: string;
  startedMutationVersion?: number;
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
}

export function reconciliationState(storage: DurableObjectStorage): ReconciliationState {
  const row = [
    ...storage.sql.exec<{
      generation: number;
      active_generation: number | null;
      cursor: string | null;
      started_mutation_version: number | null;
      error: string | null;
    }>('SELECT * FROM storage_budget_reconciliation WHERE id = 1'),
  ][0];
  if (!row) return { generation: 0 };
  return {
    generation: row.generation,
    activeGeneration: row.active_generation ?? undefined,
    cursor: row.cursor ?? undefined,
    startedMutationVersion: row.started_mutation_version ?? undefined,
    error: row.error ?? undefined,
  };
}

function writeReconciliationState(storage: DurableObjectStorage, value: ReconciliationState): void {
  storage.sql.exec(
    'INSERT INTO storage_budget_reconciliation (id, generation, active_generation, cursor, started_mutation_version, error) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, active_generation = excluded.active_generation, cursor = excluded.cursor, started_mutation_version = excluded.started_mutation_version, error = excluded.error',
    value.generation,
    value.activeGeneration ?? null,
    value.cursor ?? null,
    value.startedMutationVersion ?? null,
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

export function startBudgetReconciliation(
  storage: DurableObjectStorage,
  orgId: string,
): ReconciliationState {
  storage.transactionSync(() => {
    const current = budgetState(storage, orgId);
    const currentReconciliation = reconciliationState(storage);
    if (currentReconciliation.activeGeneration !== undefined) return;
    const generation = currentReconciliation.generation + 1;
    storage.sql.exec(
      'DELETE FROM storage_budget_reconciliation_objects WHERE generation <> ?',
      generation,
    );
    writeReconciliationState(storage, {
      generation,
      activeGeneration: generation,
      startedMutationVersion: current.mutationVersion,
    });
  });
  return reconciliationState(storage);
}

export async function reconcileBudgetInventoryPage(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE'>,
  input: { orgId: string; limit?: number },
): Promise<{ complete: boolean; generation: number; cursor?: string }> {
  startBudgetReconciliation(storage, input.orgId);
  const reconciliation = reconciliationState(storage);
  const generation = reconciliation.activeGeneration!;
  const limit = Math.min(
    Math.max(input.limit ?? RECONCILIATION_PAGE_LIMIT, 1),
    RECONCILIATION_PAGE_LIMIT,
  );
  const prefix = await archiveOrganizationPrefix(input.orgId);
  let listed: R2Objects;
  try {
    listed = await env.ARCHIVE_STORAGE.list({
      prefix,
      ...(reconciliation.cursor === undefined ? {} : { cursor: reconciliation.cursor }),
      limit,
    });
  } catch (error) {
    storage.sql.exec(
      'UPDATE storage_budget_reconciliation SET error = ? WHERE id = 1',
      error instanceof Error ? error.message : 'inventory_list_failed',
    );
    throw new ArchiveContractError('storage_budget_inventory_failed');
  }

  let inventory: InventoryObject[];
  try {
    inventory = listed.objects.map((object) => inventoryObject(object.key, object.size, prefix));
  } catch (error) {
    storage.sql.exec(
      'UPDATE storage_budget_reconciliation SET error = ? WHERE id = 1',
      error instanceof Error ? error.message : 'inventory_object_invalid',
    );
    throw error;
  }

  try {
    storage.transactionSync(() => {
      const current = budgetState(storage, input.orgId);
      for (const object of inventory) {
        storage.sql.exec(
          'INSERT INTO storage_budget_reconciliation_objects (generation, object_key, object_class, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(generation, object_key) DO UPDATE SET object_class = excluded.object_class, bytes = excluded.bytes',
          generation,
          object.objectKey,
          object.objectClass,
          object.bytes,
        );
      }
      if (listed.truncated) {
        if (typeof listed.cursor !== 'string' || listed.cursor.length === 0) {
          throw new ArchiveContractError('storage_budget_inventory_cursor_missing');
        }
        writeReconciliationState(storage, {
          ...reconciliation,
          cursor: listed.cursor,
          error: undefined,
        });
        return;
      }

      const staged = [
        ...storage.sql.exec<{
          object_key: string;
          object_class: StorageBudgetObjectClass;
          bytes: number;
        }>(
          'SELECT object_key, object_class, bytes FROM storage_budget_reconciliation_objects WHERE generation = ?',
          generation,
        ),
      ].map((row) => ({
        objectKey: row.object_key,
        objectClass: row.object_class,
        bytes: row.bytes,
      }));
      const mutationChanged = current.mutationVersion !== reconciliation.startedMutationVersion;
      let changed = false;
      for (const object of staged) {
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
      if (!mutationChanged) {
        const stagedKeys = new Set(staged.map((object) => object.objectKey));
        for (const row of storage.sql.exec<{ object_key: string }>(
          "SELECT object_key FROM storage_budget_objects WHERE status = 'committed'",
        )) {
          if (!stagedKeys.has(row.object_key)) {
            storage.sql.exec(
              'DELETE FROM storage_budget_objects WHERE object_key = ?',
              row.object_key,
            );
            changed = true;
          }
        }
      }
      const totals = [
        ...storage.sql.exec<{ reserved: number; committed: number }>(
          "SELECT COALESCE(SUM(CASE WHEN status = 'reserved' THEN bytes ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN status = 'committed' THEN bytes ELSE 0 END), 0) AS committed FROM storage_budget_objects",
        ),
      ][0]!;
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = ?, committed_bytes = ?, mutation_version = mutation_version + ? WHERE id = 1',
        totals.reserved,
        totals.committed,
        changed ? 1 : 0,
      );
      if (changed) enqueueStatus(storage, budgetState(storage, input.orgId));
      storage.sql.exec(
        'DELETE FROM storage_budget_reconciliation_objects WHERE generation = ?',
        generation,
      );
      writeReconciliationState(storage, { generation });
    });
  } catch (error) {
    storage.sql.exec(
      'UPDATE storage_budget_reconciliation SET error = ? WHERE id = 1',
      error instanceof Error ? error.message : 'inventory_reconcile_failed',
    );
    throw error;
  }
  return listed.truncated
    ? { complete: false, generation, cursor: listed.cursor }
    : { complete: true, generation };
}
