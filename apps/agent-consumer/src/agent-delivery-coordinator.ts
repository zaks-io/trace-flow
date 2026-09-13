import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import type { AgentConsumerEnv } from './context';

export const MAX_ACTIVE_AGENT_DELIVERIES = 64;
export const MAX_AGENT_DIRTY_DAYS = 366;
export const MAX_AGENT_DELIVERY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

export interface ReserveAgentDeliveryInput {
  deliveryId: string;
  payloadSha256: string;
  dirtyDays: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface AgentDeliveryReservation {
  deliveryId: string;
  payloadSha256: string;
  deliverySequence: number;
  dirtyDays: string[];
  createdAtMs: number;
  expiresAtMs: number;
}

export interface BeginAgentSnapshotResult {
  generation: number;
  dirtyDays: string[];
}

export interface AgentDeliveryCoordinatorStats {
  lastDeliverySequence: number;
  lastSnapshotGeneration: number;
  activeDeliveries: number;
  dirtyDays: number;
  incompleteDays: number;
  capturedSnapshotDays: number;
  gatePhase: 'open' | 'draining' | 'snapshot';
  activeSnapshotGeneration: number | null;
  databaseSizeBytes: number;
}

type CoordinatorState = Record<string, string | number | null> & {
  last_delivery_sequence: number;
  last_snapshot_generation: number;
  gate_phase: 'open' | 'draining' | 'snapshot';
  active_snapshot_generation: number | null;
};

type StoredReservation = Record<string, string | number> & {
  delivery_id: string;
  payload_sha256: string;
  delivery_sequence: number;
  created_at_ms: number;
  expires_at_ms: number;
};

export class AgentDeliveryCoordinatorRetryableError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'AgentDeliveryCoordinatorRetryableError';
  }
}

