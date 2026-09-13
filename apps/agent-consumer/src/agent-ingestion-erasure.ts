import { AGENT_SNAPSHOT_TARGETS } from '@trace-flow/tinybird-client';
import {
  AgentDeliveryCoordinatorRetryableError,
  isAgentSnapshotCopyAttempt,
} from './agent-delivery-coordinator-contract';
import { assertExactKeys } from './agent-delivery-coordinator-validation';
import { countRows, readCoordinatorState } from './agent-delivery-coordinator-storage';

const MAX_OUTSTANDING_SNAPSHOT_COPY_INTENTS = 64;

type SnapshotTarget = (typeof AGENT_SNAPSHOT_TARGETS)[number];

export interface AgentSnapshotCopyIntent {
  generation: number;
  target: SnapshotTarget;
  copyAttempt: number;
  startedAt: number;
  jobId?: string;
}

export interface AgentIngestionErasureState {
  erasureStarted: true;
  startedAt: number;
  activeDeliveries: number;
  incompleteDays: number;
  activeSnapshotGeneration: number | null;
  outstandingCopyIntents: number;
  ready: boolean;
}

interface StoredCopyIntent extends Record<string, string | number | null> {
  generation: number;
  target: string;
  copy_attempt: number;
  started_at_ms: number;
  job_id: string | null;
}

