import { AGENT_SNAPSHOT_TARGETS } from '@trace-flow/tinybird-client';
import {
  AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER,
  MAX_AGENT_SNAPSHOT_COPY_DAYS,
  MAX_AGENT_SNAPSHOT_LEASE_MS,
  type AgentSnapshotProgress,
} from './agent-delivery-coordinator-contract';
import { countSnapshotDays, readCoordinatorState } from './agent-delivery-coordinator-storage';

interface StoredSnapshotProgress extends Record<string, string | number | null> {
  generation: number;
  next_copy_index: number;
  claim_id: string;
  manifest_published_at_ms: number | null;
}

export function initializeAgentSnapshotProgress(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_progress (
      generation INTEGER PRIMARY KEY,
      next_copy_index INTEGER NOT NULL CHECK (next_copy_index >= 0),
      claim_id TEXT NOT NULL,
      manifest_published_at_ms INTEGER
    );
  `);
}

export function createAgentSnapshotProgress(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): AgentSnapshotProgress {
  const validatedClaimId = validateSnapshotClaimId(claimId);
  storage.sql.exec(
    `INSERT INTO snapshot_progress
       (generation, next_copy_index, claim_id, manifest_published_at_ms)
     VALUES (?, 0, ?, NULL)`,
    generation,
    validatedClaimId,
  );
  setClaimExpiry(storage, generation, validatedClaimId, now);
  return readAgentSnapshotProgress(storage, generation);
}

export function prepareSnapshotManifest(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): AgentSnapshotProgress {
  return storage.transactionSync(() => {
    const progress = assertAgentSnapshotClaim(storage, generation, claimId, now);
    if (progress.nextCopyIndex !== progress.totalCopies) {
      throw new Error('snapshot Copy progress is incomplete');
    }
    storage.sql.exec(
      `UPDATE snapshot_progress SET manifest_published_at_ms = COALESCE(manifest_published_at_ms, ?)
       WHERE generation = ?`,
      now,
      generation,
    );
    return readAgentSnapshotProgress(storage, generation);
  });
}

export function claimAgentSnapshot(
  storage: DurableObjectStorage,
  claimId: string,
  now: number,
): AgentSnapshotProgress | null {
  const validatedClaimId = validateSnapshotClaimId(claimId);
  return storage.transactionSync(() => {
    const state = readCoordinatorState(storage);
    if (state.gate_phase !== 'snapshot' || state.active_snapshot_generation === null) {
      throw new Error('snapshot generation is not active');
    }
    const progress = readAgentSnapshotProgress(storage, state.active_snapshot_generation);
    if (
      progress.claimId !== validatedClaimId &&
      state.gate_expires_at_ms !== null &&
      now < state.gate_expires_at_ms
    ) {
      return null;
    }
    storage.sql.exec(
      'UPDATE snapshot_progress SET claim_id = ? WHERE generation = ?',
      validatedClaimId,
      progress.generation,
    );
    setClaimExpiry(storage, progress.generation, validatedClaimId, now);
    return readAgentSnapshotProgress(storage, progress.generation);
  });
}

export function renewAgentSnapshotClaim(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): AgentSnapshotProgress {
  return storage.transactionSync(() => {
    assertAgentSnapshotClaim(storage, generation, claimId, now);
    setClaimExpiry(storage, generation, claimId, now);
    return readAgentSnapshotProgress(storage, generation);
  });
}

export function releaseAgentSnapshotClaim(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): AgentSnapshotProgress {
  return storage.transactionSync(() => {
    assertAgentSnapshotClaim(storage, generation, claimId, now);
    storage.sql.exec(
      'UPDATE coordinator_state SET gate_expires_at_ms = ? WHERE singleton = 1',
      now,
    );
    return readAgentSnapshotProgress(storage, generation);
  });
}

export function assertAgentSnapshotClaim(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): AgentSnapshotProgress {
  const validatedClaimId = validateSnapshotClaimId(claimId);
  const state = readCoordinatorState(storage);
  if (
    state.gate_phase !== 'snapshot' ||
    state.active_snapshot_generation !== generation ||
    state.gate_expires_at_ms === null ||
    now >= state.gate_expires_at_ms
  ) {
    throw new Error('snapshot claim is not active');
  }
  const progress = readAgentSnapshotProgress(storage, generation);
  if (progress.claimId !== validatedClaimId) throw new Error('snapshot claim owner mismatch');
  return progress;
}

export function assertSnapshotCopyCursor(
  storage: DurableObjectStorage,
  input: {
    generation: number;
    claimId: string;
    copyIndex: number;
    target: string;
    copyAttempt: number;
  },
  now: number,
): AgentSnapshotProgress {
  const progress = assertAgentSnapshotClaim(storage, input.generation, input.claimId, now);
  if (progress.nextCopyIndex !== input.copyIndex) throw new Error('snapshot Copy cursor mismatch');
  const expected = snapshotCopyKey(storage, input.generation, input.copyIndex);
  if (expected.target !== input.target || expected.copyAttempt !== input.copyAttempt) {
    throw new Error('snapshot Copy key does not match its cursor');
  }
  return progress;
}

export function advanceSnapshotCopyCursor(
  storage: DurableObjectStorage,
  generation: number,
  copyIndex: number,
): void {
  const updated = storage.sql.exec(
    `UPDATE snapshot_progress SET next_copy_index = ?
     WHERE generation = ? AND next_copy_index = ?`,
    copyIndex + 1,
    generation,
    copyIndex,
  );
  if (updated.rowsWritten !== 1) throw new Error('snapshot Copy cursor was not advanced');
}

export function deleteAgentSnapshotProgress(
  storage: DurableObjectStorage,
  generation: number,
): void {
  storage.sql.exec('DELETE FROM snapshot_progress WHERE generation = ?', generation);
}

function readAgentSnapshotProgress(
  storage: DurableObjectStorage,
  generation: number,
): AgentSnapshotProgress {
  const row = [
    ...storage.sql.exec<StoredSnapshotProgress>(
      `SELECT generation, next_copy_index, claim_id, manifest_published_at_ms
       FROM snapshot_progress WHERE generation = ?`,
      generation,
    ),
  ][0];
  if (!row) throw new Error('snapshot progress is missing');
  const state = readCoordinatorState(storage);
  if (state.active_snapshot_generation !== generation || state.gate_expires_at_ms === null) {
    throw new Error('snapshot progress does not match coordinator state');
  }
  const totalCopies = snapshotCopyCount(storage, generation);
  if (
    !Number.isSafeInteger(row.next_copy_index) ||
    row.next_copy_index < 0 ||
    row.next_copy_index > totalCopies
  ) {
    throw new Error('snapshot Copy cursor is invalid');
  }
  if (
    row.manifest_published_at_ms !== null &&
    (!Number.isSafeInteger(row.manifest_published_at_ms) || row.manifest_published_at_ms < 0)
  ) {
    throw new Error('snapshot manifest timestamp is invalid');
  }
  return {
    generation: row.generation,
    dirtyDays: [
      ...storage.sql.exec<{ dirty_day: string }>(
        'SELECT dirty_day FROM snapshot_days WHERE generation = ? ORDER BY dirty_day',
        generation,
      ),
    ].map(({ dirty_day }) => dirty_day),
    nextCopyIndex: row.next_copy_index,
    claimId: row.claim_id,
    claimExpiresAtMs: state.gate_expires_at_ms,
    totalCopies,
    ...(row.manifest_published_at_ms === null
      ? {}
      : { manifestPublishedAtMs: row.manifest_published_at_ms }),
  };
}

function snapshotCopyCount(storage: DurableObjectStorage, generation: number): number {
  const days = countSnapshotDays(storage, generation);
  const chunks =
    days <= MAX_AGENT_SNAPSHOT_COPY_DAYS ? 1 : Math.ceil(days / MAX_AGENT_SNAPSHOT_COPY_DAYS);
  return chunks * AGENT_SNAPSHOT_TARGETS.length;
}

function snapshotCopyKey(storage: DurableObjectStorage, generation: number, copyIndex: number) {
  const totalCopies = snapshotCopyCount(storage, generation);
  if (!Number.isSafeInteger(copyIndex) || copyIndex < 0 || copyIndex >= totalCopies) {
    throw new Error('snapshot Copy cursor is complete or invalid');
  }
  const chunkIndex = Math.floor(copyIndex / AGENT_SNAPSHOT_TARGETS.length);
  const chunks = totalCopies / AGENT_SNAPSHOT_TARGETS.length;
  return {
    target: AGENT_SNAPSHOT_TARGETS[copyIndex % AGENT_SNAPSHOT_TARGETS.length],
    copyAttempt:
      chunks === 1 ? generation : generation * AGENT_SNAPSHOT_COPY_ATTEMPT_MULTIPLIER + chunkIndex,
  };
}

function setClaimExpiry(
  storage: DurableObjectStorage,
  generation: number,
  claimId: string,
  now: number,
): void {
  validateSnapshotClaimId(claimId);
  storage.sql.exec(
    `UPDATE coordinator_state SET gate_expires_at_ms = ?
     WHERE singleton = 1 AND gate_phase = 'snapshot' AND active_snapshot_generation = ?`,
    now + MAX_AGENT_SNAPSHOT_LEASE_MS,
    generation,
  );
}

export function validateSnapshotClaimId(claimId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(claimId)) throw new Error('invalid snapshot claim ID');
  return claimId;
}
