import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import type { AgentConsumerEnv } from './context';
import {
  AgentDeliveryCoordinatorRetryableError,
  MAX_ACTIVE_AGENT_DELIVERIES,
  type AgentDeliveryCoordinatorStats,
  type AgentDeliveryReservation,
  type ReserveAgentDeliveryInput,
} from './agent-delivery-coordinator-contract';
import {
  assertDirtyDayCapacity,
  assertMatchingReservation,
  earliestDeliveryId,
  requireReservation,
  requireStoredReservation,
  toDeliveryReservation,
} from './agent-delivery-reservations';
import {
  countRows,
  deleteReservation,
  findReservation,
  initializeCoordinatorSchema,
  insertReservation,
  markDirtyDays,
  pruneRetainedDayMetadata,
  readCoordinatorState,
  readDeliveryDays,
} from './agent-delivery-coordinator-storage';
import {
  assertExactKeys,
  assertNewReservationWindow,
  assertRetainedDaySet,
  validateDaySet,
  validateDeliveryId,
  validateGenerationInput,
  validatePayloadSha256,
  validateReservationInput,
} from './agent-delivery-coordinator-validation';
import {
  assertAgentSnapshotActive,
  beginAgentSnapshot,
  failAgentSnapshot,
  finishAgentSnapshot,
  recoverExpiredSnapshotGate,
  requestAgentSnapshot,
} from './agent-delivery-snapshots';

export * from './agent-delivery-coordinator-contract';

