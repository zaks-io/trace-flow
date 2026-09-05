import type { ArchiveIntegrityErrorClass } from '@trace-flow/types';
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
  errorClass: ArchiveIntegrityErrorClass,
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
