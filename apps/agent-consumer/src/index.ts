import type { BaselineCopyCheckpoint, BaselineMigrationWindow } from './baseline-copy-migration';
/**
 * Queue entrypoint for encrypted fact deliveries and published analytics snapshots.
 * Legacy queue messages remain supported during migration and frozen-fact recovery.
 * See docs/adr/0024-bounded-agent-ingestion.md for durability and retention contracts.
 */
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';
import { processAgentBatch } from './consumer';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AgentFactBatcherInstance } from './fact-batcher';
import type {
  BeginFactRebuildInput,
  BeginFactRebuildResult,
  CompleteFactRebuildInput,
  CompleteFactRebuildResult,
  ListRebuildFactsInput,
  ListRebuildFactsResult,
} from './fact-maintenance';
import type {
  ReconcileRecoveryInput,
  RecoveryPage,
  RecoveryPageOptions,
  RecoveryRecord,
  ReplayDlqInput,
} from '@trace-flow/tinybird-client';
import { requireRecoveryReason } from '@trace-flow/tinybird-client';
import { normalizeDlqExcerptByteLimits } from './dlq-excerpt-repair';
import type { AgentDeliveryStagedReference, AgentIngestQueueMessage } from '@trace-flow/types';
import { validateAgentIngestQueueMessage } from '@trace-flow/types';
import { validateAgentDeliveryStagedReference } from '@trace-flow/utils';
import { hasDeliveryReferenceType, processDeliveryReferences } from './delivery-queue';
import { AGENT_SNAPSHOT_QUEUE_NAMES, processSnapshotQueue } from './snapshot-queue';
import { agentIngestionErasureStarted, processMigratedLegacyMessages } from './legacy-delivery';
import { eraseAgentOrganization } from './organization-erasure';
import { MAX_ACTIVE_AGENT_DELIVERIES } from './agent-delivery-coordinator-contract';
import { replayAgentDlqPayload } from './dlq-replay';
import { replayFrozenFactSelection, type FrozenFactReplayConfirmation } from './frozen-fact-replay';
import type {
  FrozenFactIdentity,
  FrozenFactSelector,
  ReplayFrozenFactsInput,
} from './frozen-fact-recovery';
import type {
  CompactFactRepairDuplicatesInput,
  CompactFactRepairDuplicatesResult,
  InspectFactRepairCapacityInput,
  InspectFactRepairCapacityResult,
  QuiesceFactRepairCapacityInput,
  QuiesceFactRepairCapacityResult,
} from './fact-repair-capacity';
import type { LegacyRetirementProof } from './legacy-retirement';
import type { ReconcileFrozenRepairsInput } from './frozen-repair-reconciliation-contract';

export { processAgentBatch } from './consumer';
export { AgentFactBatcher } from './fact-batcher';
export { AgentDelivery } from './agent-delivery';
export { AgentDeliveryCoordinator } from './agent-delivery-coordinator';

const AGENT_DLQ_NAMES = new Set(['agent-ingest-dlq-dev', 'agent-ingest-dlq-prod']);
const DLQ_PRESERVATION_RETRY_DELAY_SECONDS = 60;
const DLQ_PRESERVATION_MAX_RETRY_DELAY_SECONDS = 14_400;

interface ExcerptByteLimitRepair {
  kind: 'excerpt-byte-limits';
  expectedPayloadSha256: string;
  expectedOrgId: string;
}

interface AgentReplayDlqInput extends ReplayDlqInput {
  repair?: ExcerptByteLimitRepair;
}

function getAgentBatcher(
  env: AgentConsumerEnv,
  shardId: string,
): DurableObjectStub<AgentFactBatcherInstance> {
  const normalized = normalizeAgentShardId(shardId);
  return env.AGENT_FACT_BATCHER.getByName(`org:${normalized}`);
}

function normalizeAgentShardId(shardId: string): string {
  const normalized = shardId.trim();
  if (!normalized || normalized.length > 256 || normalized.includes(':')) {
    throw new Error('agent shardId must be a non-empty org ID without a colon');
  }
  return normalized;
}