class AgentDeliveryCoordinatorBase extends DurableObject<AgentConsumerEnv> {
  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    initializeCoordinatorSchema(this.ctx.storage);
  }

  bootstrapSequence(input: { lastAssignedSequence: 1 }): { nextDeliverySequence: 2 } {
    assertExactKeys(input, ['lastAssignedSequence'], 'bootstrap sequence');
    if (input.lastAssignedSequence !== 1) {
      throw new Error('bootstrap lastAssignedSequence must be 1');
    }
    this.ctx.storage.transactionSync(() => {
      const state = readCoordinatorState(this.ctx.storage);
      if (
        state.last_delivery_sequence !== 1 ||
        state.last_snapshot_generation !== 0 ||
        state.gate_phase !== 'open' ||
        state.active_snapshot_generation !== null ||
        state.gate_expires_at_ms !== null ||
        countRows(this.ctx.storage, 'active_deliveries') !== 0 ||
        countRows(this.ctx.storage, 'dirty_days') !== 0 ||
        countRows(this.ctx.storage, 'incomplete_days') !== 0 ||
        countRows(this.ctx.storage, 'snapshot_days') !== 0
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
    const now = Date.now();
    recoverExpiredSnapshotGate(this.ctx.storage, now);
    this.ctx.storage.transactionSync(() => pruneRetainedDayMetadata(this.ctx.storage, now));
    return this.ctx.storage.transactionSync(() => {
      const existing = findReservation(this.ctx.storage, reservation.deliveryId);
      if (existing) {
        assertMatchingReservation(this.ctx.storage, existing, reservation);
        return { status: 'existing' as const, deliverySequence: existing.delivery_sequence };
      }
      assertNewReservationWindow(reservation, now);
      const state = readCoordinatorState(this.ctx.storage);
      if (state.gate_phase !== 'open') {
        throw new AgentDeliveryCoordinatorRetryableError('agent snapshot gate is closed');
      }
      if (countRows(this.ctx.storage, 'active_deliveries') >= MAX_ACTIVE_AGENT_DELIVERIES) {
        throw new AgentDeliveryCoordinatorRetryableError('active delivery limit reached');
      }
      if (state.last_delivery_sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error('delivery sequence exhausted');
      }

      const deliverySequence = state.last_delivery_sequence + 1;
      insertReservation(this.ctx.storage, reservation, deliverySequence);
      assertDirtyDayCapacity(this.ctx.storage);
      this.ctx.storage.sql.exec(
        'UPDATE coordinator_state SET last_delivery_sequence = ? WHERE singleton = 1',
        deliverySequence,
      );
      return { status: 'reserved' as const, deliverySequence };
    });
  }

  getReservation(input: { deliveryId: string }): AgentDeliveryReservation | null {
    assertExactKeys(input, ['deliveryId'], 'get reservation');
    const stored = findReservation(this.ctx.storage, validateDeliveryId(input.deliveryId));
    return stored ? toDeliveryReservation(this.ctx.storage, stored) : null;
  }

  acquireWrite(input: { deliveryId: string; payloadSha256: string }): boolean {
    const reservation = requireReservation(this.ctx.storage, input, 'acquire write');
    if (Date.now() >= reservation.expires_at_ms) throw new Error('active delivery has expired');
    return earliestDeliveryId(this.ctx.storage) === reservation.delivery_id;
  }

  expandDirtyDays(input: { deliveryId: string; payloadSha256: string; dirtyDays: string[] }): {
    dirtyDays: string[];
  } {
    assertExactKeys(input, ['deliveryId', 'dirtyDays', 'payloadSha256'], 'expand dirty days');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);
    const additionalDays = validateDaySet(input.dirtyDays, 'expanded dirtyDays');
    const now = Date.now();
    assertRetainedDaySet(additionalDays, now);
    return this.ctx.storage.transactionSync(() => {
      const reservation = requireStoredReservation(this.ctx.storage, deliveryId, payloadSha256);
      if (now >= reservation.expires_at_ms) throw new Error('active delivery has expired');
      if (earliestDeliveryId(this.ctx.storage) !== reservation.delivery_id) {
        throw new AgentDeliveryCoordinatorRetryableError(
          'active delivery does not hold write permit',
        );
      }
      for (const dirtyDay of additionalDays) {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO active_delivery_days (delivery_id, dirty_day) VALUES (?, ?)',
          deliveryId,
          dirtyDay,
        );
      }
      assertDirtyDayCapacity(this.ctx.storage);
      return { dirtyDays: readDeliveryDays(this.ctx.storage, deliveryId) };
    });
  }

  complete(input: { deliveryId: string; payloadSha256: string }): {
    deliverySequence: number;
    dirtyDays: string[];
  } {
    assertExactKeys(input, ['deliveryId', 'payloadSha256'], 'complete delivery');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);
    return this.ctx.storage.transactionSync(() => {
      const reservation = requireStoredReservation(this.ctx.storage, deliveryId, payloadSha256);
      const dirtyDays = readDeliveryDays(this.ctx.storage, deliveryId);
      markDirtyDays(this.ctx.storage, dirtyDays, false);
      deleteReservation(this.ctx.storage, deliveryId);
      pruneRetainedDayMetadata(this.ctx.storage, Date.now());
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
      const reservation = requireStoredReservation(this.ctx.storage, deliveryId, payloadSha256);
      if (Date.now() < reservation.expires_at_ms)
        throw new Error('active delivery has not expired');
      const dirtyDays = readDeliveryDays(this.ctx.storage, deliveryId);
      markDirtyDays(this.ctx.storage, dirtyDays, true);
      deleteReservation(this.ctx.storage, deliveryId);
      pruneRetainedDayMetadata(this.ctx.storage, Date.now());
      return { deliverySequence: reservation.delivery_sequence, dirtyDays };
    });
  }

  resolveIncompleteDays(input: { dirtyDays: string[] }): { resolvedDirtyDays: number } {
    assertExactKeys(input, ['dirtyDays'], 'resolve incomplete days');
    const dirtyDays = validateDaySet(input.dirtyDays, 'recovery dirtyDays');
    return this.ctx.storage.transactionSync(() => {
      for (const dirtyDay of dirtyDays) {
        const count = this.ctx.storage.sql
          .exec<{
            count: number;
          }>('SELECT COUNT(*) AS count FROM incomplete_days WHERE dirty_day = ?', dirtyDay)
          .one().count;
        if (count !== 1) throw new Error('dirty day is not marked incomplete');
      }
      for (const dirtyDay of dirtyDays) {
        this.ctx.storage.sql.exec('DELETE FROM incomplete_days WHERE dirty_day = ?', dirtyDay);
      }
      return { resolvedDirtyDays: dirtyDays.length };
    });
  }

  requestSnapshot(input: Record<string, never>) {
    assertExactKeys(input, [], 'request snapshot');
    return requestAgentSnapshot(this.ctx.storage, Date.now());
  }

  beginSnapshot(input: Record<string, never>) {
    assertExactKeys(input, [], 'begin snapshot');
    return beginAgentSnapshot(this.ctx.storage, Date.now());
  }

  assertSnapshotActive(input: { generation: number }) {
    const generation = validateGenerationInput(input, 'assert snapshot active');
    return assertAgentSnapshotActive(this.ctx.storage, generation, Date.now());
  }

  finishSnapshot(input: { generation: number }) {
    const generation = validateGenerationInput(input, 'finish snapshot');
    return finishAgentSnapshot(this.ctx.storage, generation, Date.now());
  }

  failSnapshot(input: { generation: number }) {
    const generation = validateGenerationInput(input, 'fail snapshot');
    return failAgentSnapshot(this.ctx.storage, generation, Date.now());
  }

  getStats(input: Record<string, never>): AgentDeliveryCoordinatorStats {
    assertExactKeys(input, [], 'get stats');
    const now = Date.now();
    recoverExpiredSnapshotGate(this.ctx.storage, now);
    return this.ctx.storage.transactionSync(() => {
      pruneRetainedDayMetadata(this.ctx.storage, now);
      const state = readCoordinatorState(this.ctx.storage);
      return {
        lastDeliverySequence: state.last_delivery_sequence,
        lastSnapshotGeneration: state.last_snapshot_generation,
        activeDeliveries: countRows(this.ctx.storage, 'active_deliveries'),
        dirtyDays: countRows(this.ctx.storage, 'dirty_days'),
        incompleteDays: countRows(this.ctx.storage, 'incomplete_days'),
        capturedSnapshotDays: countRows(this.ctx.storage, 'snapshot_days'),
        gatePhase: state.gate_phase,
        activeSnapshotGeneration: state.active_snapshot_generation,
        gateExpiresAtMs: state.gate_expires_at_ms,
        databaseSizeBytes: this.ctx.storage.sql.databaseSize,
      };
    });
  }
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