class AgentDeliveryCoordinatorBase extends DurableObject<AgentConsumerEnv> {
  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    this.initializeSchema();
  }

  bootstrapSequence(input: { lastAssignedSequence: 1 }): { nextDeliverySequence: 2 } {
    assertExactKeys(input, ['lastAssignedSequence'], 'bootstrap sequence');
    if (input.lastAssignedSequence !== 1) {
      throw new Error('bootstrap lastAssignedSequence must be 1');
    }

    this.ctx.storage.transactionSync(() => {
      const state = this.readState();
      if (
        state.last_delivery_sequence !== 1 ||
        state.last_snapshot_generation !== 0 ||
        state.gate_phase !== 'open' ||
        state.active_snapshot_generation !== null ||
        this.countRows('active_deliveries') !== 0 ||
        this.countRows('dirty_days') !== 0 ||
        this.countRows('incomplete_days') !== 0 ||
        this.countRows('snapshot_days') !== 0
      ) {
        throw new Error('delivery sequence bootstrap requires an empty coordinator');
      }
    });

    return { nextDeliverySequence: 2 };
  }

  reserve(input: ReserveAgentDeliveryInput): {
    status: 'reserved' | 'existing';
    deliverySequence: number;
  } {
    const reservation = validateReservationInput(input);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.findReservation(reservation.deliveryId);
      if (existing) {
        this.assertMatchingReservation(existing, reservation);
        return { status: 'existing' as const, deliverySequence: existing.delivery_sequence };
      }
      assertNewReservationWindow(reservation);
      const state = this.readState();
      if (state.gate_phase !== 'open') {
        throw new AgentDeliveryCoordinatorRetryableError('agent snapshot gate is closed');
      }
      if (this.countRows('active_deliveries') >= MAX_ACTIVE_AGENT_DELIVERIES) {
        throw new AgentDeliveryCoordinatorRetryableError('active delivery limit reached');
      }
      if (state.last_delivery_sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error('delivery sequence exhausted');
      }

      const deliverySequence = state.last_delivery_sequence + 1;
      this.ctx.storage.sql.exec(
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
        this.ctx.storage.sql.exec(
          'INSERT INTO active_delivery_days (delivery_id, dirty_day) VALUES (?, ?)',
          reservation.deliveryId,
          dirtyDay,
        );
      }
      if (this.countPendingDirtyDays() > MAX_AGENT_DIRTY_DAYS) {
        throw new AgentDeliveryCoordinatorRetryableError('dirty day limit reached');
      }
      this.ctx.storage.sql.exec(
        'UPDATE coordinator_state SET last_delivery_sequence = ? WHERE singleton = 1',
        deliverySequence,
      );
      return { status: 'reserved' as const, deliverySequence };
    });
  }

  getReservation(input: { deliveryId: string }): AgentDeliveryReservation | null {
    assertExactKeys(input, ['deliveryId'], 'get reservation');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const reservation = this.findReservation(deliveryId);
    return reservation ? this.toReservation(reservation) : null;
  }

  acquireWrite(input: { deliveryId: string; payloadSha256: string }): boolean {
    assertExactKeys(input, ['deliveryId', 'payloadSha256'], 'acquire write');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);
    const reservation = this.findReservation(deliveryId);
    if (!reservation) throw new Error('unknown active delivery');
    if (reservation.payload_sha256 !== payloadSha256) {
      throw new Error('active delivery payload hash mismatch');
    }
    const earliest = this.ctx.storage.sql
      .exec<{
        delivery_id: string;
      }>('SELECT delivery_id FROM active_deliveries ORDER BY delivery_sequence LIMIT 1')
      .one();
    return earliest.delivery_id === deliveryId;
  }

  complete(input: { deliveryId: string; payloadSha256: string }): {
    deliverySequence: number;
    dirtyDays: string[];
  } {
    assertExactKeys(input, ['deliveryId', 'payloadSha256'], 'complete delivery');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);

    return this.ctx.storage.transactionSync(() => {
      const reservation = this.findReservation(deliveryId);
      if (!reservation) throw new Error('unknown active delivery');
      if (reservation.payload_sha256 !== payloadSha256) {
        throw new Error('active delivery payload hash mismatch');
      }
      const dirtyDays = this.readDeliveryDays(deliveryId);
      for (const dirtyDay of dirtyDays) {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO dirty_days (dirty_day) VALUES (?)',
          dirtyDay,
        );
      }
      if (this.countRows('dirty_days') > MAX_AGENT_DIRTY_DAYS) {
        throw new Error('dirty day limit exceeded');
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM active_delivery_days WHERE delivery_id = ?',
        deliveryId,
      );
      this.ctx.storage.sql.exec('DELETE FROM active_deliveries WHERE delivery_id = ?', deliveryId);
      return { deliverySequence: reservation.delivery_sequence, dirtyDays };
    });
  }

  expire(input: { deliveryId: string; payloadSha256: string }): {
    deliverySequence: number;
    dirtyDays: string[];
  } {
    assertExactKeys(input, ['deliveryId', 'payloadSha256'], 'expire delivery');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);
    return this.ctx.storage.transactionSync(() => {
      const reservation = this.findReservation(deliveryId);
      if (!reservation) throw new Error('unknown active delivery');
      if (reservation.payload_sha256 !== payloadSha256) {
        throw new Error('active delivery payload hash mismatch');
      }
      if (Date.now() < reservation.expires_at_ms) {
        throw new Error('active delivery has not expired');
      }
      const dirtyDays = this.readDeliveryDays(deliveryId);
      for (const dirtyDay of dirtyDays) {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO dirty_days (dirty_day) VALUES (?)',
          dirtyDay,
        );
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO incomplete_days (dirty_day) VALUES (?)',
          dirtyDay,
        );
      }
      this.deleteReservation(deliveryId);
      return { deliverySequence: reservation.delivery_sequence, dirtyDays };
    });
  }

  resolveIncompleteDays(input: { dirtyDays: string[] }): { resolvedDirtyDays: number } {
    assertExactKeys(input, ['dirtyDays'], 'resolve incomplete days');
    const dirtyDays = validateDaySet(input.dirtyDays, 'recovery dirtyDays');
    return this.ctx.storage.transactionSync(() => {
      for (const dirtyDay of dirtyDays) {
        const exists = this.ctx.storage.sql
          .exec<{
            count: number;
          }>('SELECT COUNT(*) AS count FROM incomplete_days WHERE dirty_day = ?', dirtyDay)
          .one().count;
        if (exists !== 1) throw new Error('dirty day is not marked incomplete');
      }
      for (const dirtyDay of dirtyDays) {
        this.ctx.storage.sql.exec('DELETE FROM incomplete_days WHERE dirty_day = ?', dirtyDay);
      }
      return { resolvedDirtyDays: dirtyDays.length };
    });
  }

  requestSnapshot(input: Record<string, never>): {
    status: 'draining';
    activeDeliveries: number;
  } {
    assertExactKeys(input, [], 'request snapshot');
    return this.ctx.storage.transactionSync(() => {
      const state = this.readState();
      if (state.gate_phase === 'snapshot') throw new Error('agent snapshot is already in progress');
      if (this.countRows('dirty_days') === 0) throw new Error('agent snapshot has no dirty days');
      const activeDeliveries = this.countRows('active_deliveries');
      if (state.gate_phase === 'open') {
        this.ctx.storage.sql.exec(
          "UPDATE coordinator_state SET gate_phase = 'draining' WHERE singleton = 1",
        );
      }
      return { status: 'draining' as const, activeDeliveries };
    });
  }

  beginSnapshot(input: Record<string, never>): BeginAgentSnapshotResult {
    assertExactKeys(input, [], 'begin snapshot');
    const snapshot = this.ctx.storage.transactionSync(() => {
      const state = this.readState();
      if (state.gate_phase === 'snapshot') {
        throw new Error('agent snapshot is already in progress');
      }
      if (this.countRows('active_deliveries') !== 0) {
        throw new AgentDeliveryCoordinatorRetryableError('active deliveries prevent snapshot');
      }
      const dirtyDays = this.readSnapshotEligibleDays();
      if (dirtyDays.length === 0) {
        this.ctx.storage.sql.exec(
          "UPDATE coordinator_state SET gate_phase = 'open' WHERE singleton = 1",
        );
        return null;
      }
      if (state.last_snapshot_generation >= Number.MAX_SAFE_INTEGER) {
        throw new Error('snapshot generation exhausted');
      }

      const generation = state.last_snapshot_generation + 1;
      for (const dirtyDay of dirtyDays) {
        this.ctx.storage.sql.exec(
          'INSERT INTO snapshot_days (generation, dirty_day) VALUES (?, ?)',
          generation,
          dirtyDay,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE coordinator_state
         SET last_snapshot_generation = ?, gate_phase = 'snapshot', active_snapshot_generation = ?
         WHERE singleton = 1`,
        generation,
        generation,
      );
      return { generation, dirtyDays };
    });
    if (!snapshot)
      throw new Error('agent snapshot has no complete dirty days; recovery is required');
    return snapshot;
  }

  finishSnapshot(input: { generation: number }): { generation: number; clearedDirtyDays: number } {
    const generation = validateGenerationInput(input, 'finish snapshot');
    return this.ctx.storage.transactionSync(() => {
      this.assertActiveSnapshot(generation);
      const clearedDirtyDays = this.countSnapshotDays(generation);
      this.ctx.storage.sql.exec(
        `DELETE FROM dirty_days
         WHERE dirty_day IN (SELECT dirty_day FROM snapshot_days WHERE generation = ?)`,
        generation,
      );
      this.ctx.storage.sql.exec('DELETE FROM snapshot_days WHERE generation = ?', generation);
      this.ctx.storage.sql.exec(
        "UPDATE coordinator_state SET gate_phase = 'open', active_snapshot_generation = NULL WHERE singleton = 1",
      );
      return { generation, clearedDirtyDays };
    });
  }

  failSnapshot(input: { generation: number }): { generation: number; retainedDirtyDays: number } {
    const generation = validateGenerationInput(input, 'fail snapshot');
    return this.ctx.storage.transactionSync(() => {
      this.assertActiveSnapshot(generation);
      const retainedDirtyDays = this.countSnapshotDays(generation);
      this.ctx.storage.sql.exec('DELETE FROM snapshot_days WHERE generation = ?', generation);
      this.ctx.storage.sql.exec(
        "UPDATE coordinator_state SET gate_phase = 'open', active_snapshot_generation = NULL WHERE singleton = 1",
      );
      return { generation, retainedDirtyDays };
    });
  }

  getStats(input: Record<string, never>): AgentDeliveryCoordinatorStats {
    assertExactKeys(input, [], 'get stats');
    const state = this.readState();
    return {
      lastDeliverySequence: state.last_delivery_sequence,
      lastSnapshotGeneration: state.last_snapshot_generation,
      activeDeliveries: this.countRows('active_deliveries'),
      dirtyDays: this.countRows('dirty_days'),
      incompleteDays: this.countRows('incomplete_days'),
      capturedSnapshotDays: this.countRows('snapshot_days'),
      gatePhase: state.gate_phase,
      activeSnapshotGeneration: state.active_snapshot_generation,
      databaseSizeBytes: this.ctx.storage.sql.databaseSize,
    };
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_delivery_sequence INTEGER NOT NULL,
        last_snapshot_generation INTEGER NOT NULL,
        gate_phase TEXT NOT NULL CHECK (gate_phase IN ('open', 'draining', 'snapshot')),
        active_snapshot_generation INTEGER
      );
      -- Revision 1 belongs to imported baseline rows, so live deliveries always start at 2.
      INSERT OR IGNORE INTO coordinator_state
        (singleton, last_delivery_sequence, last_snapshot_generation, gate_phase, active_snapshot_generation)
        VALUES (1, 1, 0, 'open', NULL);
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

  private readState(): CoordinatorState {
    return this.ctx.storage.sql
      .exec<CoordinatorState>(
        `SELECT last_delivery_sequence, last_snapshot_generation, gate_phase,
                active_snapshot_generation
         FROM coordinator_state WHERE singleton = 1`,
      )
      .one();
  }

  private findReservation(deliveryId: string): StoredReservation | null {
    return (
      [
        ...this.ctx.storage.sql.exec<StoredReservation>(
          `SELECT delivery_id, payload_sha256, delivery_sequence, created_at_ms, expires_at_ms
         FROM active_deliveries WHERE delivery_id = ?`,
          deliveryId,
        ),
      ][0] ?? null
    );
  }

  private assertMatchingReservation(
    existing: StoredReservation,
    requested: ReserveAgentDeliveryInput,
  ): void {
    if (existing.payload_sha256 !== requested.payloadSha256) {
      throw new Error('active delivery payload hash mismatch');
    }
    if (!sameStrings(this.readDeliveryDays(existing.delivery_id), requested.dirtyDays)) {
      throw new Error('active delivery dirty days mismatch');
    }
    if (
      existing.created_at_ms !== requested.createdAtMs ||
      existing.expires_at_ms !== requested.expiresAtMs
    ) {
      throw new Error('active delivery retention metadata mismatch');
    }
  }

  private toReservation(stored: StoredReservation): AgentDeliveryReservation {
    return {
      deliveryId: stored.delivery_id,
      payloadSha256: stored.payload_sha256,
      deliverySequence: stored.delivery_sequence,
      dirtyDays: this.readDeliveryDays(stored.delivery_id),
      createdAtMs: stored.created_at_ms,
      expiresAtMs: stored.expires_at_ms,
    };
  }

  private readDeliveryDays(deliveryId: string): string[] {
    return [
      ...this.ctx.storage.sql.exec<{ dirty_day: string }>(
        `SELECT dirty_day FROM active_delivery_days
         WHERE delivery_id = ? ORDER BY dirty_day`,
        deliveryId,
      ),
    ].map((row) => row.dirty_day);
  }

  private readSnapshotEligibleDays(): string[] {
    return [
      ...this.ctx.storage.sql.exec<{ dirty_day: string }>(
        `SELECT dirty_day FROM dirty_days
         WHERE dirty_day NOT IN (SELECT dirty_day FROM incomplete_days)
         ORDER BY dirty_day`,
      ),
    ].map((row) => row.dirty_day);
  }

  private countRows(
    table: 'active_deliveries' | 'dirty_days' | 'incomplete_days' | 'snapshot_days',
  ): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
      .one().count;
  }

  private countPendingDirtyDays(): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT dirty_day FROM dirty_days
           UNION
           SELECT dirty_day FROM active_delivery_days
         )`,
      )
      .one().count;
  }

  private countSnapshotDays(generation: number): number {
    return this.ctx.storage.sql
      .exec<{
        count: number;
      }>('SELECT COUNT(*) AS count FROM snapshot_days WHERE generation = ?', generation)
      .one().count;
  }

  private assertActiveSnapshot(generation: number): void {
    if (this.readState().active_snapshot_generation !== generation) {
      throw new Error('snapshot generation is not active');
    }
  }

  private deleteReservation(deliveryId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM active_delivery_days WHERE delivery_id = ?', deliveryId);
    this.ctx.storage.sql.exec('DELETE FROM active_deliveries WHERE delivery_id = ?', deliveryId);
  }
}

function validateReservationInput(input: ReserveAgentDeliveryInput): ReserveAgentDeliveryInput {
  assertExactKeys(
    input,
    ['createdAtMs', 'deliveryId', 'dirtyDays', 'expiresAtMs', 'payloadSha256'],
    'reserve delivery',
  );
  return {
    deliveryId: validateDeliveryId(input.deliveryId),
    payloadSha256: validatePayloadSha256(input.payloadSha256),
    dirtyDays: validateDaySet(input.dirtyDays, 'delivery dirtyDays'),
    createdAtMs: validateTimestamp(input.createdAtMs, 'delivery createdAtMs'),
    expiresAtMs: validateTimestamp(input.expiresAtMs, 'delivery expiresAtMs'),
  };
}

function assertNewReservationWindow(reservation: ReserveAgentDeliveryInput): void {
  const now = Date.now();
  if (reservation.createdAtMs > now)
    throw new Error('delivery createdAtMs cannot be in the future');
  if (reservation.expiresAtMs <= now) throw new Error('delivery expiresAtMs must be in the future');
  if (reservation.expiresAtMs <= reservation.createdAtMs) {
    throw new Error('delivery expiresAtMs must be after createdAtMs');
  }
  if (reservation.expiresAtMs - reservation.createdAtMs > MAX_AGENT_DELIVERY_RETENTION_MS) {
    throw new Error('delivery retention exceeds four days');
  }
  for (const dirtyDay of reservation.dirtyDays) assertRetainedDirtyDay(dirtyDay, now);
}

function validateDeliveryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('deliveryId must be a non-empty printable string of at most 256 characters');
  }
  return value;
}

