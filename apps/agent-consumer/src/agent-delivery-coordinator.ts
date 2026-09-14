import {
  baselineCopyCheckpoint,
  beginBaselineCopy,
  beginBaselineMigrationWindow,
  confirmBaselineCopy,
  retryBaselineCopy,
  type BaselineCopyCheckpoint,
  type BaselineMigrationWindow,
  type BeginBaselineCopyInput,
  type ConfirmBaselineCopyInput,
  type RetryBaselineCopyInput,
} from './baseline-copy-migration';
import {
  initializeIngestionMigration,
  ingestionMigrationState,
  seedIngestionMigration,
  completeIngestionMigration,
} from './ingestion-migration';
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { DurableObject } from 'cloudflare:workers';
import type { AgentConsumerEnv } from './context';
import {
  publishAgentSnapshot,
  scheduleAgentSnapshot,
  scheduleAgentSnapshotContinuation,
} from './snapshot-schedule';
import {
  AgentDeliveryCoordinatorRetryableError,
  MAX_ACTIVE_AGENT_DELIVERIES,
  type AgentDirtyDayLink,
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
  replaceDeliveryDays,
} from './agent-delivery-coordinator-storage';
import {
  assertExactKeys,
  assertNewReservationWindow,
  assertRetainedDaySet,
  validateDaySet,
  validateDeliveryPlanDays,
  validateDeliveryId,
  validateGenerationInput,
  validatePayloadSha256,
  validateReservationInput,
} from './agent-delivery-coordinator-validation';
import { linkDirtyDays as persistDirtyDayLinks } from './agent-delivery-dirty-graph';
import {
  assertAgentSnapshotActive,
  beginAgentSnapshot,
  failAgentSnapshot,
  finishAgentSnapshot,
  recoverExpiredSnapshotGate,
  requestAgentSnapshot,
} from './agent-delivery-snapshots';
import {
  agentIngestionErasureStarted,
  attachSnapshotCopyJob,
  beginAgentIngestionErasure,
  initializeAgentIngestionErasure,
  listSnapshotCopyIntents,
  readAgentIngestionErasureState,
  recordSnapshotCopyIntent,
  rejectSnapshotCopyIntent,
  settleSnapshotCopyIntent,
  type AgentSnapshotCopyIntent,
} from './agent-ingestion-erasure';
import {
  advanceSnapshotCopyCursor,
  assertAgentSnapshotClaim,
  assertSnapshotCopyCursor,
  claimAgentSnapshot,
  initializeAgentSnapshotProgress,
  prepareSnapshotManifest,
  releaseAgentSnapshotClaim,
  renewAgentSnapshotClaim,
  validateSnapshotClaimId,
} from './agent-snapshot-progress';
import {
  beginLegacyRetirement,
  completeLegacyRetirement,
  initializeLegacyRetirement,
  readLegacyRetirement,
  type LegacyRetirementProof,
} from './legacy-retirement';

export * from './agent-delivery-coordinator-contract';
export * from './agent-ingestion-erasure';
export * from './legacy-retirement';

class AgentDeliveryCoordinatorBase extends DurableObject<AgentConsumerEnv> {
  constructor(state: DurableObjectState, env: AgentConsumerEnv) {
    super(state, env);
    initializeCoordinatorSchema(this.ctx.storage);
    initializeIngestionMigration(this.ctx.storage);
    initializeAgentIngestionErasure(this.ctx.storage);
    initializeAgentSnapshotProgress(this.ctx.storage);
    initializeLegacyRetirement(this.ctx.storage);
  }

  getBaselineCopy(input: { category: BaselineCopyCheckpoint['category'] }) {
    return baselineCopyCheckpoint(this.ctx.storage, input.category);
  }
  beginBaselineCopy(input: BeginBaselineCopyInput) {
    return beginBaselineCopy(this.ctx.storage, input);
  }
  confirmBaselineCopy(input: ConfirmBaselineCopyInput) {
    return confirmBaselineCopy(this.ctx.storage, input);
  }
  retryBaselineCopy(input: RetryBaselineCopyInput) {
    return retryBaselineCopy(this.ctx.storage, input);
  }
  beginBaselineMigrationWindow(input: BaselineMigrationWindow) {
    return beginBaselineMigrationWindow(this.ctx.storage, input);
  }

