import * as Sentry from '@sentry/cloudflare';
import type {
  QueueMessageUnion,
  TinybirdTrace,
  QueueMessage,
  TraceDeliveryPayload,
} from '@trace-flow/types';
import {
  completeTraceDelivery,
  isTraceDeliveryMessage,
  loadTraceDelivery,
  normalizeAnalyticsKey,
} from '@trace-flow/utils';
import {
  TRACE_FLOW_PROPAGATION_TARGETS,
  continueQueueTrace,
  groupBySentryTrace,
} from '@trace-flow/utils/sentry-tracing';
import { axiomConfigFromEnv, createLogger } from '@trace-flow/logging';
import {
  TraceBatcher,
  TRACE_BATCHER_BATCH_SIZE,
  type TraceBatcherInstance,
  type TraceBatcherStats,
} from './batcher';
import { buildSpans } from './spans';
import { calculateShardId } from './sharding';
import { getPricing, type ModelPricing } from '@trace-flow/pricing';
import { fetchOpenRouterPricing } from './openrouter-pricing';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  ReconcileRecoveryInput,
  RecoveryPage,
  RecoveryPageOptions,
  RecoveryRecord,
  ReplayDlqInput,
} from '@trace-flow/tinybird-client';
import { requireRecoveryReason } from '@trace-flow/tinybird-client';

const DEFAULT_NUM_SHARDS = 10;
const TRACE_BATCHER_STALE_BACKLOG_THRESHOLD_MS = 10 * 60 * 1000;

type TraceBatcherHealthStatus =
  | 'healthy'
  | 'high_queue_depth'
  | 'stale_backlog'
  | 'high_queue_depth_and_stale_backlog'
  | 'blocked_recovery'
  | 'queue_and_recovery_unhealthy'
  | 'stats_unavailable';

interface TraceBatcherHealthSnapshot {
  shardId: number;
  status: TraceBatcherHealthStatus;
  queuedTraces: number;
  blockedRecoveryRows: number;
  blockedRecoveryRecords: number;
  backlogAgeMs: number;
  lastSuccessfulFlushAgeMs: number;
  unhealthy: boolean;
}

export { TraceBatcher };

export interface Env {
  STORAGE: R2Bucket;
  TINYBIRD_TOKEN: string;
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_LEGACY_DATASOURCE?: string;
  TINYBIRD_TRACE_WRITE_MODE?: string;
  TINYBIRD_HOST?: string;
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcherInstance>;
  NUM_SHARDS?: number;
  MODEL_PRICING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  AXIOM_TOKEN?: string;
  AXIOM_DATASET?: string;
  AXIOM_DOMAIN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
}

function getNumShards(env: Env): number {
  return env.NUM_SHARDS ?? DEFAULT_NUM_SHARDS;
}

function getTraceBatcher(env: Env, shardId: number): DurableObjectStub<TraceBatcherInstance> {
  const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
  return env.TRACE_BATCHER.get(batcherId);
}

function evaluateTraceBatcherHealth(
  shardId: number,
  stats: TraceBatcherStats,
  now: number,
): TraceBatcherHealthSnapshot {
  const backlogAgeMs =
    stats.oldestQueuedTraceTime === null ? 0 : Math.max(0, now - stats.oldestQueuedTraceTime);
  const lastSuccessfulFlushAgeMs = Math.max(0, now - stats.lastSuccessfulFlushTime);
  const queueDepthExceeded = stats.queuedTraces >= TRACE_BATCHER_BATCH_SIZE;
  const staleBacklog =
    stats.queuedTraces > 0 && backlogAgeMs >= TRACE_BATCHER_STALE_BACKLOG_THRESHOLD_MS;

  let status: TraceBatcherHealthStatus = 'healthy';
  if (queueDepthExceeded && staleBacklog) {
    status = 'high_queue_depth_and_stale_backlog';
  } else if (queueDepthExceeded) {
    status = 'high_queue_depth';
  } else if (staleBacklog) {
    status = 'stale_backlog';
  }
  if (stats.blockedRecoveryRecords > 0) {
    status = status === 'healthy' ? 'blocked_recovery' : 'queue_and_recovery_unhealthy';
  }

  return {
    shardId,
    status,
    queuedTraces: stats.queuedTraces,
    blockedRecoveryRows: stats.blockedRecoveryRows,
    blockedRecoveryRecords: stats.blockedRecoveryRecords,
    backlogAgeMs,
    lastSuccessfulFlushAgeMs,
    unhealthy: status !== 'healthy',
  };
}

