export const SNAPSHOT_FIRST_CHECK_MS = 15_000;
const MAX_STATUS_CHECKS = 15;
const MAX_RECOVERY_CHECKS = 3;

export interface SnapshotCheckState {
  generation: number;
  copyIndex: number;
  nextCheckAtMs: number;
  statusChecks: number;
  recoveryChecks: number;
  recoveryRequired: boolean;
  blockedReason: string | null;
}

type StoredCheck = Record<string, number | string | null> & {
  generation: number;
  copy_index: number;
  next_check_at_ms: number;
  status_checks: number;
  recovery_checks: number;
  recovery_required: number;
  blocked_reason: string | null;
};

export function initializeSnapshotChecks(storage: DurableObjectStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot_timing (
    generation INTEGER PRIMARY KEY, started_at_ms INTEGER NOT NULL
  )`);
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot_checks (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL,
    copy_index INTEGER NOT NULL,
    next_check_at_ms INTEGER NOT NULL,
    status_checks INTEGER NOT NULL,
    recovery_checks INTEGER NOT NULL,
    recovery_required INTEGER NOT NULL,
    blocked_reason TEXT
  )`);
}

export function readSnapshotCheck(storage: DurableObjectStorage): SnapshotCheckState | null {
  const row = [...storage.sql.exec<StoredCheck>('SELECT * FROM snapshot_checks')][0];
  return row
    ? {
        generation: row.generation,
        copyIndex: row.copy_index,
        nextCheckAtMs: row.next_check_at_ms,
        statusChecks: row.status_checks,
        recoveryChecks: row.recovery_checks,
        recoveryRequired: row.recovery_required === 1,
        blockedReason: row.blocked_reason,
      }
    : null;
}

export function startSnapshotCheck(
  storage: DurableObjectStorage,
  generation: number,
  copyIndex: number,
  now: number,
): void {
  storage.sql.exec(
    `INSERT OR REPLACE INTO snapshot_checks
    VALUES (1, ?, ?, ?, 0, 0, 0, NULL)`,
    generation,
    copyIndex,
    now + SNAPSHOT_FIRST_CHECK_MS,
  );
}

export function clearSnapshotCheck(storage: DurableObjectStorage): void {
  storage.sql.exec('DELETE FROM snapshot_checks');
}

export function requireSnapshotRecovery(storage: DurableObjectStorage): void {
  storage.sql.exec('UPDATE snapshot_checks SET recovery_required = 1 WHERE singleton = 1');
}

export function prepareSnapshotCheck(
  storage: DurableObjectStorage,
  generation: number,
  copyIndex: number,
  recovery: boolean,
  now: number,
): { ready: boolean; state: SnapshotCheckState } {
  // An existing generation from before this migration has no scheduling record yet.
  if (!readSnapshotCheck(storage))
    startSnapshotCheck(storage, generation, copyIndex, now - SNAPSHOT_FIRST_CHECK_MS);
  const state = readSnapshotCheck(storage)!;
  if (state.generation !== generation || state.copyIndex !== copyIndex) {
    throw new Error('Snapshot check does not match its Copy cursor');
  }
  if (state.blockedReason || state.nextCheckAtMs > now) return { ready: false, state };
  const attempts = recovery ? state.recoveryChecks : state.statusChecks;
  if (attempts >= (recovery ? MAX_RECOVERY_CHECKS : MAX_STATUS_CHECKS)) {
    storage.sql.exec(
      'UPDATE snapshot_checks SET blocked_reason = ? WHERE singleton = 1',
      recovery
        ? 'Snapshot Copy receipt could not be recovered'
        : 'Snapshot Copy exceeded its status check budget',
    );
    return { ready: false, state: readSnapshotCheck(storage)! };
  }
  const delay = recovery
    ? Math.min(60_000 * 2 ** attempts, 300_000)
    : Math.min(SNAPSHOT_FIRST_CHECK_MS * 2 ** (attempts + 1), 60_000);
  storage.sql.exec(
    `UPDATE snapshot_checks SET next_check_at_ms = ?,
    status_checks = status_checks + ?, recovery_checks = recovery_checks + ?, recovery_required = ?
    WHERE singleton = 1`,
    now + delay,
    recovery ? 0 : 1,
    recovery ? 1 : 0,
    recovery ? 1 : 0,
  );
  return { ready: true, state: readSnapshotCheck(storage)! };
}

export function resumeSnapshotChecks(
  storage: DurableObjectStorage,
  generation: number,
  now: number,
): void {
  const state = readSnapshotCheck(storage);
  if (state?.generation !== generation || !state.blockedReason) {
    throw new Error('Snapshot has no blocked checks for this generation');
  }
  storage.sql.exec(
    `UPDATE snapshot_checks SET status_checks = 0, recovery_checks = 0,
    blocked_reason = NULL, next_check_at_ms = ? WHERE singleton = 1`,
    now,
  );
}

export function beginSnapshotTiming(
  storage: DurableObjectStorage,
  generation: number,
  now: number,
): void {
  storage.sql.exec('DELETE FROM snapshot_timing');
  storage.sql.exec('INSERT INTO snapshot_timing VALUES (?, ?)', generation, now);
}

export function snapshotStartedAt(storage: DurableObjectStorage): number | null {
  return (
    [...storage.sql.exec<{ started_at_ms: number }>('SELECT started_at_ms FROM snapshot_timing')][0]
      ?.started_at_ms ?? null
  );
}