async function preserveDeadLetterBatch(
  batch: MessageBatch<unknown>,
  env: AgentConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      // Keep dead letters independent of an organization batcher that may be full or unavailable.
      const shardId = '__dlq__';
      const sink = getAgentBatcher(env, shardId);
      const payload = JSON.stringify({
        queue: batch.queue,
        messageId: message.id,
        body: message.body,
      });
      const record = await sink.preserveDlq(
        payload,
        JSON.stringify({ reason: 'dead_letter_queue_delivery' }),
        message.id,
      );
      if (!validateAgentIngestQueueMessage(message.body)) {
        const orgId = (message.body as AgentIngestQueueMessage).tenancy.org_id;
        if (await agentIngestionErasureStarted(env, orgId)) {
          await sink.discardDlq(record.id, await sha256Hex(payload));
        }
      }
      message.ack();
      Sentry.captureMessage('agent_consumer.dead_letter_preserved', {
        level: 'error',
        tags: { operation: 'dlq_preserve' },
        extra: { shardId, messageId: message.id },
      });
    } catch (error) {
      message.retry({
        delaySeconds: Math.min(
          DLQ_PRESERVATION_RETRY_DELAY_SECONDS * 2 ** (message.attempts - 1),
          DLQ_PRESERVATION_MAX_RETRY_DELAY_SECONDS,
        ),
      });
      Sentry.captureException(error, {
        level: 'fatal',
        tags: { operation: 'dlq_preserve' },
        extra: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
      });
    }
  }
}

async function excludeErasedDeadLetters(
  messages: Message<unknown>[],
  env: AgentConsumerEnv,
): Promise<Message<unknown>[]> {
  const retained: Message<unknown>[] = [];
  for (const message of messages) {
    try {
      if (validateAgentIngestQueueMessage(message.body)) {
        retained.push(message);
        continue;
      }
      const orgId = (message.body as AgentIngestQueueMessage).tenancy.org_id;
      if (await agentIngestionErasureStarted(env, orgId)) message.ack();
      else retained.push(message);
    } catch (error) {
      message.retry({ delaySeconds: DLQ_PRESERVATION_RETRY_DELAY_SECONDS });
      Sentry.captureException(error, {
        tags: { operation: 'dlq_erasure_check' },
        extra: { messageId: message.id },
      });
    }
  }
  return retained;
}

const handler = {
  // The queue delivers untrusted bytes; `processAgentBatch` validates each body structurally and
  // dead-letters anything off-contract, so the handler accepts `unknown` rather than asserting shape.
  async queue(batch: MessageBatch<unknown>, env: AgentConsumerEnv): Promise<void> {
    if (AGENT_SNAPSHOT_QUEUE_NAMES.has(batch.queue)) {
      await processSnapshotQueue(batch, env);
      return;
    }
    const references = batch.messages.filter((message) => hasDeliveryReferenceType(message.body));
    await processDeliveryReferences(references, env);
    const inline = batch.messages.filter((message) => !hasDeliveryReferenceType(message.body));
    if (inline.length === 0) return;
    if (AGENT_DLQ_NAMES.has(batch.queue)) {
      const retained = await excludeErasedDeadLetters(inline, env);
      if (retained.length > 0) await preserveDeadLetterBatch({ ...batch, messages: retained }, env);
      return;
    }
    const legacy = await processMigratedLegacyMessages(inline, env);
    if (legacy.length > 0) await processAgentBatch({ ...batch, messages: legacy }, env);
  },
};

export class AgentIngestion extends WorkerEntrypoint<AgentConsumerEnv> {
  eraseOrganization(
    orgId: string,
    afterId?: number,
  ): Promise<{ ready: boolean; nextAfterId?: number }> {
    return eraseAgentOrganization(this.env, normalizeAgentShardId(orgId), afterId);
  }

  async canAcceptDeliveries(orgId: string): Promise<boolean> {
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    const [stats, migration] = await Promise.all([
      coordinator.getStats({}),
      coordinator.getIngestionMigrationState(),
    ]);
    return (
      !stats.erasureStarted &&
      stats.gatePhase === 'open' &&
      stats.activeDeliveries < MAX_ACTIVE_AGENT_DELIVERIES &&
      (migration === null || migration.complete)
    );
  }

  async registerDelivery(reference: AgentDeliveryStagedReference, days: string[]): Promise<number> {
    if (validateAgentDeliveryStagedReference(reference))
      throw new Error('Invalid delivery registration');
    return this.env.AGENT_DELIVERY.getByName(reference.key).register(reference, days);
  }
}

