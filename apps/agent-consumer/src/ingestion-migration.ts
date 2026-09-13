import {
  countRows,
  markDirtyDays,
  readCoordinatorState,
} from './agent-delivery-coordinator-storage';
import {
  assertRetainedDaySet,
  validateDaySet,
  validatePayloadSha256,
} from './agent-delivery-coordinator-validation';

export interface IngestionMigrationState {
  proofSha256: string;
  complete: boolean;
}

export function initializeIngestionMigration(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS ingestion_migration (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), proof_hash TEXT NOT NULL, complete INTEGER NOT NULL
  )`);
}

export function ingestionMigrationState(
  storage: DurableObjectStorage,
): IngestionMigrationState | null {
  const row = [
    ...storage.sql.exec<{ proof_hash: string; complete: number }>(
      'SELECT proof_hash, complete FROM ingestion_migration WHERE singleton = 1',
    ),
  ][0];
  return row ? { proofSha256: row.proof_hash, complete: row.complete === 1 } : null;
}

export function seedIngestionMigration(
  storage: DurableObjectStorage,
  input: { proofSha256: string; dirtyDays: string[] },
): IngestionMigrationState {
  const proof = validatePayloadSha256(input.proofSha256);
  const days =
    input.dirtyDays.length === 0 ? [] : validateDaySet(input.dirtyDays, 'migration days');
  assertRetainedDaySet(days, Date.now());
  return storage.transactionSync(() => {
    const existing = ingestionMigrationState(storage);
    if (existing) {
      if (existing.proofSha256 !== proof) throw new Error('Ingestion migration proof conflict');
      return existing;
    }
    const state = readCoordinatorState(storage);
    if (
      state.last_delivery_sequence !== 1 ||
      state.last_snapshot_generation !== 0 ||
      state.gate_phase !== 'open' ||
      countRows(storage, 'active_deliveries') !== 0 ||
      countRows(storage, 'dirty_days') !== 0
    ) {
      throw new Error('Ingestion migration requires an empty coordinator');
    }
    storage.sql.exec(
      'INSERT INTO ingestion_migration (singleton, proof_hash, complete) VALUES (1, ?, 0)',
      proof,
    );
    markDirtyDays(storage, days, false);
    return { proofSha256: proof, complete: false };
  });
}

export function completeIngestionMigration(
  storage: DurableObjectStorage,
  proofSha256: string,
): IngestionMigrationState {
  const proof = validatePayloadSha256(proofSha256);
  return storage.transactionSync(() => {
    const existing = ingestionMigrationState(storage);
    if (existing?.proofSha256 !== proof) throw new Error('Ingestion migration proof mismatch');
    if (existing.complete) return existing;
    const state = readCoordinatorState(storage);
    if (
      state.gate_phase !== 'open' ||
      countRows(storage, 'active_deliveries') !== 0 ||
      countRows(storage, 'dirty_days') !== 0 ||
      countRows(storage, 'incomplete_days') !== 0
    ) {
      throw new Error('Ingestion migration snapshots are not complete');
    }
    storage.sql.exec('UPDATE ingestion_migration SET complete = 1 WHERE singleton = 1');
    return { proofSha256: proof, complete: true };
  });
}
