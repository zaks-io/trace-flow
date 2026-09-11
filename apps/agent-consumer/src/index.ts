/**
 * Agent ingest queue consumer. Drains AGENT_QUEUE, prices each Agent Message via the shared
 * `@trace-flow/pricing` catalog (one KV read per distinct `(provider, model)` per batch), and hands
 * clean fact rows to AGENT_FACT_BATCHER. The Durable Object owns cross-delivery dedupe and Tinybird
 * insert batching. See `docs/adr/0012-agent-conversation-analytics.md` → "Transport".
 *
 * `processAgentBatch` is exported for in-process tests (drive it with stub messages + a fetch mock,
 * the only way to deterministically assert the ack / retry / DLQ paths). The default export wraps the
 * queue handler in Sentry for the deployed Worker; `withSentry` instruments the `queue` method and
 * initializes the client per invocation, so the manual `Sentry.captureException` / `captureMessage`
 * calls inside `processAgentBatch` report (the batch loop catches per-message and insert errors to
 * retry them rather than letting them escape, so they would otherwise never reach Sentry).
 */
import * as Sentry from '@sentry/cloudflare';
import { TRACE_FLOW_PROPAGATION_TARGETS } from '@trace-flow/utils/sentry-tracing';
import { sha256Hex } from '@trace-flow/utils';
import type { AgentConsumerEnv } from './context';
import { isQueueMessage, processAgentBatch, processAgentRecoveryPayload } from './consumer';
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
import type {
  CompactFactRepairDuplicatesInput,
  CompactFactRepairDuplicatesResult,
  InspectFactRepairCapacityInput,
  InspectFactRepairCapacityResult,
} from './fact-repair-capacity';

export { processAgentBatch } from './consumer';
export { AgentFactBatcher } from './fact-batcher';

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
      const shardId = isQueueMessage(message.body) ? message.body.tenancy.org_id : '__dlq__';
      await getAgentBatcher(env, shardId).preserveDlq(
        JSON.stringify({ queue: batch.queue, messageId: message.id, body: message.body }),
        JSON.stringify({ reason: 'dead_letter_queue_delivery' }),
        message.id,
      );
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

const handler = {
  // The queue delivers untrusted bytes; `processAgentBatch` validates each body structurally and
  // dead-letters anything off-contract, so the handler accepts `unknown` rather than asserting shape.
  async queue(batch: MessageBatch<unknown>, env: AgentConsumerEnv): Promise<void> {
    if (AGENT_DLQ_NAMES.has(batch.queue)) {
      await preserveDeadLetterBatch(batch, env);
      return;
    }
    await processAgentBatch(batch, env);
  },
};

export class TraceRecovery extends WorkerEntrypoint<AgentConsumerEnv> {
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
      await processAgentRecoveryPayload(payload.body, this.env);
      return batcher.resolveDlq(input.recoveryId, reason);
    }

    const bodyOrgId = dlqBodyOrgId(payload.body);
    if (bodyOrgId !== repair.expectedOrgId)
      throw new Error('DLQ payload org does not match repair');
    const normalized = normalizeDlqExcerptByteLimits(payload.body);
    const originalBodySha256 = await sha256Hex(JSON.stringify(payload.body));
    const correctedBodySha256 = await sha256Hex(JSON.stringify(normalized.body));
    await processAgentRecoveryPayload(normalized.body, this.env);
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