  getIngestionMigrationState() {
    return ingestionMigrationState(this.ctx.storage);
  }

  getLegacyRetirement(input: Record<string, never>) {
    assertExactKeys(input, [], 'get legacy retirement');
    return readLegacyRetirement(this.ctx.storage);
  }

  beginLegacyRetirement(input: LegacyRetirementProof) {
    return beginLegacyRetirement(this.ctx.storage, input);
  }

  completeLegacyRetirement(input: { verificationSha256: string }) {
    assertExactKeys(input, ['verificationSha256'], 'complete legacy retirement');
    return completeLegacyRetirement(this.ctx.storage, input.verificationSha256, Date.now());
  }

  seedIngestionMigration(input: { proofSha256: string; dirtyDays: string[] }) {
    assertExactKeys(input, ['proofSha256', 'dirtyDays'], 'seed ingestion migration');
    return seedIngestionMigration(this.ctx.storage, input);
  }

  completeIngestionMigration(input: { proofSha256: string }) {
    assertExactKeys(input, ['proofSha256'], 'complete ingestion migration');
    return completeIngestionMigration(this.ctx.storage, input.proofSha256);
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
        countRows(this.ctx.storage, 'snapshot_days') !== 0 ||
        agentIngestionErasureStarted(this.ctx.storage) ||
        listSnapshotCopyIntents(this.ctx.storage).length !== 0
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
    const migration = ingestionMigrationState(this.ctx.storage);
    if (migration && !migration.complete)
      throw new AgentDeliveryCoordinatorRetryableError(
        'Ingestion baseline migration is incomplete',
      );
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
      this.assertIngestionNotErasing();
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

  getNextDelivery(): AgentDeliveryReservation | null {
    if (countRows(this.ctx.storage, 'active_deliveries') === 0) return null;
    const id = earliestDeliveryId(this.ctx.storage);
    const stored = findReservation(this.ctx.storage, id);
    if (!stored) throw new Error('Next delivery reservation is missing');
    return toDeliveryReservation(this.ctx.storage, stored);
  }

  acquireWrite(input: { deliveryId: string; payloadSha256: string }): boolean {
    const reservation = requireReservation(this.ctx.storage, input, 'acquire write');
    if (Date.now() >= reservation.expires_at_ms) throw new Error('active delivery has expired');
    return earliestDeliveryId(this.ctx.storage) === reservation.delivery_id;
  }

  replaceDirtyDays(input: { deliveryId: string; payloadSha256: string; dirtyDays: string[] }): {
    dirtyDays: string[];
  } {
    assertExactKeys(input, ['deliveryId', 'dirtyDays', 'payloadSha256'], 'replace dirty days');
    const deliveryId = validateDeliveryId(input.deliveryId);
    const payloadSha256 = validatePayloadSha256(input.payloadSha256);
    const dirtyDays = validateDeliveryPlanDays(input.dirtyDays);
    const now = Date.now();
    assertRetainedDaySet(dirtyDays, now);
    return this.ctx.storage.transactionSync(() => {
      const reservation = requireStoredReservation(this.ctx.storage, deliveryId, payloadSha256);
      if (now >= reservation.expires_at_ms) throw new Error('active delivery has expired');
      if (earliestDeliveryId(this.ctx.storage) !== reservation.delivery_id) {
        throw new AgentDeliveryCoordinatorRetryableError(
          'active delivery does not hold write permit',
        );
      }
      replaceDeliveryDays(this.ctx.storage, deliveryId, dirtyDays);
      assertDirtyDayCapacity(this.ctx.storage);
      return { dirtyDays: readDeliveryDays(this.ctx.storage, deliveryId) };
    });
  }

  linkDirtyDays(input: { deliveryId: string; payloadSha256: string; links: AgentDirtyDayLink[] }): {
    linkedEdges: number;
  } {
    return persistDirtyDayLinks(this.ctx.storage, input, Date.now());
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
    this.assertIngestionNotErasing();
    return requestAgentSnapshot(this.ctx.storage, Date.now());
  }

  beginSnapshot(input: { claimId: string }) {
    assertExactKeys(input, ['claimId'], 'begin snapshot');
    this.assertIngestionNotErasing();
    return beginAgentSnapshot(this.ctx.storage, validateSnapshotClaimId(input.claimId), Date.now());
  }

  claimSnapshot(input: { claimId: string }) {
    assertExactKeys(input, ['claimId'], 'claim snapshot');
    this.assertIngestionNotErasing();
    return claimAgentSnapshot(this.ctx.storage, input.claimId, Date.now());
  }

  getSnapshotProgress(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'get snapshot progress');
    return assertAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
  }

