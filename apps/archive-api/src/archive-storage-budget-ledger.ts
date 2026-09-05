import type { ArchiveApiEnv } from './context';
import { ArchiveContractError, assertIdentifier } from './archive-contract';
import { parseArchiveStatusUpdate, type ArchiveStatusUpdate } from './archive-status';

export const ARCHIVE_STORAGE_CAP_BYTES = 100 * 1024 * 1024 * 1024;
export const STORAGE_BUDGET_OBJECT_CLASSES = [
  'agent_archive_chunk',
  'agent_archive_manifest',
] as const;
export type StorageBudgetObjectClass = (typeof STORAGE_BUDGET_OBJECT_CLASSES)[number];

export interface StorageBudgetObject {
  objectKey: string;
  objectClass: StorageBudgetObjectClass;
  bytes: number;
  expiresAt: string | null;
  keyVersion?: number;
}

export interface StorageBudgetSnapshot {
  orgId: string;
  capBytes: number;
  reservedBytes: number;
  committedBytes: number;
  availableBytes: number;
  blockedReason?: 'storage_cap_exceeded';
  byClass: Record<StorageBudgetObjectClass, { reservedBytes: number; committedBytes: number }>;
}

export type StorageBudgetReservation =
  | { accepted: true; duplicate: boolean; snapshot: StorageBudgetSnapshot }
  | { accepted: false; reason: 'storage_cap_exceeded'; snapshot: StorageBudgetSnapshot };

export interface BudgetState {
  orgId: string;
  reservedBytes: number;
  committedBytes: number;
  mutationVersion: number;
  admissionGuardRevision: number;
  statusRevision: number;
  lastDurableAcknowledgedAt?: number;
  blockedReason?: 'storage_cap_exceeded';
}