function createStatsUnavailableSnapshot(shardId: number): TraceBatcherHealthSnapshot {
  return {
    shardId,
    status: 'stats_unavailable',
    queuedTraces: 0,
    blockedRecoveryRows: -1,
    blockedRecoveryRecords: -1,
    backlogAgeMs: -1,
    lastSuccessfulFlushAgeMs: -1,
    unhealthy: true,
  };
}

function writeTraceBatcherHealthMetric(
  env: Env,
  snapshot: TraceBatcherHealthSnapshot,
  logger: ReturnType<typeof createLogger>,
): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [`shard-${snapshot.shardId}`],
      blobs: ['trace_batcher_health', snapshot.status],
      doubles: [
        snapshot.queuedTraces,
        snapshot.blockedRecoveryRows,
        snapshot.blockedRecoveryRecords,
        snapshot.backlogAgeMs,
        snapshot.lastSuccessfulFlushAgeMs,
        snapshot.unhealthy ? 1 : 0,
      ],
    });
  } catch (error) {
    logger.error('consumer.trace_batcher_health_metric_failed', error, {
      shardId: snapshot.shardId,
      status: snapshot.status,
    });
  }
}

async function getPricingForMessage(
  data: QueueMessage,
  kv: KVNamespace,
): Promise<ModelPricing | null> {
  const provider = data.request.provider;
  const model = data.responseMetadata?.model ?? data.request.model;

  // Try KV first (exact match or prefix without date suffix)
  const pricing = await getPricing(kv, provider, model);
  if (pricing) return pricing;

  // For OpenRouter, the model ID is already in OpenRouter format
  if (provider === 'openrouter') {
    return fetchOpenRouterPricing(model, kv);
  }

  // Fallback: fetch pricing from OpenRouter for any provider.
  // OpenRouter model IDs are "{provider}/{model}" (e.g., "google/gemini-2.5-pro").
  // Cache under the original provider key so future KV lookups hit directly.
  const cacheKey = `pricing:${provider}:${model}`;
  return fetchOpenRouterPricing(`${provider}/${model}`, kv, cacheKey);
}

interface ResolvedQueueItem {
  payload: TraceDeliveryPayload;
  messageId: string;
  deliveryKey?: string;
}

async function resolveQueueItem(
  body: QueueMessageUnion,
  queueMessageId: string,
  env: Env,
): Promise<ResolvedQueueItem | null> {
  if (!isTraceDeliveryMessage(body)) {
    return {
      payload: body,
      messageId: body.type === 'otlp' ? `otlp:${queueMessageId}` : `llm:${body.requestId}`,
    };
  }

  const envelope = await loadTraceDelivery(env.STORAGE, body.key);
  if (!envelope) return null;
  if (envelope.body) {
    await env.STORAGE.put(envelope.body.key, JSON.stringify(envelope.body.encryptedPayload), {
      customMetadata: { orgId: envelope.body.orgId },
    });
  }
  return {
    payload: envelope.message,
    messageId:
      envelope.message.type === 'otlp' ? `otlp:${body.key}` : `llm:${envelope.message.requestId}`,
    deliveryKey: body.key,
  };
}

function isTracePayload(value: unknown): value is TraceDeliveryPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'otlp')
    return typeof record.apiKey === 'string' && Array.isArray(record.traces);
  return (
    (record.type === undefined || record.type === 'llm') &&
    typeof record.requestId === 'string' &&
    typeof record.apiKey === 'string' &&
    typeof record.request === 'object' &&
    record.request !== null &&
    typeof record.response === 'object' &&
    record.response !== null &&
    typeof record.timing === 'object' &&
    record.timing !== null
  );
}

