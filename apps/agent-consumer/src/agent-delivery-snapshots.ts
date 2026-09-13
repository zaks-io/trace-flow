import {
  AgentDeliveryCoordinatorRetryableError,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
  type BeginAgentSnapshotResult,
} from './agent-delivery-coordinator-contract';
import {
  countRows,
  countSnapshotDays,
  pruneRetainedDayMetadata,
  readCoordinatorState,
  readSnapshotEligibleDays,
} from './agent-delivery-coordinator-storage';
import { retainedDayBounds } from './agent-delivery-coordinator-validation';

export function requestAgentSnapshot(
  storage: DurableObjectStorage,
  now: number,
): { status: 'draining'; activeDeliveries: number } {
  recoverExpiredSnapshotGate(storage, now);
  storage.transactionSync(() => pruneRetainedDayMetadata(storage, now));
  return storage.transactionSync(() => {
    const state = readCoordinatorState(storage);
    if (state.gate_phase === 'snapshot') throw new Error('agent snapshot is already in progress');
    if (countRows(storage, 'dirty_days') === 0) {
      throw new Error('agent snapshot has no dirty days');
    }
    const activeDeliveries = countRows(storage, 'active_deliveries');
    if (state.gate_phase === 'open') {
      storage.sql.exec(
        `UPDATE coordinator_state
         SET gate_phase = 'draining', gate_expires_at_ms = ? WHERE singleton = 1`,
        now + MAX_AGENT_SNAPSHOT_LEASE_MS,
      );
    }
    return { status: 'draining' as const, activeDeliveries };
  });
}

export function beginAgentSnapshot(
  storage: DurableObjectStorage,
  now: number,
): BeginAgentSnapshotResult {
  recoverExpiredSnapshotGate(storage, now);
  storage.transactionSync(() => pruneRetainedDayMetadata(storage, now));
  const snapshot = storage.transactionSync(() => {
    const state = readCoordinatorState(storage);
    if (state.gate_phase === 'snapshot') throw new Error('agent snapshot is already in progress');
    if (countRows(storage, 'active_deliveries') !== 0) {
      throw new AgentDeliveryCoordinatorRetryableError('active deliveries prevent snapshot');
    }
    const dirtyDays = readSnapshotEligibleDays(storage);
    if (dirtyDays.length === 0) {
      openSnapshotGate(storage);
      return null;
    }
    if (state.last_snapshot_generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('snapshot generation exhausted');
    }

    const generation = state.last_snapshot_generation + 1;
    for (const dirtyDay of dirtyDays) {
      storage.sql.exec(
        'INSERT INTO snapshot_days (generation, dirty_day) VALUES (?, ?)',
        generation,
        dirtyDay,
      );
    }
    storage.sql.exec(
      `UPDATE coordinator_state
       SET last_snapshot_generation = ?, gate_phase = 'snapshot',
           active_snapshot_generation = ?, gate_expires_at_ms = ?
       WHERE singleton = 1`,
      generation,
      generation,
      now + MAX_AGENT_SNAPSHOT_LEASE_MS,
    );
    return { generation, dirtyDays };
  });
  if (!snapshot) throw new Error('agent snapshot has no complete dirty days; recovery is required');
  return snapshot;
}

export function assertAgentSnapshotActive(
  storage: DurableObjectStorage,
  generation: number,
  now: number,
): { generation: number; expiresAtMs: number } {
  recoverExpiredSnapshotGate(storage, now);
  const state = readCoordinatorState(storage);
  if (
    state.gate_phase !== 'snapshot' ||
    state.active_snapshot_generation !== generation ||
    state.gate_expires_at_ms === null
  ) {
    throw new Error('snapshot generation is not active');
  }
  return { generation, expiresAtMs: state.gate_expires_at_ms };
}

export function finishAgentSnapshot(
  storage: DurableObjectStorage,
  generation: number,
  now: number,
): { generation: number; clearedDirtyDays: number } {
  recoverExpiredSnapshotGate(storage, now);
  return storage.transactionSync(() => {
    assertActiveSnapshotState(storage, generation);
    const clearedDirtyDays = countSnapshotDays(storage, generation);
    storage.sql.exec(
      `DELETE FROM dirty_days
       WHERE dirty_day IN (SELECT dirty_day FROM snapshot_days WHERE generation = ?)`,
      generation,
    );
    storage.sql.exec('DELETE FROM snapshot_days WHERE generation = ?', generation);
    openSnapshotGate(storage);
    pruneRetainedDayMetadata(storage, now);
    return { generation, clearedDirtyDays };
  });
}

export function failAgentSnapshot(
  storage: DurableObjectStorage,
  generation: number,
  now: number,
): { generation: number; retainedDirtyDays: number } {
  recoverExpiredSnapshotGate(storage, now);
  return storage.transactionSync(() => {
    assertActiveSnapshotState(storage, generation);
    const retainedDirtyDays = countSnapshotDays(storage, generation);
    storage.sql.exec('DELETE FROM snapshot_days WHERE generation = ?', generation);
    openSnapshotGate(storage);
    pruneRetainedDayMetadata(storage, now);
    return { generation, retainedDirtyDays };
  });
}

export function recoverExpiredSnapshotGate(storage: DurableObjectStorage, now: number): boolean {
  return storage.transactionSync(() => {
    const state = readCoordinatorState(storage);
    if (state.gate_phase === 'open') return false;
    if (state.gate_expires_at_ms === null) throw new Error('snapshot gate is missing its lease');
    if (
      now < state.gate_expires_at_ms &&
      !(state.gate_phase === 'snapshot' && snapshotContainsExpiredDays(storage, now))
    ) {
      return false;
    }

    storage.sql.exec('DELETE FROM snapshot_days');
    openSnapshotGate(storage);
    return true;
  });
}

function snapshotContainsExpiredDays(storage: DurableObjectStorage, now: number): boolean {
  const { oldestDirtyDay, todayDirtyDay } = retainedDayBounds(now);
  return (
    storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM snapshot_days
         WHERE dirty_day < ? OR dirty_day > ?`,
        oldestDirtyDay,
        todayDirtyDay,
      )
      .one().count > 0
  );
}

function assertActiveSnapshotState(storage: DurableObjectStorage, generation: number): void {
  const state = readCoordinatorState(storage);
  if (state.gate_phase !== 'snapshot' || state.active_snapshot_generation !== generation) {
    throw new Error('snapshot generation is not active');
  }
}

function openSnapshotGate(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `UPDATE coordinator_state
     SET gate_phase = 'open', active_snapshot_generation = NULL, gate_expires_at_ms = NULL
     WHERE singleton = 1`,
  );
}
