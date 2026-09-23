export interface SnapshotFailure {
  generation: number;
  reason: string;
  failedAtMs: number;
}

interface StoredSnapshotFailure extends Record<string, string | number> {
  generation: number;
  reason: string;
  failed_at_ms: number;
}

export function initializeSnapshotFailure(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot_failure (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL,
    reason TEXT NOT NULL,
    failed_at_ms INTEGER NOT NULL
  )`);
}

export function readSnapshotFailure(storage: DurableObjectStorage): SnapshotFailure | null {
  const row = [...storage.sql.exec<StoredSnapshotFailure>('SELECT * FROM snapshot_failure')][0];
  return row
    ? { generation: row.generation, reason: row.reason, failedAtMs: row.failed_at_ms }
    : null;
}

export function recordSnapshotFailure(
  storage: DurableObjectStorage,
  generation: number,
  reason: string,
  now: number,
): void {
  storage.sql.exec('INSERT INTO snapshot_failure VALUES (1, ?, ?, ?)', generation, reason, now);
}

export function clearSnapshotFailure(storage: DurableObjectStorage, generation: number): void {
  const deleted = storage.sql.exec('DELETE FROM snapshot_failure WHERE generation = ?', generation);
  if (deleted.rowsWritten !== 1) throw new Error('Snapshot failure changed during recovery');
}
