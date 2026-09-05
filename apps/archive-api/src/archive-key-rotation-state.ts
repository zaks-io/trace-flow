import { ArchiveContractError, assertIdentifier } from './archive-contract';

export const ARCHIVE_ROTATION_TEMP_SUFFIX = '.reencrypt';
export const ARCHIVE_ROTATION_PAGE_LIMIT = 8;
export const ARCHIVE_ROTATION_RETRY_MS = 5000;

export type ArchiveKeyRotationStatus =
  | 'activating'
  | 'reencrypting'
  | 'destroying'
  | 'succeeded'
  | 'failed';

export type ArchiveKeyRotationFailureInjection = 'before_replace' | 'after_replace';

export interface ArchiveKeyRotationState {
  operationId: string;
  fromVersion: number;
  toVersion: number;
  status: ArchiveKeyRotationStatus;
  cursor?: string;
  reencryptedCount: number;
  remainingReferences: number;
  activationId?: string;
  lastErrorClass?: string;
  manifestRootHashes: string[];
  updatedAt: number;
}

export interface ArchiveKeyRotationHealth {
  orgId: string;
  status: 'idle' | 'rotating' | 'succeeded' | 'failed';
  operationId?: string;
  fromVersion?: number;
  toVersion?: number;
  reencryptedCount?: number;
  remainingReferences?: number;
}

export function isRotationTempObjectKey(objectKey: string): boolean {
  return objectKey.endsWith(ARCHIVE_ROTATION_TEMP_SUFFIX);
}

export function rotationTempObjectKey(objectKey: string): string {
  if (isRotationTempObjectKey(objectKey)) return objectKey;
  return `${objectKey}${ARCHIVE_ROTATION_TEMP_SUFFIX}`;
}

export function ensureRotationSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS archive_key_rotation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      operation_id TEXT NOT NULL,
      from_version INTEGER NOT NULL,
      to_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('activating', 'reencrypting', 'destroying', 'succeeded', 'failed')),
      cursor TEXT,
      reencrypted_count INTEGER NOT NULL DEFAULT 0,
      remaining_references INTEGER NOT NULL DEFAULT 0,
      activation_id TEXT,
      last_error_class TEXT,
      manifest_root_hashes TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
}

export function readRotationState(storage: DurableObjectStorage): ArchiveKeyRotationState | null {
  const row = [
    ...storage.sql.exec<{
      operation_id: string;
      from_version: number;
      to_version: number;
      status: ArchiveKeyRotationStatus;
      cursor: string | null;
      reencrypted_count: number;
      remaining_references: number;
      activation_id: string | null;
      last_error_class: string | null;
      manifest_root_hashes: string;
      updated_at: number;
    }>('SELECT * FROM archive_key_rotation WHERE id = 1'),
  ][0];
  if (!row) return null;
  let manifestRootHashes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.manifest_root_hashes);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
      )
    ) {
      manifestRootHashes = parsed;
    }
  } catch {
    manifestRootHashes = [];
  }
  return {
    operationId: row.operation_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    status: row.status,
    cursor: row.cursor ?? undefined,
    reencryptedCount: row.reencrypted_count,
    remainingReferences: row.remaining_references,
    activationId: row.activation_id ?? undefined,
    lastErrorClass: row.last_error_class ?? undefined,
    manifestRootHashes,
    updatedAt: row.updated_at,
  };
}

export function writeRotationState(
  storage: DurableObjectStorage,
  value: ArchiveKeyRotationState,
): void {
  storage.sql.exec(
    `INSERT INTO archive_key_rotation (
      id, operation_id, from_version, to_version, status, cursor, reencrypted_count,
      remaining_references, activation_id, last_error_class, manifest_root_hashes, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      operation_id = excluded.operation_id,
      from_version = excluded.from_version,
      to_version = excluded.to_version,
      status = excluded.status,
      cursor = excluded.cursor,
      reencrypted_count = excluded.reencrypted_count,
      remaining_references = excluded.remaining_references,
      activation_id = excluded.activation_id,
      last_error_class = excluded.last_error_class,
      manifest_root_hashes = excluded.manifest_root_hashes,
      updated_at = excluded.updated_at`,
    value.operationId,
    value.fromVersion,
    value.toVersion,
    value.status,
    value.cursor ?? null,
    value.reencryptedCount,
    value.remainingReferences,
    value.activationId ?? null,
    value.lastErrorClass ?? null,
    JSON.stringify(value.manifestRootHashes.slice(0, 32)),
    value.updatedAt,
  );
}

export function rotationHealth(
  orgId: string,
  state: ArchiveKeyRotationState | null,
): ArchiveKeyRotationHealth {
  assertIdentifier(orgId, 'invalid_organization_id');
  if (!state) return { orgId, status: 'idle' };
  return {
    orgId,
    status: state.status === 'succeeded' || state.status === 'failed' ? state.status : 'rotating',
    operationId: state.operationId,
    fromVersion: state.fromVersion,
    toVersion: state.toVersion,
    reencryptedCount: state.reencryptedCount,
    remainingReferences: state.remainingReferences,
  };
}

export function countKeyVersionReferences(
  storage: DurableObjectStorage,
  keyVersion: number,
): number {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new ArchiveContractError('invalid_archive_key_version');
  }
  const row = [
    ...storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM storage_budget_objects WHERE status = 'committed' AND (key_version = ? OR key_version IS NULL)",
      keyVersion,
    ),
  ][0];
  return row?.count ?? 0;
}

export function listCommittedObjectsForRotation(
  storage: DurableObjectStorage,
  fromVersion: number,
  cursor: string | undefined,
  limit: number,
): {
  objectKey: string;
  objectClass: 'agent_archive_chunk' | 'agent_archive_manifest';
  bytes: number;
}[] {
  return [
    ...storage.sql.exec<{
      object_key: string;
      object_class: 'agent_archive_chunk' | 'agent_archive_manifest';
      bytes: number;
    }>(
      `SELECT object_key, object_class, bytes FROM storage_budget_objects
       WHERE status = 'committed'
         AND (key_version = ? OR key_version IS NULL)
         AND object_key > ?
       ORDER BY object_key
       LIMIT ?`,
      fromVersion,
      cursor ?? '',
      limit,
    ),
  ].map((row) => ({
    objectKey: row.object_key,
    objectClass: row.object_class,
    bytes: row.bytes,
  }));
}

export function recordRotatedObject(
  storage: DurableObjectStorage,
  objectKey: string,
  keyVersion: number,
  bytes: number,
): void {
  const existing = [
    ...storage.sql.exec<{ bytes: number; status: string }>(
      'SELECT bytes, status FROM storage_budget_objects WHERE object_key = ?',
      objectKey,
    ),
  ][0];
  if (!existing) {
    throw new ArchiveContractError('storage_reservation_missing');
  }
  const delta = bytes - existing.bytes;
  storage.sql.exec(
    'UPDATE storage_budget_objects SET key_version = ?, bytes = ? WHERE object_key = ?',
    keyVersion,
    bytes,
    objectKey,
  );
  if (delta !== 0) {
    const column = existing.status === 'reserved' ? 'reserved_bytes' : 'committed_bytes';
    storage.sql.exec(
      `UPDATE storage_budget_state SET ${column} = ${column} + ?, mutation_version = mutation_version + 1 WHERE id = 1`,
      delta,
    );
  }
}