export class TraceRecovery extends WorkerEntrypoint<AgentConsumerEnv> {
  beginBaselineMigrationWindow(_shardId: string, input: BaselineMigrationWindow) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      'migration:bounded-agent-ingestion-v1',
    ).beginBaselineMigrationWindow(input);
  }
  getBaselineCopy(orgId: string, input: { category: BaselineCopyCheckpoint['category'] }) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      `baseline:${normalizeAgentShardId(orgId)}`,
    ).getBaselineCopy(input);
  }
  beginBaselineCopy(orgId: string, input: Omit<BaselineCopyCheckpoint, 'jobId' | 'complete'>) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      `baseline:${normalizeAgentShardId(orgId)}`,
    ).beginBaselineCopy(input);
  }
  confirmBaselineCopy(
    orgId: string,
    input: { category: BaselineCopyCheckpoint['category']; jobId: string; complete: boolean },
  ) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      `baseline:${normalizeAgentShardId(orgId)}`,
    ).confirmBaselineCopy(input);
  }

  inspectGlobalIngestionMigration() {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      'migration:bounded-agent-ingestion-v1',
    ).getIngestionMigrationState();
  }

  async completeGlobalIngestionMigration(_shardId: string, input: { proofSha256: string }) {
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      'migration:bounded-agent-ingestion-v1',
    );
    await coordinator.seedIngestionMigration({ proofSha256: input.proofSha256, dirtyDays: [] });
    return coordinator.completeIngestionMigration(input);
  }

  async inspectIngestionMigration(orgId: string) {
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    return {
      migrationTarget: {
        tinybirdHost: this.env.TINYBIRD_HOST,
        appendTokenSha256: await sha256Hex(this.env.TINYBIRD_TOKEN),
      },
      legacy: await getAgentBatcher(this.env, normalized).getIngestionMigrationState(),
      migration: await coordinator.getIngestionMigrationState(),
      coordinator: await coordinator.getStats({}),
    };
  }

  listFrozenFacts(orgId: string, input: Pick<ListRebuildFactsInput, 'after' | 'limit'>) {
    return getAgentBatcher(this.env, orgId).listFrozenFacts(normalizeAgentShardId(orgId), input);
  }

  inspectFrozenFactSources(orgId: string, input: { facts: FrozenFactIdentity[] }) {
    const normalized = normalizeAgentShardId(orgId);
    return getAgentBatcher(this.env, normalized).inspectFrozenFactSources(normalized, input);
  }

  readFrozenFactSources(orgId: string, input: { facts: FrozenFactSelector[] }) {
    const normalized = normalizeAgentShardId(orgId);
    return getAgentBatcher(this.env, normalized).readFrozenFacts(normalized, input);
  }

  replayFrozenFacts(
    orgId: string,
    input: ReplayFrozenFactsInput,
  ): Promise<FrozenFactReplayConfirmation> {
    const normalized = normalizeAgentShardId(orgId);
    return replayFrozenFactSelection(
      this.env,
      normalized,
      input,
      getAgentBatcher(this.env, normalized),
    );
  }

  retireFrozenLedger(orgId: string, input: LegacyRetirementProof) {
    const normalized = normalizeAgentShardId(orgId);
    return getAgentBatcher(this.env, normalized).retireFrozenLedger(normalized, input);
  }

  reconcileFrozenRepairs(orgId: string, input: ReconcileFrozenRepairsInput) {
    const normalized = normalizeAgentShardId(orgId);
    return getAgentBatcher(this.env, normalized).reconcileFrozenRepairs(normalized, input);
  }

  freezeIngestionMigration(orgId: string, input: { migrationId: string }) {
    return getAgentBatcher(this.env, orgId).freezeIngestionMigration(input.migrationId);
  }

  async seedIngestionMigration(orgId: string, input: { proofSha256: string; dirtyDays: string[] }) {
    const normalized = normalizeAgentShardId(orgId);
    const coordinator = this.env.AGENT_DELIVERY_COORDINATOR.getByName(`org:${normalized}`);
    const result = await coordinator.seedIngestionMigration(input);
    if (input.dirtyDays.length > 0 && !result.complete) {
      await coordinator.scheduleSnapshot({ orgId: normalized });
      await this.env.AGENT_SNAPSHOT_QUEUE.send({ type: 'agent-snapshot', org_id: normalized });
    }
    return result;
  }

  completeIngestionMigration(orgId: string, input: { proofSha256: string }) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      `org:${normalizeAgentShardId(orgId)}`,
    ).completeIngestionMigration(input);
  }

  inspectDeliveryStatus(orgId: string) {
    return this.env.AGENT_DELIVERY_COORDINATOR.getByName(
      `org:${normalizeAgentShardId(orgId)}`,
    ).getStats({});
  }

  listRecovery(shardId: string, options: RecoveryPageOptions = {}): Promise<RecoveryPage> {
    return getAgentBatcher(this.env, shardId).listRecovery(options);
  }

  reconcileRecovery(shardId: string, input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    return getAgentBatcher(this.env, shardId).reconcileRecovery(input);
  }

  inspectFactRepairCapacity(
    shardId: string,
    input: InspectFactRepairCapacityInput,
  ): Promise<InspectFactRepairCapacityResult> {
    const orgId = normalizeAgentShardId(shardId);
    return getAgentBatcher(this.env, orgId).inspectFactRepairCapacity(orgId, input);
  }

  compactFactRepairDuplicates(
    shardId: string,
    input: CompactFactRepairDuplicatesInput,
  ): Promise<CompactFactRepairDuplicatesResult> {
    const orgId = normalizeAgentShardId(shardId);
    return getAgentBatcher(this.env, orgId).compactFactRepairDuplicates(orgId, input);
  }

  quiesceFactRepairCapacity(
    shardId: string,
    input: QuiesceFactRepairCapacityInput,
  ): Promise<QuiesceFactRepairCapacityResult> {
    const orgId = normalizeAgentShardId(shardId);
    return getAgentBatcher(this.env, orgId).quiesceFactRepairCapacity(input);
  }

  beginFactRebuild(shardId: string, input: BeginFactRebuildInput): Promise<BeginFactRebuildResult> {
    const orgId = normalizeAgentShardId(shardId);
    return getAgentBatcher(this.env, orgId).beginFactRebuild(orgId, input);
  }

  listRebuildFacts(shardId: string, input: ListRebuildFactsInput): Promise<ListRebuildFactsResult> {
    return getAgentBatcher(this.env, shardId).listRebuildFacts(input);
  }

  completeFactRebuild(
    shardId: string,
    input: CompleteFactRebuildInput,
  ): Promise<CompleteFactRebuildResult> {
    return getAgentBatcher(this.env, shardId).completeFactRebuild(input);
  }

  async replayDlq(shardId: string, input: AgentReplayDlqInput): Promise<RecoveryRecord> {
    const reason = requireRecoveryReason(input.reason);
    const repair = validateExcerptRepair(input.repair);
    const batcher = getAgentBatcher(this.env, shardId);
    await batcher.assertFactMaintenanceUnlocked();
    const record = await batcher.getRecovery(input.recoveryId);
    if (record.kind !== 'dlq' || record.state !== 'blocked')
      throw new Error('DLQ record is not blocked');
    if (repair && (await sha256Hex(record.payload)) !== repair.expectedPayloadSha256) {
      throw new Error('DLQ payload hash does not match the repair request');
    }
    const value: unknown = JSON.parse(record.payload);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid DLQ payload');
    const payload = value as Record<string, unknown>;
    if (!repair) {
      await replayAgentDlqPayload(payload.body, this.env);
      return batcher.resolveDlq(input.recoveryId, reason);
    }

    const bodyOrgId = dlqBodyOrgId(payload.body);
    if (bodyOrgId !== repair.expectedOrgId)
      throw new Error('DLQ payload org does not match repair');
    const normalized = normalizeDlqExcerptByteLimits(payload.body);
    const originalBodySha256 = await sha256Hex(JSON.stringify(payload.body));
    const correctedBodySha256 = await sha256Hex(JSON.stringify(normalized.body));
    await replayAgentDlqPayload(normalized.body, this.env);
    return batcher.resolveDlq(
      input.recoveryId,
      JSON.stringify({
        reason,
        repair: {
          kind: repair.kind,
          expectedOrgId: repair.expectedOrgId,
          originalPayloadSha256: repair.expectedPayloadSha256,
          originalBodySha256,
          correctedBodySha256,
        },
      }),
    );
  }
}