function validatePayloadSha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('payloadSha256 must be 64 lowercase hexadecimal characters');
  }
  return value;
}

function validateDaySet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (value.length > MAX_AGENT_DIRTY_DAYS) throw new Error(`${label} has too many days`);
  const dirtyDays = [...new Set(value.map(validateCalendarDay))].sort();
  return dirtyDays;
}

function validateCalendarDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('dirty day must use YYYY-MM-DD');
  }
  const dayMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== value) {
    throw new Error('dirty day is not a calendar date');
  }
  return value;
}

function assertRetainedDirtyDay(value: string, now: number): void {
  const dayMs = Date.parse(`${value}T00:00:00.000Z`);
  const today = new Date(now);
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const oldestRetainedMs = todayMs - (MAX_AGENT_DIRTY_DAYS - 1) * 86_400_000;
  if (dayMs < oldestRetainedMs || dayMs > todayMs) {
    throw new Error('dirty day is outside the retained fact window');
  }
}

function validateTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateGenerationInput(input: { generation: number }, operation: string): number {
  assertExactKeys(input, ['generation'], operation);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('snapshot generation must be a positive safe integer');
  }
  return input.generation;
}

function assertExactKeys(
  value: unknown,
  expected: string[],
  operation: string,
): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${operation} input must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (!sameStrings(keys, [...expected].sort())) {
    throw new Error(`${operation} input has unexpected fields`);
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const AgentDeliveryCoordinator = Sentry.instrumentDurableObjectWithSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    // The calling Worker appends RPC trace metadata, which only an instrumented DO strips.
    enableRpcTracePropagation: true,
  }),
  AgentDeliveryCoordinatorBase,
);

export type AgentDeliveryCoordinatorInstance = InstanceType<typeof AgentDeliveryCoordinator>;