function isQueueMessageUnion(value: unknown): value is QueueMessageUnion {
  return isTraceDeliveryMessage(value) || isTracePayload(value);
}

async function buildDeliveryTraces(
  payload: TraceDeliveryPayload,
  env: Env,
): Promise<TinybirdTrace[]> {
  const apiKey = await normalizeAnalyticsKey(payload.apiKey);
  if (payload.type === 'otlp') {
    return payload.traces.map((trace) => ({ ...trace, ApiKey: apiKey }));
  }
  return buildSpans({ ...payload, apiKey }, await getPricingForMessage(payload, env.MODEL_PRICING));
}

async function stageSingleQueueBody(
  body: QueueMessageUnion,
  messageId: string,
  env: Env,
): Promise<void> {
  const resolved = await resolveQueueItem(body, messageId, env);
  if (!resolved) return;
  const traces = await buildDeliveryTraces(resolved.payload, env);
  const result = await getTraceBatcher(
    env,
    calculateShardId(resolved.payload.apiKey, getNumShards(env)),
  ).addMessageTraces([{ messageId: resolved.messageId, traces }]);
  if (result[0]?.status === 'failed') throw new Error('trace batcher rejected replay');
  if (resolved.deliveryKey) await completeTraceDelivery(env.STORAGE, resolved.deliveryKey);
}

const PROXY_DLQ_NAMES = new Set([
  'trace-flow-requests-dlq-dev',
  'trace-flow-requests-dlq-prod',
  'trace-flow-requests-dlq-preview',
]);

async function preserveDeadLetterBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = message.body;
      const shardKey = isTracePayload(body)
        ? body.apiKey
        : isTraceDeliveryMessage(body)
          ? body.key
          : message.id;
      const shardId = calculateShardId(shardKey, getNumShards(env));
      await getTraceBatcher(env, shardId).preserveDlq(
        JSON.stringify({ queue: batch.queue, messageId: message.id, body }),
        JSON.stringify({ reason: 'dead_letter_queue_delivery' }),
        isTraceDeliveryMessage(body) ? body.key : message.id,
      );
      message.ack();
      Sentry.captureMessage('consumer.dead_letter_preserved', {
        level: 'error',
        tags: { operation: 'dlq_preserve' },
        extra: { shardId, messageId: message.id },
      });
    } catch {
      message.retry();
      Sentry.captureMessage('consumer.dead_letter_preservation_failed', {
        level: 'fatal',
        tags: { operation: 'dlq_preserve' },
        extra: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
      });
    }
  }
}

