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
import type { AgentConsumerEnv } from './context';
import { isQueueMessage, processAgentBatch, processAgentRecoveryPayload } from './consumer';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AgentFactBatcherInstance } from './fact-batcher';
import type {
  ReconcileRecoveryInput,
  RecoveryPage,
  RecoveryPageOptions,
  RecoveryRecord,
  ReplayDlqInput,
} from '@trace-flow/tinybird-client';
import { requireRecoveryReason } from '@trace-flow/tinybird-client';

export { processAgentBatch } from './consumer';
export { AgentFactBatcher } from './fact-batcher';

const AGENT_DLQ_NAMES = new Set(['agent-ingest-dlq-dev', 'agent-ingest-dlq-prod']);

function getAgentBatcher(
  env: AgentConsumerEnv,
  shardId: string,
): DurableObjectStub<AgentFactBatcherInstance> {
  const normalized = shardId.trim();
  if (!normalized || normalized.length > 256 || normalized.includes(':')) {
    throw new Error('agent shardId must be a non-empty org ID without a colon');
  }
  return env.AGENT_FACT_BATCHER.getByName(`org:${normalized}`);
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
    } catch {
      message.retry();
      Sentry.captureMessage('agent_consumer.dead_letter_preservation_failed', {
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

  async replayDlq(shardId: string, input: ReplayDlqInput): Promise<RecoveryRecord> {
    requireRecoveryReason(input.reason);
    const batcher = getAgentBatcher(this.env, shardId);
    const record = await batcher.getRecovery(input.recoveryId);
    if (record.kind !== 'dlq' || record.state !== 'blocked')
      throw new Error('DLQ record is not blocked');
    const value: unknown = JSON.parse(record.payload);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid DLQ payload');
    const payload = value as Record<string, unknown>;
    await processAgentRecoveryPayload(payload.body, this.env);
    return batcher.resolveDlq(input.recoveryId, input.reason);
  }
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