export function ensureBudgetSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS storage_budget_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      org_id TEXT NOT NULL,
      cap_bytes INTEGER NOT NULL,
      reserved_bytes INTEGER NOT NULL,
      committed_bytes INTEGER NOT NULL,
      mutation_version INTEGER NOT NULL,
      admission_guard_revision INTEGER NOT NULL DEFAULT 0,
      status_revision INTEGER NOT NULL,
      last_durable_acknowledged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS storage_budget_objects (
      object_key TEXT PRIMARY KEY,
      object_class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'committed')),
      key_version INTEGER
    );
    CREATE TABLE IF NOT EXISTS storage_budget_status_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_budget_blocks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reason TEXT NOT NULL CHECK (reason = 'storage_cap_exceeded')
    );
    CREATE TABLE IF NOT EXISTS storage_budget_admission_guard (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reason TEXT NOT NULL CHECK (reason = 'inventory_unsafe'),
      revision INTEGER NOT NULL
    );
  `);
  const stateColumns = new Set(
    [...storage.sql.exec<{ name: string }>('PRAGMA table_info(storage_budget_state)')].map(
      (column) => column.name,
    ),
  );
  if (!stateColumns.has('admission_guard_revision')) {
    storage.sql.exec(
      'ALTER TABLE storage_budget_state ADD COLUMN admission_guard_revision INTEGER NOT NULL DEFAULT 0',
    );
  }
  const objectColumns = new Set(
    [...storage.sql.exec<{ name: string }>('PRAGMA table_info(storage_budget_objects)')].map(
      (column) => column.name,
    ),
  );
  if (!objectColumns.has('key_version')) {
    storage.sql.exec('ALTER TABLE storage_budget_objects ADD COLUMN key_version INTEGER');
  }
}

export function budgetState(storage: DurableObjectStorage, orgId: string): BudgetState {
  assertIdentifier(orgId, 'invalid_organization_id');
  const existing = [
    ...storage.sql.exec<{
      org_id: string;
      cap_bytes: number;
      reserved_bytes: number;
      committed_bytes: number;
      mutation_version: number;
      admission_guard_revision: number;
      status_revision: number;
      last_durable_acknowledged_at: number | null;
    }>('SELECT * FROM storage_budget_state WHERE id = 1'),
  ][0];
  if (!existing) {
    storage.sql.exec(
      'INSERT INTO storage_budget_state (id, org_id, cap_bytes, reserved_bytes, committed_bytes, mutation_version, status_revision) VALUES (1, ?, ?, 0, 0, 0, 0)',
      orgId,
      ARCHIVE_STORAGE_CAP_BYTES,
    );
    return {
      orgId,
      reservedBytes: 0,
      committedBytes: 0,
      mutationVersion: 0,
      admissionGuardRevision: 0,
      statusRevision: 0,
    };
  }
  if (existing.org_id !== orgId || existing.cap_bytes !== ARCHIVE_STORAGE_CAP_BYTES) {
    throw new ArchiveContractError('storage_budget_identity_mismatch');
  }
  const block = [
    ...storage.sql.exec<{ reason: 'storage_cap_exceeded' }>(
      'SELECT reason FROM storage_budget_blocks WHERE id = 1',
    ),
  ][0];
  return {
    orgId: existing.org_id,
    reservedBytes: existing.reserved_bytes,
    committedBytes: existing.committed_bytes,
    mutationVersion: existing.mutation_version,
    admissionGuardRevision: existing.admission_guard_revision,
    statusRevision: existing.status_revision,
    lastDurableAcknowledgedAt: existing.last_durable_acknowledged_at ?? undefined,
    blockedReason: block?.reason,
  };
}

function objectClass(value: unknown): value is StorageBudgetObjectClass {
  return (
    typeof value === 'string' &&
    (STORAGE_BUDGET_OBJECT_CLASSES as readonly string[]).includes(value)
  );
}

function normalizeObjects(objects: StorageBudgetObject[]): StorageBudgetObject[] {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new ArchiveContractError('storage_budget_plan_empty');
  }
  const normalized = new Map<string, StorageBudgetObject>();
  for (const object of objects) {
    if (
      typeof object.objectKey !== 'string' ||
      object.objectKey.length === 0 ||
      object.objectKey.length > 4096 ||
      !objectClass(object.objectClass) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      (object.expiresAt !== null && typeof object.expiresAt !== 'string') ||
      (object.keyVersion !== undefined &&
        (!Number.isSafeInteger(object.keyVersion) || object.keyVersion < 1))
    ) {
      throw new ArchiveContractError('storage_budget_object_invalid');
    }
    const existing = normalized.get(object.objectKey);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(object)) {
        throw new ArchiveContractError('storage_object_metadata_mismatch');
      }
      continue;
    }
    normalized.set(object.objectKey, object);
  }
  return [...normalized.values()];
}

function insertBudgetObject(
  storage: DurableObjectStorage,
  object: StorageBudgetObject,
  status: 'reserved' | 'committed',
): void {
  storage.sql.exec(
    'INSERT INTO storage_budget_objects (object_key, object_class, bytes, expires_at, status, key_version) VALUES (?, ?, ?, ?, ?, ?)',
    object.objectKey,
    object.objectClass,
    object.bytes,
    object.expiresAt,
    status,
    object.keyVersion ?? null,
  );
}

function assertExistingObject(
  row: { object_class: StorageBudgetObjectClass; bytes: number; expires_at: string | null },
  object: StorageBudgetObject,
): void {
  if (
    row.object_class !== object.objectClass ||
    row.bytes !== object.bytes ||
    row.expires_at !== object.expiresAt
  ) {
    throw new ArchiveContractError('storage_object_metadata_mismatch');
  }
}

export function snapshot(
  storage: DurableObjectStorage,
  current: BudgetState,
): StorageBudgetSnapshot {
  const byClass = Object.fromEntries(
    STORAGE_BUDGET_OBJECT_CLASSES.map((className) => [
      className,
      { reservedBytes: 0, committedBytes: 0 },
    ]),
  ) as StorageBudgetSnapshot['byClass'];
  for (const row of storage.sql.exec<{
    object_class: StorageBudgetObjectClass;
    bytes: number;
    status: 'reserved' | 'committed';
  }>('SELECT object_class, bytes, status FROM storage_budget_objects')) {
    const bucket = byClass[row.object_class];
    if (!bucket) throw new ArchiveContractError('storage_budget_corrupt');
    if (row.status === 'reserved') bucket.reservedBytes += row.bytes;
    else bucket.committedBytes += row.bytes;
  }
  return {
    orgId: current.orgId,
    capBytes: ARCHIVE_STORAGE_CAP_BYTES,
    reservedBytes: current.reservedBytes,
    committedBytes: current.committedBytes,
    availableBytes: ARCHIVE_STORAGE_CAP_BYTES - current.reservedBytes - current.committedBytes,
    ...(current.blockedReason === undefined ? {} : { blockedReason: current.blockedReason }),
    byClass,
  };
}

export function enqueueStatus(
  storage: DurableObjectStorage,
  current: BudgetState,
  blocked = false,
): void {
  const revision = current.statusRevision + 1;
  const lifecycle: ArchiveStatusUpdate['lifecycle'] =
    blocked ||
    storageAdmissionUnsafe(storage) ||
    current.blockedReason !== undefined ||
    current.committedBytes >= ARCHIVE_STORAGE_CAP_BYTES
      ? 'blocked'
      : 'active';
  const payload: ArchiveStatusUpdate = {
    orgId: current.orgId,
    revision,
    storedBytes: current.committedBytes,
    lifecycle,
    ...(current.lastDurableAcknowledgedAt === undefined
      ? {}
      : { lastDurableAcknowledgedAt: current.lastDurableAcknowledgedAt }),
  };
  storage.sql.exec('UPDATE storage_budget_state SET status_revision = ? WHERE id = 1', revision);
  storage.sql.exec(
    'INSERT INTO storage_budget_status_outbox (id, revision, payload) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload',
    revision,
    JSON.stringify(payload),
  );
}

export function rebaseStatusAfterConflict(
  storage: DurableObjectStorage,
  orgId: string,
  conflictedRevision: number,
): boolean {
  return storage.transactionSync(() => {
    const outbox = [
      ...storage.sql.exec<{ revision: number }>(
        'SELECT revision FROM storage_budget_status_outbox WHERE id = 1',
      ),
    ][0];
    if (outbox?.revision !== conflictedRevision) return false;
    enqueueStatus(storage, budgetState(storage, orgId));
    return true;
  });
}

function setStorageCapBlocked(storage: DurableObjectStorage): void {
  storage.sql.exec(
    "INSERT INTO storage_budget_blocks (id, reason) VALUES (1, 'storage_cap_exceeded') ON CONFLICT(id) DO UPDATE SET reason = excluded.reason",
  );
}

export function markStorageAdmissionUnsafe(
  storage: DurableObjectStorage,
  current: BudgetState,
): void {
  storage.sql.exec(
    'UPDATE storage_budget_state SET admission_guard_revision = admission_guard_revision + 1 WHERE id = 1',
  );
  const revision = [
    ...storage.sql.exec<{ revision: number }>(
      'SELECT admission_guard_revision AS revision FROM storage_budget_state WHERE id = 1',
    ),
  ][0]!.revision;
  storage.sql.exec(
    "INSERT INTO storage_budget_admission_guard (id, reason, revision) VALUES (1, 'inventory_unsafe', ?) ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, revision = excluded.revision",
    revision,
  );
  enqueueStatus(storage, current, true);
}

export function clearStorageAdmissionUnsafe(
  storage: DurableObjectStorage,
  coveredRevision: number,
): boolean {
  const unsafe = [
    ...storage.sql.exec<{ revision: number }>(
      'SELECT revision FROM storage_budget_admission_guard WHERE id = 1',
    ),
  ][0];
  if (!unsafe || unsafe.revision > coveredRevision) return false;
  storage.sql.exec(
    'DELETE FROM storage_budget_admission_guard WHERE id = 1 AND revision <= ?',
    coveredRevision,
  );
  return true;
}

export function storageAdmissionUnsafe(storage: DurableObjectStorage): boolean {
  return (
    [
      ...storage.sql.exec<{ id: number }>(
        'SELECT id FROM storage_budget_admission_guard WHERE id = 1',
      ),
    ].length > 0
  );
}

export function clearStorageCapBlockIfCapacityReturned(
  storage: DurableObjectStorage,
  current: BudgetState,
): void {
  if (
    current.blockedReason !== undefined &&
    current.reservedBytes + current.committedBytes < ARCHIVE_STORAGE_CAP_BYTES
  ) {
    storage.sql.exec('DELETE FROM storage_budget_blocks WHERE id = 1');
  }
}

function enqueueAcknowledgement(
  storage: DurableObjectStorage,
  current: BudgetState,
  acknowledgedAt: number,
): void {
  enqueueStatus(storage, { ...current, lastDurableAcknowledgedAt: acknowledgedAt });
}

export async function reserveBudgetStorage(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'ARCHIVE_STORAGE'>,
  input: { orgId: string; objects: StorageBudgetObject[] },
): Promise<StorageBudgetReservation> {
  const objects = normalizeObjects(input.objects);
  const initial = budgetState(storage, input.orgId);
  if (storageAdmissionUnsafe(storage)) {
    return {
      accepted: false,
      reason: 'storage_cap_exceeded',
      snapshot: snapshot(storage, initial),
    };
  }
  const existingInR2 = new Map<string, boolean>();
  try {
    for (const object of objects) {
      const row = [
        ...storage.sql.exec<{ object_key: string }>(
          'SELECT object_key FROM storage_budget_objects WHERE object_key = ?',
          object.objectKey,
        ),
      ][0];
      if (row) continue;
      const existing = await env.ARCHIVE_STORAGE.head(object.objectKey);
      if (existing && existing.size !== object.bytes) {
        throw new ArchiveContractError('storage_object_metadata_mismatch');
      }
      existingInR2.set(object.objectKey, existing !== null);
    }
  } catch (error) {
    storage.transactionSync(() => {
      let discoveredBytes = 0;
      for (const object of objects) {
        if (!existingInR2.get(object.objectKey)) continue;
        const existing = [
          ...storage.sql.exec<{
            object_class: StorageBudgetObjectClass;
            bytes: number;
            expires_at: string | null;
          }>(
            'SELECT object_class, bytes, expires_at FROM storage_budget_objects WHERE object_key = ?',
            object.objectKey,
          ),
        ][0];
        if (existing) {
          assertExistingObject(existing, object);
          continue;
        }
        insertBudgetObject(storage, object, 'committed');
        discoveredBytes += object.bytes;
      }
      if (discoveredBytes > 0) {
        storage.sql.exec(
          'UPDATE storage_budget_state SET committed_bytes = committed_bytes + ?, mutation_version = mutation_version + 1 WHERE id = 1',
          discoveredBytes,
        );
      }
      markStorageAdmissionUnsafe(storage, budgetState(storage, input.orgId));
    });
    throw error;
  }

  let result!: StorageBudgetReservation;
  storage.transactionSync(() => {
    const current = budgetState(storage, input.orgId);
    if (storageAdmissionUnsafe(storage)) {
      result = {
        accepted: false,
        reason: 'storage_cap_exceeded',
        snapshot: snapshot(storage, current),
      };
      return;
    }
    const additions: StorageBudgetObject[] = [];
    const existingObjects: StorageBudgetObject[] = [];
    for (const object of objects) {
      const existing = [
        ...storage.sql.exec<{
          object_class: StorageBudgetObjectClass;
          bytes: number;
          expires_at: string | null;
        }>(
          'SELECT object_class, bytes, expires_at FROM storage_budget_objects WHERE object_key = ?',
          object.objectKey,
        ),
      ][0];
      if (existing) assertExistingObject(existing, object);
      else if (existingInR2.get(object.objectKey)) existingObjects.push(object);
      else additions.push(object);
    }
    const additionalBytes = additions.reduce((sum, object) => sum + object.bytes, 0);
    const existingBytes = existingObjects.reduce((sum, object) => sum + object.bytes, 0);
    for (const object of existingObjects) {
      insertBudgetObject(storage, object, 'committed');
    }
    const exceedsCap =
      additionalBytes > 0 &&
      current.committedBytes + current.reservedBytes + existingBytes + additionalBytes >
        ARCHIVE_STORAGE_CAP_BYTES;
    if (exceedsCap) {
      if (existingBytes > 0) {
        storage.sql.exec(
          'UPDATE storage_budget_state SET committed_bytes = committed_bytes + ?, mutation_version = mutation_version + 1 WHERE id = 1',
          existingBytes,
        );
      }
      setStorageCapBlocked(storage);
      const blocked = budgetState(storage, input.orgId);
      enqueueStatus(storage, blocked, true);
      result = {
        accepted: false,
        reason: 'storage_cap_exceeded',
        snapshot: snapshot(storage, budgetState(storage, input.orgId)),
      };
      return;
    }
    for (const object of additions) {
      insertBudgetObject(storage, object, 'reserved');
    }
    if (additionalBytes > 0 || existingBytes > 0) {
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = reserved_bytes + ?, committed_bytes = committed_bytes + ?, mutation_version = mutation_version + 1 WHERE id = 1',
        additionalBytes,
        existingBytes,
      );
      enqueueStatus(storage, budgetState(storage, input.orgId));
    }
    result = {
      accepted: true,
      duplicate: additions.length === 0 && existingObjects.length === 0,
      snapshot: snapshot(storage, budgetState(storage, input.orgId)),
    };
  });
  return result;
}

export function commitBudgetStorage(
  storage: DurableObjectStorage,
  input: { orgId: string; objects: StorageBudgetObject[] },
): StorageBudgetSnapshot {
  const objects = normalizeObjects(input.objects);
  storage.transactionSync(() => {
    budgetState(storage, input.orgId);
    const rows = new Map<string, { bytes: number; status: 'reserved' | 'committed' }>();
    for (const object of objects) {
      const row = [
        ...storage.sql.exec<{
          object_class: StorageBudgetObjectClass;
          bytes: number;
          expires_at: string | null;
          status: 'reserved' | 'committed';
        }>('SELECT * FROM storage_budget_objects WHERE object_key = ?', object.objectKey),
      ][0];
      if (!row) throw new ArchiveContractError('storage_reservation_missing');
      assertExistingObject(row, object);
      rows.set(object.objectKey, row);
    }
    let committedBytes = 0;
    for (const [objectKey, row] of rows) {
      if (row.status !== 'reserved') continue;
      committedBytes += row.bytes;
      storage.sql.exec(
        "UPDATE storage_budget_objects SET status = 'committed' WHERE object_key = ?",
        objectKey,
      );
    }
    if (committedBytes > 0) {
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = reserved_bytes - ?, committed_bytes = committed_bytes + ?, mutation_version = mutation_version + 1 WHERE id = 1',
        committedBytes,
        committedBytes,
      );
      enqueueStatus(storage, budgetState(storage, input.orgId));
    }
  });
  return snapshot(storage, budgetState(storage, input.orgId));
}

export function releaseBudgetStorage(
  storage: DurableObjectStorage,
  input: { orgId: string; objects: StorageBudgetObject[] },
): StorageBudgetSnapshot {
  const objects = normalizeObjects(input.objects);
  storage.transactionSync(() => {
    budgetState(storage, input.orgId);
    let releasedBytes = 0;
    for (const object of objects) {
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
      if (!row) continue;
      assertExistingObject(row, object);
      if (row.status === 'reserved') {
        releasedBytes += row.bytes;
        storage.sql.exec(
          'DELETE FROM storage_budget_objects WHERE object_key = ?',
          object.objectKey,
        );
      }
    }
    if (releasedBytes > 0) {
      storage.sql.exec(
        'UPDATE storage_budget_state SET reserved_bytes = reserved_bytes - ?, mutation_version = mutation_version + 1 WHERE id = 1',
        releasedBytes,
      );
      const current = budgetState(storage, input.orgId);
      clearStorageCapBlockIfCapacityReturned(storage, current);
      enqueueStatus(storage, budgetState(storage, input.orgId));
    }
  });
  return snapshot(storage, budgetState(storage, input.orgId));
}

export function acknowledgeBudgetStorage(
  storage: DurableObjectStorage,
  input: { orgId: string; acknowledgedAt: number },
): StorageBudgetSnapshot {
  if (!Number.isSafeInteger(input.acknowledgedAt) || input.acknowledgedAt < 0) {
    throw new ArchiveContractError('archive_acknowledgement_invalid');
  }
  storage.transactionSync(() => {
    const current = budgetState(storage, input.orgId);
    if (
      current.lastDurableAcknowledgedAt === undefined ||
      input.acknowledgedAt > current.lastDurableAcknowledgedAt
    ) {
      storage.sql.exec(
        'UPDATE storage_budget_state SET last_durable_acknowledged_at = ? WHERE id = 1',
        input.acknowledgedAt,
      );
      enqueueAcknowledgement(storage, current, input.acknowledgedAt);
    }
  });
  return snapshot(storage, budgetState(storage, input.orgId));
}

export function parseStoredStatusPayload(payload: string): ArchiveStatusUpdate {
  try {
    return parseArchiveStatusUpdate(JSON.parse(payload));
  } catch {
    throw new ArchiveContractError('storage_budget_status_corrupt');
  }
}