function validateExcerptRepair(value: unknown): ExcerptByteLimitRepair | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid DLQ repair request');
  }
  const repair = value as Record<string, unknown>;
  const expectedKeys = ['expectedOrgId', 'expectedPayloadSha256', 'kind'];
  if (
    Object.keys(repair).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(repair, key)) ||
    repair.kind !== 'excerpt-byte-limits' ||
    typeof repair.expectedPayloadSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(repair.expectedPayloadSha256) ||
    typeof repair.expectedOrgId !== 'string'
  ) {
    throw new Error('invalid DLQ repair request');
  }
  if (normalizeAgentShardId(repair.expectedOrgId) !== repair.expectedOrgId) {
    throw new Error('invalid DLQ repair request');
  }
  return {
    kind: repair.kind,
    expectedPayloadSha256: repair.expectedPayloadSha256,
    expectedOrgId: repair.expectedOrgId,
  };
}

function dlqBodyOrgId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid DLQ payload body');
  }
  const tenancy = (value as Record<string, unknown>).tenancy;
  if (!tenancy || typeof tenancy !== 'object' || Array.isArray(tenancy)) {
    throw new Error('invalid DLQ payload tenancy');
  }
  const orgId = (tenancy as Record<string, unknown>).org_id;
  if (typeof orgId !== 'string') throw new Error('invalid DLQ payload org');
  return orgId;
}

export default Sentry.withSentry(
  (env: AgentConsumerEnv) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    enableRpcTracePropagation: true,
  }),
  handler,
);
