import type { QueueMessageUnion, TinybirdTrace, QueueMessage } from '@trace-flow/types';
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

const DEFAULT_NUM_SHARDS = 10;
const TRACE_BATCHER_STALE_BACKLOG_THRESHOLD_MS = 10 * 60 * 1000;

type TraceBatcherHealthStatus =
  | 'healthy'
  | 'high_queue_depth'
  | 'stale_backlog'
  | 'high_queue_depth_and_stale_backlog'
  | 'stats_unavailable';

interface TraceBatcherHealthSnapshot {
  shardId: number;
  status: TraceBatcherHealthStatus;
  queuedTraces: number;
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

  return {
    shardId,
    status,
    queuedTraces: stats.queuedTraces,
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
      }[];
    }
  >();

  const failedMessages: Message<QueueMessageUnion>[] = [];

  try {
    for (const message of batch.messages) {
      try {
        let traces: TinybirdTrace[];
        let apiKey: string;
        let messageId: string;

        if (message.body.type === 'otlp') {
          traces = message.body.traces;
          apiKey = message.body.apiKey;
          messageId = `otlp:${apiKey}:${message.body.receivedAt}:${traces.length}`;
        } else {
          const pricing = await getPricingForMessage(message.body, env.MODEL_PRICING);
          traces = buildSpans(message.body, pricing);
          apiKey = message.body.apiKey;
          messageId = `llm:${message.body.requestId}`;
        }

        const shardId = calculateShardId(apiKey, numShards);

        if (!shardedMessages.has(shardId)) {
          shardedMessages.set(shardId, { items: [] });
        }

        const shard = shardedMessages.get(shardId)!;
        shard.items.push({ messageId, traces, message });
      } catch (error) {
        const requestId = message.body.type === 'otlp' ? undefined : message.body.requestId;
        const messageId =
          message.body.type === 'otlp' ? `otlp:${message.body.receivedAt}` : requestId;
        const orgId = message.body.type === 'otlp' ? undefined : message.body.orgId;
        const traceId =
          message.body.type === 'otlp' ? message.body.traces[0]?.TraceId : message.body.traceId;
        logger
          .child({ traceId, requestId, orgId })
          .error('consumer.message_process_failed', error, {
            messageId,
            orgId,
          });
        failedMessages.push(message);
      }
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

async function runTraceBatcherHealthCheck(
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

export default {
  async queue(batch: MessageBatch<QueueMessageUnion>, env: Env): Promise<void> {
    // Note: @sentry/cloudflare doesn't have init() for queue handlers.
    // Errors are captured via Sentry.captureException() in processQueueBatch.
    // The TraceBatcher Durable Object is fully instrumented with Sentry.
    await processQueueBatch(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runTraceBatcherHealthCheck(env, controller.cron);
  },
};
