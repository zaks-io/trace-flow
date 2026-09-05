import { ArchiveContractError, type ArchiveScope } from './archive-contract';
import { intentDigest } from './archive-ledger-support';

export interface ArchiveSessionIntegrityFailure {
  source: ArchiveScope['source'];
  sourceSessionId: string;
  errorClass: string;
  operationId: string;
}

export class ArchiveSessionIntegrityError extends ArchiveContractError {
  constructor(
    readonly failure: ArchiveSessionIntegrityFailure,
    readonly newlyRecorded: boolean,
  ) {
    super('integrity_error');
    this.name = 'ArchiveSessionIntegrityError';
  }
}

const INTEGRITY_ERROR_CLASSES = new Set([
  'checkpoint_describes_wrong_scan',
  'checkpoint_part_mismatch',
  'checkpoint_prefix_unverifiable',
  'checkpoint_regressed',
  'chain_link_verification_failed',
  'compressed_chunk_verification_failed',
  'duplicate_record_version',
  'historical_prefix_changed',
  'immutable_object_collision',
  'invalid_checkpoint',
  'invalid_checkpoint_first_observed_at',
  'invalid_checkpoint_identity',
  'invalid_checkpoint_offset',
  'invalid_checkpoint_prefix',
  'manifest_encryption_verification_failed',
  'missing_historical_prefix_proof',
  'payload_hash_mismatch',
  'pending_intent_corrupt',
  'pending_intent_head_mismatch',
  'pending_intent_mismatch',
  'pending_object_verification_failed',
  'r2_object_verification_failed',
  'scope_mismatch',
  'unexpected_historical_prefix_proof',
]);

export function isSessionIntegrityErrorClass(errorClass: string): boolean {
  return INTEGRITY_ERROR_CLASSES.has(errorClass);
}

export function ensureSessionIntegrityTable(storage: DurableObjectStorage): void {
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS ledger_integrity_state (id INTEGER PRIMARY KEY CHECK (id = 1), error_class TEXT NOT NULL, operation_id TEXT NOT NULL)',
  );
}

export function readSessionIntegrity(
  storage: DurableObjectStorage,
  scope: ArchiveScope,
): ArchiveSessionIntegrityFailure | null {
  ensureSessionIntegrityTable(storage);
  const row = [
    ...storage.sql.exec<{ error_class: string; operation_id: string }>(
      'SELECT error_class, operation_id FROM ledger_integrity_state WHERE id = 1',
    ),
  ][0];
  return row
    ? {
        source: scope.source,
        sourceSessionId: scope.sourceSessionId,
        errorClass: row.error_class,
        operationId: row.operation_id,
      }
    : null;
}

export async function recordSessionIntegrity(
  storage: DurableObjectStorage,
  scope: ArchiveScope,
  errorClass: string,
): Promise<ArchiveSessionIntegrityError> {
  const existing = readSessionIntegrity(storage, scope);
  if (existing) return new ArchiveSessionIntegrityError(existing, false);

  const operationId = `integrity:${(
    await intentDigest({
      source: scope.source,
      sourceSessionId: scope.sourceSessionId,
      contributionId: scope.contributionId,
      errorClass,
    })
  ).slice(7)}`;
  storage.sql.exec(
    'INSERT OR IGNORE INTO ledger_integrity_state (id, error_class, operation_id) VALUES (1, ?, ?)',
    errorClass,
    operationId,
  );
  const recorded = readSessionIntegrity(storage, scope);
  if (!recorded) throw new ArchiveContractError('ledger_state_corrupt');
  return new ArchiveSessionIntegrityError(recorded, recorded.operationId === operationId);
}