export function initializeAgentIngestionErasure(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS agent_ingestion_erasure (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      started_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshot_copy_intents (
      generation INTEGER NOT NULL,
      target TEXT NOT NULL,
      copy_attempt INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      job_id TEXT,
      PRIMARY KEY (generation, target, copy_attempt)
    );
  `);
}

export function agentIngestionErasureStarted(storage: DurableObjectStorage): boolean {
  return readErasureStartedAt(storage) !== null;
}

export function beginAgentIngestionErasure(
  storage: DurableObjectStorage,
  now: number,
): AgentIngestionErasureState {
  validatePositiveInteger(now, 'erasure startedAt');
  storage.sql.exec(
    'INSERT OR IGNORE INTO agent_ingestion_erasure (singleton, started_at_ms) VALUES (1, ?)',
    now,
  );
  return requireErasureState(storage);
}

export function readAgentIngestionErasureState(
  storage: DurableObjectStorage,
): AgentIngestionErasureState | null {
  return readErasureStartedAt(storage) === null ? null : requireErasureState(storage);
}

export function listSnapshotCopyIntents(storage: DurableObjectStorage): AgentSnapshotCopyIntent[] {
  return [
    ...storage.sql.exec<StoredCopyIntent>(
      `SELECT generation, target, copy_attempt, started_at_ms, job_id
       FROM snapshot_copy_intents ORDER BY generation, target, copy_attempt`,
    ),
  ].map(toCopyIntent);
}

export function recordSnapshotCopyIntent(
  storage: DurableObjectStorage,
  input: AgentSnapshotCopyIntent,
): AgentSnapshotCopyIntent {
  assertExactKeys(
    input,
    ['generation', 'target', 'copyAttempt', 'startedAt'],
    'snapshot Copy intent',
  );
  const intent = validateCopyIntent(input);
  return storage.transactionSync(() => {
    if (agentIngestionErasureStarted(storage)) {
      throw new AgentDeliveryCoordinatorRetryableError('agent ingestion erasure has started');
    }
    const state = readCoordinatorState(storage);
    if (state.gate_phase !== 'snapshot' || state.active_snapshot_generation !== intent.generation) {
      throw new Error('snapshot Copy intent does not match the active generation');
    }
    const existing = findCopyIntent(storage, intent);
    if (existing) throw new Error('snapshot Copy intent already exists');
    if (countCopyIntents(storage) >= MAX_OUTSTANDING_SNAPSHOT_COPY_INTENTS) {
      throw new Error('outstanding snapshot Copy intent limit reached');
    }
    storage.sql.exec(
      `INSERT INTO snapshot_copy_intents
         (generation, target, copy_attempt, started_at_ms, job_id)
       VALUES (?, ?, ?, ?, NULL)`,
      intent.generation,
      intent.target,
      intent.copyAttempt,
      intent.startedAt,
    );
    return intent;
  });
}

export function attachSnapshotCopyJob(
  storage: DurableObjectStorage,
  input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & { jobId: string },
): AgentSnapshotCopyIntent {
  assertExactKeys(input, ['generation', 'target', 'copyAttempt', 'jobId'], 'snapshot Copy job');
  const key = validateCopyKey(input);
  const jobId = validateJobId(input.jobId);
  return storage.transactionSync(() => {
    const stored = requireCopyIntent(storage, key);
    if (stored.job_id !== null && stored.job_id !== jobId) {
      throw new Error('snapshot Copy intent already has a different job');
    }
    if (stored.job_id === null) {
      storage.sql.exec(
        `UPDATE snapshot_copy_intents SET job_id = ?
         WHERE generation = ? AND target = ? AND copy_attempt = ?`,
        jobId,
        key.generation,
        key.target,
        key.copyAttempt,
      );
    }
    return { ...toCopyIntent(stored), jobId };
  });
}

export function settleSnapshotCopyIntent(
  storage: DurableObjectStorage,
  input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & { jobId: string; status: 'done' | 'error' },
  afterSettle?: () => void,
): { removed: true } {
  assertExactKeys(
    input,
    ['generation', 'target', 'copyAttempt', 'jobId', 'status'],
    'settle snapshot Copy intent',
  );
  const key = validateCopyKey(input);
  const jobId = validateJobId(input.jobId);
  if (input.status !== 'done' && input.status !== 'error') {
    throw new Error('snapshot Copy intent status must be terminal');
  }
  return storage.transactionSync(() => {
    const stored = requireCopyIntent(storage, key);
    if (stored.job_id !== jobId) throw new Error('snapshot Copy job does not match its intent');
    storage.sql.exec(
      `DELETE FROM snapshot_copy_intents
       WHERE generation = ? AND target = ? AND copy_attempt = ?`,
      key.generation,
      key.target,
      key.copyAttempt,
    );
    afterSettle?.();
    return { removed: true as const };
  });
}

export function rejectSnapshotCopyIntent(
  storage: DurableObjectStorage,
  input: Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'>,
): { removed: true } {
  assertExactKeys(input, ['generation', 'target', 'copyAttempt'], 'rejected snapshot Copy intent');
  const key = validateCopyKey(input);
  return storage.transactionSync(() => {
    const stored = requireCopyIntent(storage, key);
    if (stored.job_id !== null) throw new Error('started snapshot Copy cannot be rejected');
    storage.sql.exec(
      `DELETE FROM snapshot_copy_intents
       WHERE generation = ? AND target = ? AND copy_attempt = ?`,
      key.generation,
      key.target,
      key.copyAttempt,
    );
    return { removed: true as const };
  });
}

function requireErasureState(storage: DurableObjectStorage): AgentIngestionErasureState {
  const startedAt = readErasureStartedAt(storage);
  if (startedAt === null) throw new Error('agent ingestion erasure has not started');
  const coordinator = readCoordinatorState(storage);
  const activeDeliveries = countRows(storage, 'active_deliveries');
  const incompleteDays = countRows(storage, 'incomplete_days');
  const outstandingCopyIntents = countCopyIntents(storage);
  const activeSnapshotGeneration = coordinator.active_snapshot_generation;
  return {
    erasureStarted: true,
    startedAt,
    activeDeliveries,
    incompleteDays,
    activeSnapshotGeneration,
    outstandingCopyIntents,
    ready:
      activeDeliveries === 0 &&
      incompleteDays === 0 &&
      activeSnapshotGeneration === null &&
      outstandingCopyIntents === 0,
  };
}

function readErasureStartedAt(storage: DurableObjectStorage): number | null {
  return (
    [
      ...storage.sql.exec<{ started_at_ms: number }>(
        'SELECT started_at_ms FROM agent_ingestion_erasure',
      ),
    ][0]?.started_at_ms ?? null
  );
}

function countCopyIntents(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ count: number }>('SELECT COUNT(*) AS count FROM snapshot_copy_intents')
    .one().count;
}

function findCopyIntent(
  storage: DurableObjectStorage,
  key: Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'>,
): StoredCopyIntent | null {
  return (
    [
      ...storage.sql.exec<StoredCopyIntent>(
        `SELECT generation, target, copy_attempt, started_at_ms, job_id
         FROM snapshot_copy_intents
         WHERE generation = ? AND target = ? AND copy_attempt = ?`,
        key.generation,
        key.target,
        key.copyAttempt,
      ),
    ][0] ?? null
  );
}

function requireCopyIntent(
  storage: DurableObjectStorage,
  key: Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'>,
): StoredCopyIntent {
  const stored = findCopyIntent(storage, key);
  if (!stored) throw new Error('unknown snapshot Copy intent');
  return stored;
}

function validateCopyIntent(input: AgentSnapshotCopyIntent): AgentSnapshotCopyIntent {
  if (input.jobId !== undefined) throw new Error('snapshot Copy start intent cannot include jobId');
  return {
    ...validateCopyKey(input),
    startedAt: validatePositiveInteger(input.startedAt, 'startedAt'),
  };
}

function validateCopyKey(
  input: Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'>,
): Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'> {
  const generation = validatePositiveInteger(input.generation, 'snapshot generation');
  const copyAttempt = validatePositiveInteger(input.copyAttempt, 'snapshot CopyAttempt');
  if (!isAgentSnapshotCopyAttempt(generation, copyAttempt)) {
    throw new Error('snapshot CopyAttempt does not match its generation');
  }
  if (!AGENT_SNAPSHOT_TARGETS.includes(input.target))
    throw new Error('invalid snapshot Copy target');
  return { generation, target: input.target, copyAttempt };
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive integer`);
  return value;
}

function validateJobId(value: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(value)) throw new Error('invalid snapshot Copy job ID');
  return value;
}

function toCopyIntent(row: StoredCopyIntent): AgentSnapshotCopyIntent {
  return {
    generation: row.generation,
    target: row.target as SnapshotTarget,
    copyAttempt: row.copy_attempt,
    startedAt: row.started_at_ms,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
  };
}