async function processQueueBatch(batch: MessageBatch<QueueMessageUnion>, env: Env): Promise<void> {
  const numShards = getNumShards(env);
  const logger = createLogger({
    service: 'proxy-consumer',
    runtime: 'cloudflare-worker',
    axiom: axiomConfigFromEnv(env),
    context: {
      component: 'queue-consumer',
    },
  });

  const shardedMessages = new Map<
    number,
    {
      items: {
        messageId: string;
        traces: TinybirdTrace[];
        message: Message<QueueMessageUnion>;
        deliveryKey?: string;
      }[];
    }
  >();

  const failedMessages: Message<QueueMessageUnion>[] = [];

  const processMessage = async (message: Message<QueueMessageUnion>): Promise<void> => {
    try {
      const resolved = await resolveQueueItem(message.body, message.id, env);
      if (!resolved) {
        message.ack();
        return;
      }
      const traces = await buildDeliveryTraces(resolved.payload, env);
      // Keep pre-cutover queue retries on the shard that owns their message ledger.
      const shardId = calculateShardId(resolved.payload.apiKey, numShards);

      if (!shardedMessages.has(shardId)) {
        shardedMessages.set(shardId, { items: [] });
      }

      const shard = shardedMessages.get(shardId)!;
      shard.items.push({
        messageId: resolved.messageId,
        traces,
        message,
        deliveryKey: resolved.deliveryKey,
      });
    } catch (error) {
      logger.error('consumer.message_process_failed', error, { messageId: message.id });
      failedMessages.push(message);
    }
  };

  try {
    // One `queue.process` transaction per producing request, continuing the Proxy's trace, so the
    // pricing + span-building work shows up under the LLM request that captured it. The Durable
    // Object flush below is genuinely batch-level and stays under this batch's own transaction.
    for (const group of groupBySentryTrace(batch.messages, (m) => m.body.sentry_trace_context)) {
      await continueQueueTrace(
        group.traceContext,
        { queueName: batch.queue, messageCount: group.messages.length },
        async () => {
          for (const message of group.messages) {
            await processMessage(message);
          }
        },
      );
    }

    const shardPromises = Array.from(shardedMessages.entries()).map(async ([shardId, shard]) => {
      try {
        const batcher = getTraceBatcher(env, shardId);

        const results = await batcher.addMessageTraces(
          shard.items.map((item) => ({ messageId: item.messageId, traces: item.traces })),
        );
        const statusById = new Map(results.map((result) => [result.messageId, result.status]));

        for (const item of shard.items) {
          const status = statusById.get(item.messageId) ?? 'failed';
          if (status === 'failed') {
            item.message.retry();
          } else {
            if (item.deliveryKey) await completeTraceDelivery(env.STORAGE, item.deliveryKey);
            item.message.ack();
          }
        }
      } catch (error) {
        logger
          .child({ component: 'queue-consumer', operation: 'batch_to_do_shard' })
          .error('consumer.shard_flush_failed', error, {
            shardId,
          });
        // Note: Errors in the TraceBatcher Durable Object are captured by Sentry there

        for (const item of shard.items) {
          item.message.retry();
        }
      }
    });

    await Promise.all(shardPromises);

    for (const message of failedMessages) {
      message.retry();
    }

    logger.info('consumer.batch_processed', {
      batchSize: batch.messages.length,
      failedCount: failedMessages.length,
      shardCount: shardedMessages.size,
    });
  } finally {
    await logger.flush();
  }
}

export async function runTraceBatcherHealthCheck(
  env: Env,
  cron: string,
): Promise<{ checkedShards: number; unhealthyShards: number }> {
  const logger = createLogger({
    service: 'proxy-consumer',
    runtime: 'cloudflare-worker',
    axiom: axiomConfigFromEnv(env),
    context: {
      component: 'trace-batcher-health-check',
    },
  });

  try {
    const now = Date.now();
    const environment = env.SENTRY_ENVIRONMENT ?? 'development';
    const shardIds = Array.from({ length: getNumShards(env) }, (_, index) => index);

    const snapshots = await Promise.all(
      shardIds.map(async (shardId) => {
        try {
          const stats = await getTraceBatcher(env, shardId).getStats();
          const snapshot = evaluateTraceBatcherHealth(shardId, stats, now);
          writeTraceBatcherHealthMetric(env, snapshot, logger);

          if (snapshot.unhealthy) {
            logger.warn('consumer.trace_batcher_unhealthy', {
              shardId,
              status: snapshot.status,
              queuedTraces: snapshot.queuedTraces,
              blockedRecoveryRows: snapshot.blockedRecoveryRows,
              blockedRecoveryRecords: snapshot.blockedRecoveryRecords,
              backlogAgeMs: snapshot.backlogAgeMs,
              lastSuccessfulFlushAgeMs: snapshot.lastSuccessfulFlushAgeMs,
              cron,
              environment,
            });

            // Auto-recovery: if the shard has queued traces, kick a flush.
            // The DO's own alarm-reschedule handles the steady state, but a
            // shard that already wedged (e.g. before the chunking fix) needs
            // an external poke since no new alarms will fire on its own.
            if (snapshot.queuedTraces > 0) {
              try {
                const result = await getTraceBatcher(env, shardId).forceFlush();
                logger.info('consumer.trace_batcher_force_flush', {
                  shardId,
                  before: result.before,
                  after: result.after,
                  cron,
                  environment,
                });
              } catch (error) {
                logger.error('consumer.trace_batcher_force_flush_failed', error, {
                  shardId,
                  cron,
                  environment,
                });
              }
            }
          }

          return snapshot;
        } catch (error) {
          const snapshot = createStatsUnavailableSnapshot(shardId);
          writeTraceBatcherHealthMetric(env, snapshot, logger);
          logger.error('consumer.trace_batcher_health_check_failed', error, {
            shardId,
            cron,
            environment,
          });
          return snapshot;
        }
      }),
    );

    const unhealthyShards = snapshots.filter((snapshot) => snapshot.unhealthy).length;
    logger.info('consumer.trace_batcher_health_check_complete', {
      checkedShards: snapshots.length,
      unhealthyShards,
      cron,
      environment,
    });

    return { checkedShards: snapshots.length, unhealthyShards };
  } finally {
    await logger.flush();
  }
}

