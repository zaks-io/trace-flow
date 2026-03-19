import type { QueueMessageUnion, TinybirdTrace, QueueMessage } from '@trace-flow/types';
import { TraceBatcher, type TraceBatcherInstance } from './batcher';
import { buildTraces } from './traces';
import { calculateShardId } from './sharding';
import { getPricing, type ModelPricing } from './pricing';
import { fetchOpenRouterPricing } from './openrouter-pricing';

export { TraceBatcher };

export interface Env {
  STORAGE: R2Bucket;
  TINYBIRD_TOKEN: string;
  TINYBIRD_DATASOURCE?: string;
  TINYBIRD_HOST?: string;
  TRACE_BATCHER: DurableObjectNamespace<TraceBatcherInstance>;
  NUM_SHARDS?: number;
  MODEL_PRICING: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: { id: string };
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
  const NUM_SHARDS = env.NUM_SHARDS ?? 10;

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
        traces = buildTraces(message.body, pricing);
        apiKey = message.body.apiKey;
        messageId = `llm:${message.body.requestId}`;
      }

      const shardId = calculateShardId(apiKey, NUM_SHARDS);

      if (!shardedMessages.has(shardId)) {
        shardedMessages.set(shardId, { items: [] });
      }

      const shard = shardedMessages.get(shardId)!;
      shard.items.push({ messageId, traces, message });
    } catch (error) {
      const messageId =
        message.body.type === 'otlp' ? `otlp:${message.body.receivedAt}` : message.body.requestId;
      console.error('Failed to process message:', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      failedMessages.push(message);
    }
  }

  const shardPromises = Array.from(shardedMessages.entries()).map(async ([shardId, shard]) => {
    try {
      const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
      const batcher = env.TRACE_BATCHER.get(batcherId);

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
      console.error(`Shard ${shardId}: Failed to add traces to batcher:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Note: Errors in the TraceBatcher Durable Object are captured by Sentry there

      for (const item of shard.items) {
        item.message.retry();
      }
    }
  });

  await Promise.all(shardPromises);

  // Record batcher queue depth for shards active in this batch
  await Promise.all(
    Array.from(shardedMessages.keys()).map(async (shardId) => {
      const batcherId = env.TRACE_BATCHER.idFromName(`batcher-${shardId}`);
      const batcher = env.TRACE_BATCHER.get(batcherId);
      try {
        const stats = await batcher.getStats();
        env.ANALYTICS.writeDataPoint({
          indexes: [`shard-${shardId}`],
          blobs: ['batcher_queue_depth'],
          doubles: [stats.queuedTraces, stats.lastFlushTime],
        });
      } catch (error) {
        console.warn(`Failed to record batcher stats for shard ${shardId}:`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  for (const message of failedMessages) {
    message.retry();
  }
}

export default {
  async queue(batch: MessageBatch<QueueMessageUnion>, env: Env): Promise<void> {
    // Note: @sentry/cloudflare doesn't have init() for queue handlers.
    // Errors are captured via Sentry.captureException() in processQueueBatch.
    // The TraceBatcher Durable Object is fully instrumented with Sentry.
    await processQueueBatch(batch, env);
  },
};
