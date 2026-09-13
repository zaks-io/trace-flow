import {
  MAX_AGENT_SNAPSHOT_DAYS,
  type CoordinatorState,
  type ReserveAgentDeliveryInput,
  type StoredReservation,
} from './agent-delivery-coordinator-contract';
import { retainedDayBounds } from './agent-delivery-coordinator-validation';

type CountedTable = 'active_deliveries' | 'dirty_days' | 'incomplete_days' | 'snapshot_days';

export function initializeCoordinatorSchema(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS coordinator_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_delivery_sequence INTEGER NOT NULL,
      last_snapshot_generation INTEGER NOT NULL,
      gate_phase TEXT NOT NULL CHECK (gate_phase IN ('open', 'draining', 'snapshot')),
      active_snapshot_generation INTEGER,
      gate_expires_at_ms INTEGER
    );
    -- Revision 1 belongs to imported baseline rows, so live deliveries always start at 2.
    INSERT OR IGNORE INTO coordinator_state
      (singleton, last_delivery_sequence, last_snapshot_generation, gate_phase,
       active_snapshot_generation, gate_expires_at_ms)
      VALUES (1, 1, 0, 'open', NULL, NULL);
    CREATE TABLE IF NOT EXISTS active_deliveries (
      delivery_id TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      delivery_sequence INTEGER NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_delivery_days (
      delivery_id TEXT NOT NULL,
      dirty_day TEXT NOT NULL,
      PRIMARY KEY (delivery_id, dirty_day)
    );
    CREATE TABLE IF NOT EXISTS dirty_days (
      dirty_day TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS incomplete_days (
      dirty_day TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS snapshot_days (
      generation INTEGER NOT NULL,
      dirty_day TEXT NOT NULL,
      PRIMARY KEY (generation, dirty_day)
    );
  `);
}

export function readCoordinatorState(storage: DurableObjectStorage): CoordinatorState {
  return storage.sql
    .exec<CoordinatorState>(
      `SELECT last_delivery_sequence, last_snapshot_generation, gate_phase,
              active_snapshot_generation, gate_expires_at_ms
       FROM coordinator_state WHERE singleton = 1`,
    )
    .one();
}

export function findReservation(
  storage: DurableObjectStorage,
  deliveryId: string,
): StoredReservation | null {
  return (
    [
      ...storage.sql.exec<StoredReservation>(
        `SELECT delivery_id, payload_sha256, delivery_sequence, created_at_ms, expires_at_ms
         FROM active_deliveries WHERE delivery_id = ?`,
        deliveryId,
      ),
    ][0] ?? null
  );
}

export function insertReservation(
  storage: DurableObjectStorage,
  reservation: ReserveAgentDeliveryInput,
  deliverySequence: number,
): void {
  storage.sql.exec(
    `INSERT INTO active_deliveries
       (delivery_id, payload_sha256, delivery_sequence, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    reservation.deliveryId,
    reservation.payloadSha256,
    deliverySequence,
    reservation.createdAtMs,
    reservation.expiresAtMs,
  );
  for (const dirtyDay of reservation.dirtyDays) {
    storage.sql.exec(
      'INSERT INTO active_delivery_days (delivery_id, dirty_day) VALUES (?, ?)',
      reservation.deliveryId,
      dirtyDay,
    );
  }
}

export function readDeliveryDays(storage: DurableObjectStorage, deliveryId: string): string[] {
  return [
    ...storage.sql.exec<{ dirty_day: string }>(
      `SELECT dirty_day FROM active_delivery_days
       WHERE delivery_id = ? ORDER BY dirty_day`,
      deliveryId,
    ),
  ].map((row) => row.dirty_day);
}

export function readSnapshotEligibleDays(storage: DurableObjectStorage): string[] {
  const newestDays = [
    ...storage.sql.exec<{ dirty_day: string }>(
      `SELECT dirty_day FROM dirty_days
       WHERE dirty_day NOT IN (SELECT dirty_day FROM incomplete_days)
       ORDER BY dirty_day DESC
       LIMIT ?`,
      MAX_AGENT_SNAPSHOT_DAYS,
    ),
  ].map((row) => row.dirty_day);
  return newestDays.sort();
}

export function markDirtyDays(
  storage: DurableObjectStorage,
  dirtyDays: string[],
  incomplete: boolean,
): void {
  for (const dirtyDay of dirtyDays) {
    storage.sql.exec('INSERT OR IGNORE INTO dirty_days (dirty_day) VALUES (?)', dirtyDay);
    if (incomplete) {
      storage.sql.exec('INSERT OR IGNORE INTO incomplete_days (dirty_day) VALUES (?)', dirtyDay);
    }
  }
}

export function deleteReservation(storage: DurableObjectStorage, deliveryId: string): void {
  storage.sql.exec('DELETE FROM active_delivery_days WHERE delivery_id = ?', deliveryId);
  storage.sql.exec('DELETE FROM active_deliveries WHERE delivery_id = ?', deliveryId);
}

export function pruneRetainedDayMetadata(storage: DurableObjectStorage, now: number): void {
  const { oldestDirtyDay, todayDirtyDay } = retainedDayBounds(now);
  for (const table of ['incomplete_days', 'dirty_days'] as const) {
    storage.sql.exec(
      `DELETE FROM ${table}
       WHERE (dirty_day < ? OR dirty_day > ?)
         AND dirty_day NOT IN (SELECT dirty_day FROM snapshot_days)`,
      oldestDirtyDay,
      todayDirtyDay,
    );
  }
}

export function countRows(storage: DurableObjectStorage, table: CountedTable): number {
  return storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
}

export function countPendingDirtyDays(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT dirty_day FROM dirty_days
         UNION
         SELECT dirty_day FROM active_delivery_days
       )`,
    )
    .one().count;
}

export function countSnapshotDays(storage: DurableObjectStorage, generation: number): number {
  return storage.sql
    .exec<{
      count: number;
    }>('SELECT COUNT(*) AS count FROM snapshot_days WHERE generation = ?', generation)
    .one().count;
}