// The `_ctx` parameters are unused here but declared so the type mirrors the deployed call:
// `withSentry` flushes spans through `ctx.waitUntil`, and throws if a caller omits it.
const handler = {
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (PROXY_DLQ_NAMES.has(batch.queue)) {
      await preserveDeadLetterBatch(batch, env);
      return;
    }
    const messages: Message<QueueMessageUnion>[] = [];
    for (const message of batch.messages) {
      if (!isQueueMessageUnion(message.body)) {
        message.retry();
        continue;
      }
      messages.push(message as Message<QueueMessageUnion>);
    }
    await processQueueBatch({ ...batch, messages }, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runTraceBatcherHealthCheck(env, controller.cron);
  },
};

export class TraceRecovery extends WorkerEntrypoint<Env> {
  private batcher(shardId: string): DurableObjectStub<TraceBatcherInstance> {
    if (!/^\d+$/.test(shardId)) throw new Error('proxy shardId must be a decimal integer');
    const value = Number(shardId);
    if (!Number.isSafeInteger(value) || value < 0 || value >= getNumShards(this.env)) {
      throw new Error('proxy shardId is outside the configured range');
    }
    return getTraceBatcher(this.env, value);
  }

  listRecovery(shardId: string, options: RecoveryPageOptions = {}): Promise<RecoveryPage> {
    return this.batcher(shardId).listRecovery(options);
  }

  reconcileRecovery(shardId: string, input: ReconcileRecoveryInput): Promise<RecoveryRecord> {
    return this.batcher(shardId).reconcileRecovery(input);
  }

  async replayDlq(shardId: string, input: ReplayDlqInput): Promise<RecoveryRecord> {
    requireRecoveryReason(input.reason);
    const batcher = this.batcher(shardId);
    const record = await batcher.getRecovery(input.recoveryId);
    if (record.kind !== 'dlq' || record.state !== 'blocked')
      throw new Error('DLQ record is not blocked');
    const value: unknown = JSON.parse(record.payload);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid DLQ payload');
    const payload = value as Record<string, unknown>;
    if (typeof payload.messageId !== 'string' || !isQueueMessageUnion(payload.body)) {
      throw new Error('DLQ payload still fails the queue contract');
    }
    await stageSingleQueueBody(payload.body, payload.messageId, this.env);
    return batcher.resolveDlq(input.recoveryId, input.reason);
  }
}

/**
 * `withSentry` instruments both the `queue` and `scheduled` handlers and initializes the client per
 * invocation. It also proxies `env`, which is what makes the `TRACE_BATCHER` stub propagate the trace
 * into the Durable Object. `enableRpcTracePropagation` must match the value the DO itself is
 * instrumented with, because the stub appends a trailing metadata argument that only an
 * RPC-instrumented DO strips back off.
 */
export default Sentry.withSentry<Env, unknown, unknown, typeof handler>(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    tracesSampleRate: 1.0,
    tracePropagationTargets: TRACE_FLOW_PROPAGATION_TARGETS,
    enableRpcTracePropagation: true,
  }),
  handler,
);
