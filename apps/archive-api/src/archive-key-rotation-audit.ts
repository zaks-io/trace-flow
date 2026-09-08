import type { Logger } from '@trace-flow/logging';
import type { ArchiveApiEnv } from './context';
import { appendArchiveAuditEvent } from './audit';
import { ArchiveContractError } from './archive-contract';
import type { ArchiveKeyRotationState } from './archive-key-rotation-state';

type RotationAuditOutcome = 'success' | 'failure';

interface RotationManifestRootEvidence {
  count: number;
  setHash?: string;
}

interface RotationAuditRow {
  [key: string]: string | number | null;
  operation_id: string;
  outcome: RotationAuditOutcome;
  activation_id: string;
  to_version: number;
  relevant_count: number;
  manifest_root_count: number;
  manifest_root_set_hash: string | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function recordRotationManifestRoot(
  storage: DurableObjectStorage,
  operationId: string,
  objectKey: string,
): void {
  const digest = /\/manifests\/([0-9a-f]{64})$/.exec(objectKey)?.[1];
  if (!digest) return;
  storage.sql.exec(
    'INSERT OR IGNORE INTO archive_key_rotation_manifest_roots (operation_id, root_hash) VALUES (?, ?)',
    operationId,
    digest,
  );
}

export async function rotationManifestRootEvidence(
  storage: DurableObjectStorage,
  operationId: string,
): Promise<RotationManifestRootEvidence> {
  let accumulator = new Uint8Array(32);
  let count = 0;
  for (const row of storage.sql.exec<{ root_hash: string }>(
    'SELECT root_hash FROM archive_key_rotation_manifest_roots WHERE operation_id = ? ORDER BY root_hash',
    operationId,
  )) {
    const input = new Uint8Array(accumulator.byteLength + 64);
    input.set(accumulator);
    input.set(new TextEncoder().encode(row.root_hash), accumulator.byteLength);
    accumulator = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    count += 1;
  }
  return count === 0 ? { count } : { count, setHash: hex(accumulator) };
}

export function enqueueRotationAudit(
  storage: DurableObjectStorage,
  state: ArchiveKeyRotationState,
  outcome: RotationAuditOutcome,
  evidence: RotationManifestRootEvidence,
): void {
  if (!state.activationId) {
    throw new ArchiveContractError('archive_key_rotation_activation_missing');
  }
  storage.sql.exec(
    `INSERT INTO archive_key_rotation_audit_outbox (
       operation_id, outcome, activation_id, to_version, relevant_count,
       manifest_root_count, manifest_root_set_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(operation_id, outcome) DO NOTHING`,
    state.operationId,
    outcome,
    state.activationId,
    state.toVersion,
    state.reencryptedCount,
    evidence.count,
    evidence.setHash ?? null,
    Date.now(),
  );
}

export function hasPendingRotationAudit(storage: DurableObjectStorage): boolean {
  return (
    [
      ...storage.sql.exec<{ pending: number }>(
        'SELECT EXISTS(SELECT 1 FROM archive_key_rotation_audit_outbox) AS pending',
      ),
    ][0]?.pending === 1
  );
}

export async function deliverPendingRotationAudits(
  storage: DurableObjectStorage,
  env: Pick<ArchiveApiEnv, 'CONVEX_SITE_URL' | 'ARCHIVE_API_SHARED_SECRET'>,
  logger: Logger,
  orgId: string,
): Promise<boolean> {
  const rows = [
    ...storage.sql.exec<RotationAuditRow>(
      'SELECT * FROM archive_key_rotation_audit_outbox ORDER BY created_at, outcome',
    ),
  ];
  for (const row of rows) {
    try {
      await appendArchiveAuditEvent(
        env,
        {
          binding: { kind: 'activation', activationId: row.activation_id },
          expectedOrgId: orgId,
          action: 'key_rotation',
          outcome: row.outcome,
          operationId: `${row.operation_id}:${row.outcome}`,
          targetKind: 'encryption_key',
          targetId: String(row.to_version),
          relevantCount: row.relevant_count,
          ...(row.manifest_root_set_hash
            ? {
                manifestRootCount: row.manifest_root_count,
                manifestRootSetHash: row.manifest_root_set_hash,
              }
            : {}),
        },
        logger,
      );
      storage.sql.exec(
        'DELETE FROM archive_key_rotation_audit_outbox WHERE operation_id = ? AND outcome = ?',
        row.operation_id,
        row.outcome,
      );
    } catch (error) {
      logger.error('archive_api.key_rotation_audit_failed', error, { outcome: row.outcome });
      return false;
    }
  }
  return true;
}