  renewSnapshotClaim(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'renew snapshot claim');
    this.assertIngestionNotErasing();
    return renewAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
  }

  releaseSnapshotClaim(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'release snapshot claim');
    return releaseAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
  }

  prepareSnapshotManifest(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'prepare snapshot manifest');
    this.assertIngestionNotErasing();
    assertAgentSnapshotActive(this.ctx.storage, generation, Date.now());
    return prepareSnapshotManifest(this.ctx.storage, generation, claimId, Date.now());
  }

  assertSnapshotActive(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'assert snapshot active');
    this.assertIngestionNotErasing();
    assertAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
    return assertAgentSnapshotActive(this.ctx.storage, generation, Date.now());
  }

  finishSnapshot(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'finish snapshot');
    const progress = assertAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
    assertAgentSnapshotActive(this.ctx.storage, generation, Date.now());
    if (progress.nextCopyIndex !== progress.totalCopies) {
      throw new Error('snapshot Copy progress is incomplete');
    }
    if (listSnapshotCopyIntents(this.ctx.storage).length !== 0) {
      throw new Error('snapshot has outstanding Copy intents');
    }
    return finishAgentSnapshot(this.ctx.storage, generation, Date.now());
  }

  failSnapshot(input: { generation: number; claimId: string }) {
    const { generation, claimId } = this.validateSnapshotClaim(input, 'fail snapshot');
    assertAgentSnapshotClaim(this.ctx.storage, generation, claimId, Date.now());
    if (listSnapshotCopyIntents(this.ctx.storage).length !== 0) {
      throw new Error('snapshot has outstanding Copy intents');
    }
    return failAgentSnapshot(this.ctx.storage, generation, Date.now());
  }

  async scheduleSnapshot(input: { orgId: string }): Promise<{ scheduled: boolean }> {
    assertExactKeys(input, ['orgId'], 'schedule snapshot');
    if (!input.orgId || input.orgId.length > 256 || input.orgId.includes(':')) {
      throw new Error('Invalid snapshot organization');
    }
    if (agentIngestionErasureStarted(this.ctx.storage)) {
      await this.ctx.storage.deleteAlarm();
      return { scheduled: false };
    }
    await scheduleAgentSnapshot(this.ctx.storage, input.orgId);
    return { scheduled: true };
  }

  async scheduleSnapshotContinuation(input: { orgId: string }): Promise<{ scheduled: boolean }> {
    assertExactKeys(input, ['orgId'], 'schedule snapshot continuation');
    if (!input.orgId || input.orgId.length > 256 || input.orgId.includes(':')) {
      throw new Error('Invalid snapshot organization');
    }
    if (agentIngestionErasureStarted(this.ctx.storage)) return { scheduled: false };
    await scheduleAgentSnapshotContinuation(this.ctx.storage, input.orgId);
    return { scheduled: true };
  }

  async alarm(): Promise<void> {
    const stats = this.getStats({});
    if (stats.erasureStarted) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await publishAgentSnapshot(this.ctx.storage, this.env.AGENT_SNAPSHOT_QUEUE, stats);
  }

  async beginErasure(input: Record<string, never>) {
    assertExactKeys(input, [], 'begin agent ingestion erasure');
    this.recoverCoordinatorMetadata();
    const state = beginAgentIngestionErasure(this.ctx.storage, Date.now());
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('snapshot_org_id');
    return state;
  }

  getErasureState(input: Record<string, never>) {
    assertExactKeys(input, [], 'get agent ingestion erasure');
    this.recoverCoordinatorMetadata();
    return readAgentIngestionErasureState(this.ctx.storage);
  }

  getOutstandingSnapshotCopyIntents(input: Record<string, never>) {
    assertExactKeys(input, [], 'get outstanding snapshot Copy intents');
    return listSnapshotCopyIntents(this.ctx.storage);
  }

  recordSnapshotCopyIntent(
    input: AgentSnapshotCopyIntent & { claimId: string; copyIndex: number },
  ) {
    const { claimId, copyIndex, ...intent } = input;
    this.assertIngestionNotErasing();
    assertSnapshotCopyCursor(this.ctx.storage, { ...intent, claimId, copyIndex }, Date.now());
    return recordSnapshotCopyIntent(this.ctx.storage, intent);
  }

  attachSnapshotCopyJob(
    input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & {
      claimId: string;
      copyIndex: number;
      jobId: string;
    },
  ) {
    const { claimId, copyIndex, ...job } = input;
    assertSnapshotCopyCursor(this.ctx.storage, { ...job, claimId, copyIndex }, Date.now());
    return attachSnapshotCopyJob(this.ctx.storage, job);
  }

  settleSnapshotCopyIntent(
    input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & {
      claimId: string;
      copyIndex: number;
      jobId: string;
      status: 'done' | 'error';
    },
  ) {
    const { claimId, copyIndex, ...job } = input;
    assertSnapshotCopyCursor(this.ctx.storage, { ...job, claimId, copyIndex }, Date.now());
    return settleSnapshotCopyIntent(this.ctx.storage, job, () => {
      if (job.status === 'done') {
        advanceSnapshotCopyCursor(this.ctx.storage, job.generation, copyIndex);
      }
    });
  }

  rejectSnapshotCopyIntent(
    input: Pick<AgentSnapshotCopyIntent, 'generation' | 'target' | 'copyAttempt'> & {
      claimId: string;
      copyIndex: number;
    },
  ) {
    const { claimId, copyIndex, ...key } = input;
    assertSnapshotCopyCursor(this.ctx.storage, { ...key, claimId, copyIndex }, Date.now());
    return rejectSnapshotCopyIntent(this.ctx.storage, key);
  }

  attachErasureSnapshotCopyJob(
    input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & { jobId: string },
  ) {
    if (!agentIngestionErasureStarted(this.ctx.storage)) {
      throw new Error('snapshot Copy erasure settlement requires an erasure tombstone');
    }
    return attachSnapshotCopyJob(this.ctx.storage, input);
  }

  settleErasureSnapshotCopyIntent(
    input: Omit<AgentSnapshotCopyIntent, 'startedAt'> & {
      jobId: string;
      status: 'done' | 'error';
    },
  ) {
    if (!agentIngestionErasureStarted(this.ctx.storage)) {
      throw new Error('snapshot Copy erasure settlement requires an erasure tombstone');
    }
    return settleSnapshotCopyIntent(this.ctx.storage, input);
  }

  abandonErasureSnapshot(input: { generation: number }) {
    const generation = validateGenerationInput(input, 'abandon erasure snapshot');
    if (!agentIngestionErasureStarted(this.ctx.storage)) {
      throw new Error('snapshot abandonment requires an erasure tombstone');
    }
    if (listSnapshotCopyIntents(this.ctx.storage).length !== 0) {
      throw new Error('snapshot has outstanding Copy intents');
    }
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
        dirtyDayLinks: countRows(this.ctx.storage, 'dirty_day_links'),
        capturedSnapshotDays: countRows(this.ctx.storage, 'snapshot_days'),
        gatePhase: state.gate_phase,
        activeSnapshotGeneration: state.active_snapshot_generation,
        gateExpiresAtMs: state.gate_expires_at_ms,
        erasureStarted: agentIngestionErasureStarted(this.ctx.storage),
        databaseSizeBytes: this.ctx.storage.sql.databaseSize,
      };
    });
  }

  private recoverCoordinatorMetadata(): void {
    const now = Date.now();
    recoverExpiredSnapshotGate(this.ctx.storage, now);
    this.ctx.storage.transactionSync(() => pruneRetainedDayMetadata(this.ctx.storage, now));
  }

  private assertIngestionNotErasing(): void {
    if (agentIngestionErasureStarted(this.ctx.storage)) {
      throw new AgentDeliveryCoordinatorRetryableError('agent ingestion erasure has started');
    }
  }

  private validateSnapshotClaim(
    input: { generation: number; claimId: string },
    label: string,
  ): { generation: number; claimId: string } {
    assertExactKeys(input, ['generation', 'claimId'], label);
    return {
      generation: validateGenerationInput({ generation: input.generation }, label),
      claimId: validateSnapshotClaimId(input.claimId),
    };
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
